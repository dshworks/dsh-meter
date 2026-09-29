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
 * And it is not the authority. This compares our copy of the card against the
 * page it was copied from — a copy check. It cannot fail when the page and the
 * card agree and the BILLING is something else, which is the case that costs a
 * user money. `scripts/verify-bill.mjs` spends real tokens and reads the real
 * balance; when the two checks disagree, that one is right. Read them as a
 * pair: this one green and the bill red means the price moved without the
 * documentation moving, and there is no other detector for that.
 *
 * The parsing half is exported and unit-tested against synthetic footnotes
 * (tests/verify-pricing.spec.mjs); only `main()` touches the network, and it
 * runs only when this file is invoked directly.
 *
 * Usage: `node scripts/verify-pricing.mjs`
 * Exit:  0 in sync, 1 drift found, 2 could not read the source.
 */
import { pathToFileURL } from 'node:url'

import { BEIJING_OFFSET_MS, CN_HOLIDAYS_THROUGH, CN_HOLIDAY_PERIODS, PEAK_WINDOWS_UTC, RATES } from '../lib/core.js'

/**
 * Canonical, with the trailing slash. The site is a Tencent COS bucket that
 * answers the slashless form with a 302 to this one; asking for the redirect
 * every day is one more hop that can flap.
 */
export const PAGES = {
  usd: 'https://api-docs.deepseek.com/quick_start/pricing/',
  cny: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
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

/**
 * A model id as the header cell spells it, without the footnote marker.
 *
 * The 2026-09-10 table writes `deepseek-flash(1)` — the `(1)` is a `<sup>`
 * pointing at a footnote, flattened into the cell's text. An exact-match
 * header test read that row as having no models at all.
 */
const MODEL_CELL = /^(deepseek-[a-z0-9][a-z0-9.-]*?)\s*(?:\(\d+\)|\[\d+\])?$/i

/** The cells of every row of one table, as text. */
const rowsOf = table => table.split(/<\/tr>/i)
  .map(row => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell => text(cell[1])))
  .filter(cells => cells.length > 0)

/** The model ids one row names, in column order; empty for any other row. */
const modelsOf = cells => cells.flatMap((cell) => {
  const match = MODEL_CELL.exec(cell)
  return match === null ? [] : [match[1].toLowerCase()]
})

/**
 * The pricing table, found by its SHAPE: a row naming `deepseek-` models and a
 * row opening the pricing section.
 *
 * It used to be found by content — the table that lists every model we price.
 * That is a question about our card, not about the page, and the day DeepSeek
 * renamed `deepseek-v4-flash` to `deepseek-flash` it answered "no table here".
 * `fetchPage` then called a perfectly good page a fallback shell, retried it,
 * and the alarm reported "could not read" for eight days while the prices it
 * exists to watch had been cut. A page that sells models we do not know about
 * is the most important drift there is; it must reach the diff, not die here.
 */
export const pricingTableOf = html => (html.match(/<table[\s\S]*?<\/table>/gi) ?? []).find((table) => {
  const rows = rowsOf(table)
  return rows.some(cells => modelsOf(cells).length > 0)
    && rows.some(cells => cells.some(cell => PRICING_SECTION.test(cell)))
})

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
  const table = pricingTableOf(html)
  if (table === undefined) throw new Error('no table on the page has a pricing section and a row of deepseek- models')

  const rows = rowsOf(table)
  const models = rows.map(modelsOf).find(found => found.length > 0)

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
  const sentence = peakSentenceCn(html)
  const beijing = [...sentence.matchAll(/(\d{1,2}):00/g)].map(match => Number(match[1]))
  const utc = beijing.map(hour => (hour - BEIJING_OFFSET_HOURS + 24) % 24)
  return pairWindows(utc, `"${sentence}" (Beijing, converted at UTC+${BEIJING_OFFSET_HOURS})`)
}

