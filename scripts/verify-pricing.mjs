#!/usr/bin/env node
/**
 * Diff the shipped rate card against DeepSeek's own two pricing pages.
 *
 * `lib/core.js` claims to be "verbatim from the published table". Until this
 * script existed that claim was re-established by a human remembering to look,
 * which is how the pre-switchover card survived four days in every third-party
 * price feed on the internet. Now a scheduled job asks the source.
 *
 * Both locales are checked, because USD and CNY are separately published
 * tables that can move independently. So are the peak windows and the model
 * list: a model DeepSeek prices and we do not is drift too — the meter would
 * quietly bill it at zero.
 *
 * This is deliberately NOT part of `npm test`. A unit suite must not fail
 * because a documentation site is slow; a price alarm must not be silent
 * because nobody opened a PR this week. Different jobs, different clocks.
 *
 * The parsing half is exported and unit-tested against synthetic footnotes
 * (tests/verify-pricing.spec.mjs); only `main()` touches the network, and it
 * runs only when this file is invoked directly.
 *
 * Usage: `node scripts/verify-pricing.mjs`
 * Exit:  0 in sync, 1 drift found, 2 could not read the source.
 */
import { pathToFileURL } from 'node:url'

import { PEAK_WINDOWS_UTC, RATES } from '../lib/core.js'

export const PAGES = {
  usd: 'https://api-docs.deepseek.com/quick_start/pricing',
  cny: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
}

/** Bucket labels as the two locales write them. Order matters: "cache miss" also contains "cache". */
const BUCKETS = [
  ['hit', /cache\s*hit|缓存命中/i],
  ['miss', /cache\s*miss|缓存未命中/i],
  ['out', /output\s*tokens?|tokens?\s*输出|百万\s*tokens\s*输出/i],
]

/** Tariff labels likewise. Off-peak first: "off-peak" contains "peak". */
const TARIFF_LABELS = [
  ['offpeak', /off[\s-]*peak|空闲/i],
  ['peak', /peak|高峰/i],
]

/** Where the price table starts. Everything above it (context length, max output) is not money. */
const PRICING_SECTION = /^\s*(pricing|价格)\s*(\(|（|$)/i

const text = (html) => html
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replace(/\s+/g, ' ')
  .trim()

/** A cell holding one number, in either locale's notation: `$0.22`, `1.5元`, `0.05 元`. */
const priceOf = (cell) => {
  const match = /^[$¥￥]?\s*(\d+(?:\.\d+)?)\s*(元|美元)?$/.exec(cell)
  return match === null ? undefined : Number(match[1])
}

/**
 * Pull the rate table out of one rendered pricing page.
 * @param {string} html - the page source.
 * @returns {{models: string[], rates: object}} model order and rates[model][tariff][bucket].
 */
export function scrape(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
  const table = tables.find(candidate => Object.keys(RATES).every(model => candidate.includes(model)))
  if (table === undefined) throw new Error('no table on the page lists every model we price')

  const rows = table.split(/<\/tr>/i)
    .map(row => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell => text(cell[1])))
    .filter(cells => cells.length > 0)

  const header = rows.find(cells => cells.some(cell => cell === Object.keys(RATES)[0]))
  if (header === undefined) throw new Error('no header row names the models')
  const models = header.filter(cell => /^deepseek-/.test(cell))

  const rates = {}
  let inPricing = false
  let bucket
  for (const cells of rows) {
    if (cells.some(cell => PRICING_SECTION.test(cell))) inPricing = true
    if (!inPricing) continue

    const found = cells.find(cell => BUCKETS.some(([, pattern]) => pattern.test(cell)))
    if (found !== undefined) bucket = BUCKETS.find(([, pattern]) => pattern.test(found))[0]
    const tariffCell = cells.find(cell => TARIFF_LABELS.some(([, pattern]) => pattern.test(cell)) && priceOf(cell) === undefined)
    if (bucket === undefined || tariffCell === undefined) continue
    const tariff = TARIFF_LABELS.find(([, pattern]) => pattern.test(tariffCell))[0]

    // Prices are the trailing run of numeric cells, one per model, left to right.
    const prices = []
    for (let index = cells.length - 1; index >= 0; index--) {
      const price = priceOf(cells[index])
      if (price === undefined) break
      prices.unshift(price)
    }
    if (prices.length !== models.length) {
      throw new Error(`row "${cells.join(' | ')}" has ${prices.length} prices for ${models.length} models`)
    }
    models.forEach((model, index) => {
      rates[model] ??= {}
      rates[model][tariff] ??= {}
      rates[model][tariff][bucket] = prices[index]
    })
  }
  return { models, rates }
}

/**
 * Beijing is UTC+8 with no daylight saving — China abolished it in 1991 — so a
 * fixed offset is safe here and no timezone database is needed. That constant
 * offset is the only reason a Beijing-anchored policy can be stored as UTC
 * hours at all; if it ever stopped holding, `PEAK_WINDOWS_UTC` would silently
 * drift twice a year and nothing in the card would notice.
 */
const BEIJING_OFFSET_HOURS = 8

/** Pair a flat list of hours into `[start, end)` windows. */
const pairWindows = (hours, where) => {
  if (hours.length === 0 || hours.length % 2 !== 0) throw new Error(`unpaired peak hours in ${where}`)
  const windows = []
  for (let index = 0; index < hours.length; index += 2) windows.push([hours[index], hours[index + 1]])
  return windows
}