/**
 * The whole peak-hours footnote on the English page, from "Peak hours are"
 * through the sentence that says what is off-peak.
 *
 * The whole footnote, because every rule DeepSeek has added to it arrived as
 * a new clause in this one place: the weekdays after `UTC`, then the holidays
 * both inside the peak sentence and in a new "All other hours" sentence that
 * replaced "(all other hours are off-peak)". A pattern anchored on the old
 * wording stops matching, which is the right failure, but the alarm it raises
 * then says "could not read" instead of what changed.
 */
function peakFootnoteEn(html) {
  const footnote = /Peak hours are ([^]+?off-peak[^.]*)\./i.exec(text(html))
  if (footnote === null) throw new Error('no "Peak hours are ... off-peak" footnote on the page')
  return footnote[1]
}

/**
 * The same on the Chinese page: the one sentence that states the peak hours
 * in Beijing time, in either word order DeepSeek has used —
 * 「高峰时段为北京时间周一至周五 9:00 - 12:00…」 until 2026-09-18, and
 * 「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00…为高峰时段；其余时段…」 since.
 */
function peakSentenceCn(html) {
  const sentence = text(html).split('。').find(part =>
    part.includes('北京时间') && part.includes('高峰时段') && /\d{1,2}:00/.test(part))
  if (sentence === undefined) throw new Error('no Beijing-time peak sentence (北京时间 … 高峰时段) on the page')
  return sentence
}

/**
 * Whether the footnote restricts peak to weekdays, per locale.
 *
 * This is its own check because it is the axis the old parser could not see.
 * `/Peak hours are ([^.]+)UTC/` stopped its capture at `UTC`, and the live
 * sentence puts `, Monday through Friday` immediately after it — so the clause
 * that halves the schedule sat one character outside the capture and the daily
 * run was green while the meter overcharged every weekend by 2x. The Chinese
 * regex did capture 「周一至周五」, but only `(\d{1,2}):00` was ever read out of
 * the match, so the words were discarded there too.
 *
 * The lesson generalises past this one clause: a scraper that extracts only
 * the fields it already models cannot report a new dimension, it can only be
 * silently wrong about it. So this reads the whole footnote sentence and
 * asserts the shape it expects, rather than harvesting numbers out of it.
 *
 * @param {string} html - the English pricing page.
 * @returns {boolean} true when peak is stated as weekdays-only.
 */
export function scrapeWeekdayOnly(html) {
  return /Monday\s+through\s+Friday|Mon\s*[-\u2013]\s*Fri|weekdays/i.test(peakFootnoteEn(html))
}

/** The same, off the Chinese footnote — checked separately, for the reason `scrapeWindowsCn` gives. */
export function scrapeWeekdayOnlyCn(html) {
  return /周一至周五|工作日/.test(peakSentenceCn(html))
}

/**
 * Whether the footnote puts Chinese public holidays off-peak, per locale.
 * The clause that arrived on 2026-09-18/19 with no announcement; the card
 * carries it as `CN_HOLIDAY_PERIODS`.
 * @param {string} html - the English pricing page.
 * @returns {boolean}
 */
export function scrapeHolidaysOffPeak(html) {
  return /public\s+holidays?/i.test(peakFootnoteEn(html))
}

/** The same, off the Chinese footnote. */
export function scrapeHolidaysOffPeakCn(html) {
  return /节假日/.test(peakSentenceCn(html))
}

/**
 * The holiday calendar is a list the State Council extends once a year, late
 * in the year before. Past its last date the meter bills a holiday weekday at
 * peak, so this raises the alarm a month ahead, while there is still time to
 * copy the next notice in.
 * @param {number} nowMs
 * @returns {string|null} the drift line, or null while the calendar has room.
 */
export function holidayCalendarAlarm(nowMs) {
  const horizon = new Date(nowMs + BEIJING_OFFSET_MS + 31 * 86_400_000).toISOString().slice(0, 10)
  if (horizon <= CN_HOLIDAYS_THROUGH) return null
  const next = Number(CN_HOLIDAYS_THROUGH.slice(0, 4)) + 1
  return `the holiday calendar ends **${CN_HOLIDAYS_THROUGH}** — copy ${next}'s from the State Council's 部分节假日安排 notice (gov.cn) into \`CN_HOLIDAY_PERIODS\`, or every ${next} holiday weekday bills at peak`
}

/**
 * Does this page carry the table we came for?
 *
 * The docs bucket intermittently answers a real URL with HTTP 200 and the
 * site's fallback shell — the quick-start index, no pricing table anywhere on
 * it. Our own docs mirror has been recording the same flap on other pages for
 * weeks. A shell is not a page that changed shape; it is a page we did not get.
 *
 * Which is why this must not know which models we price: see `pricingTableOf`.
 */
export const hasPricingTable = html => pricingTableOf(html) !== undefined

/** Attempts, and the pause before each retry. Four reads over ~15s, then give up. */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000]

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Read one page, retrying past a fallback shell.
 *
 * Retries are deliberately narrow: a non-200 and a shell get another go, a
 * page that arrives whole does not. If every attempt is a shell we throw
 * saying so in those words, because "we could not reach DeepSeek" and "the
 * pricing table moved" want different humans and different urgency.
 */
export const fetchPage = async (url) => {
  let last
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1])
    let html
    try {
      const response = await fetch(url, { headers: { accept: 'text/html' }, redirect: 'follow' })
      if (!response.ok) { last = `answered ${response.status}`; continue }
      html = await response.text()
    } catch (error) {
      last = error.message
      continue
    }
    if (hasPricingTable(html)) return html
    last = `served the fallback shell — 200 with no pricing table (${html.length} bytes)`
  }
  throw new Error(`${url} ${last}, on ${RETRY_DELAYS_MS.length + 1} attempts`)
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
      // An unlisted model was already reported once above; six "missing" cells
      // for it would bury the one line that says what happened.
      if (!scraped.models.includes(model)) continue
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

    /* The day axis. The card has held weekdays-only since 2026-08-22; if a
     * page ever drops the clause, peak grows back by 14 hours a week and the
     * meter would undercharge every weekend until someone noticed by hand. */
    const enWeekday = scrapeWeekdayOnly(pages.usd)
    const cnWeekday = scrapeWeekdayOnlyCn(pages.cny)
    if (!enWeekday) drift.push('the English footnote no longer restricts peak to **Monday through Friday** — the card bills weekends off-peak all day and would now be undercharging them')
    if (!cnWeekday) drift.push('the Chinese footnote no longer says **周一至周五** — the card bills weekends off-peak all day and would now be undercharging them')
    if (enWeekday !== cnWeekday) {
      drift.push(`the two pages no longer agree on the day axis: English weekdays-only **${enWeekday}** vs Beijing **${cnWeekday}** — the card holds ONE schedule for both platforms`)
    }
    note(`checked weekday restriction: ${enWeekday ? 'Mon-Fri' : 'ALL DAYS'} (English), ${cnWeekday ? '周一至周五' : '每天'} (Beijing page)`)

    /* The holiday axis, since 2026-09-18/19. Either direction is a wrong
     * bill: a page that drops the clause makes the card undercharge every
     * holiday, and a card without it overcharges them 2x. */
    const cardHolidays = CN_HOLIDAY_PERIODS.length > 0
    const enHoliday = scrapeHolidaysOffPeak(pages.usd)
    const cnHoliday = scrapeHolidaysOffPeakCn(pages.cny)
    for (const [locale, stated] of [['English', enHoliday], ['Chinese', cnHoliday]]) {
      if (stated && !cardHolidays) drift.push(`the ${locale} footnote puts Chinese public holidays off-peak and the card has no holiday calendar — every holiday weekday bills at 2x`)
      if (!stated && cardHolidays) drift.push(`the ${locale} footnote no longer exempts Chinese public holidays — the card bills them off-peak and would now be undercharging them`)
    }
    note(`checked holiday rule: ${enHoliday ? 'off-peak' : 'NOT MENTIONED'} (English), ${cnHoliday ? '法定节假日空闲' : '未提及'} (Beijing page); calendar through ${CN_HOLIDAYS_THROUGH}`)
    const calendar = holidayCalendarAlarm(Date.now())
    if (calendar !== null) drift.push(calendar)
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