/** The peak windows the English footnote states, as `[start, end)` UTC hour pairs. */
export function scrapeWindows(html) {
  const sentence = /Peak hours are ([^.]+)UTC/i.exec(text(html))
  if (sentence === null) throw new Error('no "Peak hours are ... UTC" sentence on the page')
  return pairWindows([...sentence[1].matchAll(/(\d{1,2}):00/g)].map(match => Number(match[1])), `"${sentence[1]}"`)
}

/**
 * The same windows as the Chinese footnote states them — in Beijing time —
 * converted to UTC.
 *
 * Checked separately and not assumed to agree: DeepSeek already publishes two
 * independent rate cards for the two platforms, so two independent schedules
 * are equally possible. If they ever diverge, the card needs a peak schedule
 * per currency, which is a design change and not a number edit — exactly the
 * kind of thing that should reach a human through an alarm rather than through
 * a support ticket.
 */
export function scrapeWindowsCn(html) {
  const sentence = /高峰时段为北京时间([^。]+)/.exec(text(html))
  if (sentence === null) throw new Error('no "高峰时段为北京时间..." sentence on the page')
  const beijing = [...sentence[1].matchAll(/(\d{1,2}):00/g)].map(match => Number(match[1]))
  const utc = beijing.map(hour => (hour - BEIJING_OFFSET_HOURS + 24) % 24)
  return pairWindows(utc, `"${sentence[1]}" (Beijing, converted at UTC+${BEIJING_OFFSET_HOURS})`)
}

export const fetchPage = async (url) => {
  const response = await fetch(url, { headers: { accept: 'text/html' }, redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return await response.text()
}

/** The network half: fetch both pages, diff them against the card, report. */
async function main() {
  const drift = []
  const note = message => process.stdout.write(`${message}\n`)

  const pages = {}
  for (const [currency, url] of Object.entries(PAGES)) {
    let html
    try {
      html = await fetchPage(url)
    } catch (error) {
      process.stderr.write(`verify-pricing: could not read ${url} — ${error.message}\n`)
      process.exit(2)
    }
    pages[currency] = html

    let scraped
    try {
      scraped = scrape(html)
    } catch (error) {
      // A parse failure is an alert, not a pass: the page changed shape.
      process.stderr.write(`verify-pricing: could not parse ${url} — ${error.message}\n`)
      process.exit(2)
    }

    const priced = Object.keys(RATES)
    for (const model of scraped.models) {
      if (!priced.includes(model)) drift.push(`\`${model}\` is priced upstream but absent from the card (${currency}) — the meter bills it at zero`)
    }
    for (const model of priced) {
      if (!scraped.models.includes(model)) drift.push(`\`${model}\` is on the card but no longer listed upstream (${currency})`)
    }

    for (const [model, byTariff] of Object.entries(RATES)) {
      for (const tariff of ['offpeak', 'peak']) {
        for (const bucket of ['hit', 'miss', 'out']) {
          const ours = byTariff[tariff][currency][bucket]
          const theirs = scraped.rates[model]?.[tariff]?.[bucket]
          if (theirs === undefined) {
            drift.push(`\`${model}\` ${tariff} ${bucket} (${currency}) is missing from the published table`)
          } else if (Math.abs(theirs - ours) > 1e-9) {
            drift.push(`\`${model}\` ${tariff} ${bucket} (${currency}): card says **${ours}**, DeepSeek says **${theirs}**`)
          }
        }
      }
    }
    note(`checked ${currency}: ${scraped.models.length} models, ${url}`)
  }

  try {
    const ours = JSON.stringify(PEAK_WINDOWS_UTC)
    const en = scrapeWindows(pages.usd)
    const cn = scrapeWindowsCn(pages.cny)
    if (JSON.stringify(en) !== ours) drift.push(`peak windows (UTC, English page): card says **${ours}**, DeepSeek says **${JSON.stringify(en)}**`)
    if (JSON.stringify(cn) !== ours) drift.push(`peak windows (Beijing page, converted to UTC): card says **${ours}**, DeepSeek says **${JSON.stringify(cn)}**`)
    if (JSON.stringify(en) !== JSON.stringify(cn)) {
      drift.push(`the two pages no longer agree on the schedule: English **${JSON.stringify(en)}** vs Beijing-converted **${JSON.stringify(cn)}** — the card holds ONE schedule for both platforms and would need one per currency`)
    }
    note(`checked peak windows: ${JSON.stringify(en)} UTC (English), ${JSON.stringify(cn)} UTC (Beijing page, converted)`)
  } catch (error) {
    process.stderr.write(`verify-pricing: could not read the peak windows — ${error.message}\n`)
    process.exit(2)
  }

  if (drift.length === 0) {
    note('\nverify-pricing: the card matches both published tables.')
    process.exit(0)
  }

  process.stdout.write(`\nDeepSeek's published pricing no longer matches \`lib/core.js\`:\n\n${drift.map(line => `- ${line}`).join('\n')}\n\n`)
  process.stdout.write(`Sources: ${Object.values(PAGES).join(' , ')}\n\n`)
  process.stdout.write('Fix the \`PRICING-TABLE\` block in `lib/core.js`, run `npm run build`, and check `tests/tariff.spec.mjs` still holds — it pins invariants (off-peak is half of peak, the cache discount) that a new card can break.\n')
  process.exit(1)
}

// Importing this file for its parsers must not fetch anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
