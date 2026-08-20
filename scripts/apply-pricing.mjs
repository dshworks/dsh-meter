#!/usr/bin/env node
/**
 * Rewrite the rate card in `lib/core.js` from DeepSeek's own pricing pages.
 *
 * The alarm (`verify-pricing.mjs`) tells a human that 24 numbers moved. Then
 * the human retypes 24 numbers, which is the step that actually goes wrong —
 * DeepSeek's own integration guide ships a v4-flash cache-read rate that is a
 * 10x decimal slip and a v4-pro block that is a reseller's price list, both
 * hand-typed onto a page people copy from. A card maintained by hand rots; the
 * vendor is the proof.
 *
 * So the machine writes the numbers and a human reviews the diff. This script
 * is the write half:
 *
 *   1. scrape both locales with the SAME parsers the alarm uses
 *   2. splice the scraped values into the PRICING-TABLE block
 *   3. re-run the alarm against the rewritten file
 *
 * Step 3 is the safety property. The output is not trusted because the codegen
 * looks right; it is trusted because an independent read of the rewritten card
 * now agrees with the published pages. A splice that lands a number in the
 * wrong slot fails there, before anything is committed.
 *
 * What it deliberately will NOT do:
 * - merge. Structural invariants (off-peak is half of peak, out > miss > hit)
 *   are satisfied by plenty of wrong cards, so no test can replace the human
 *   who looks at a diff and asks whether these are the prices they'd expect.
 * - invent a `flat` row. The retired card is history and is preserved as-is; a
 *   model that appears upstream without one lands in the PR with red CI, which
 *   is the correct way for "a new model needs a decision" to arrive.
 *
 * Usage: `node scripts/apply-pricing.mjs`        rewrite in place
 *        `node scripts/apply-pricing.mjs --dry`  print the block, write nothing
 * Exit:  0 rewritten (or already current), 1 nothing safe to write, 2 source unreadable.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PEAK_WINDOWS_UTC, RATES, TARIFFS } from '../lib/core.js'
import { PAGES, fetchPage, scrape, scrapeWindows, scrapeWindowsCn } from './verify-pricing.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'lib/core.js')
const dry = process.argv.includes('--dry')

const die = (message, code) => {
  process.stderr.write(`apply-pricing: ${message}\n`)
  process.exit(code)
}

/* ---- read both pages through the alarm's own parsers ---- */

const scraped = {}
let windows
try {
  const pages = {}
  for (const [currency, url] of Object.entries(PAGES)) pages[currency] = await fetchPage(url)
  for (const [currency, html] of Object.entries(pages)) scraped[currency] = scrape(html)
  const en = scrapeWindows(pages.usd)
  const cn = scrapeWindowsCn(pages.cny)
  if (JSON.stringify(en) !== JSON.stringify(cn)) {
    die(`the two pages disagree on the schedule (${JSON.stringify(en)} vs ${JSON.stringify(cn)}) — that needs one schedule per currency, which is a design decision, not a rewrite`, 1)
  }
  windows = en
} catch (error) {
  die(`could not read the source — ${error.message}`, 2)
}

const models = scraped.usd.models
if (JSON.stringify(models) !== JSON.stringify(scraped.cny.models)) {
  die(`the two pages list different models (${models} vs ${scraped.cny.models})`, 1)
}

/* ---- build the replacement literals ---- */

/** Emit a number the way the hand-written card does: no trailing zeros, no exponent. */
const num = (value) => {
  const text = String(value)
  if (text.includes('e') || text.includes('E')) die(`refusing to write ${value} in exponent form`, 1)
  return text
}

const rateLiteral = (rates) => `{ ${['usd', 'cny']
  .map(currency => `${currency}: { hit: ${num(rates[currency].hit)}, miss: ${num(rates[currency].miss)}, out: ${num(rates[currency].out)} }`)
  .join(', ')} }`

const ratesLiteral = `export const RATES = {\n${models.map((model) => {
  const rows = TARIFFS.flatMap((tariff) => {
    if (tariff === 'flat') {
      // History, never scraped. Carried over verbatim, or omitted for a model
      // that never billed under it.
      const held = RATES[model]?.flat
      return held === undefined ? [] : [`    flat: ${rateLiteral(held)},`]
    }
    const byCurrency = Object.fromEntries(['usd', 'cny'].map(currency => [currency, scraped[currency].rates[model][tariff]]))
    return [`    ${tariff}: ${rateLiteral(byCurrency)},`]
  })
  return `  '${model}': {\n${rows.join('\n')}\n  },`
}).join('\n')}\n}`

const windowsLiteral = `export const PEAK_WINDOWS_UTC = [${windows.map(([start, end]) => `[${start}, ${end}]`).join(', ')}]`

/* ---- splice, then let the alarm judge the result ---- */

const source = readFileSync(target, 'utf8')
const spliced = source
  .replace(/^export const PEAK_WINDOWS_UTC = .*$/m, () => windowsLiteral)
  .replace(/^export const RATES = \{[\s\S]*?^\}$/m, () => ratesLiteral)

if (spliced === source) {
  process.stdout.write('apply-pricing: the card already matches both published tables — nothing to write\n')
  process.exit(0)
}
if (!spliced.includes(windowsLiteral) || !spliced.includes(ratesLiteral)) {
  die('the PRICING-TABLE block no longer has the shape this script edits — fix it by hand and adjust the splice', 1)
}

if (dry) {
  process.stdout.write(`${windowsLiteral}\n\n${ratesLiteral}\n`)
  process.exit(0)
}

writeFileSync(target, spliced)

// The safety property: an independent read of the rewritten card must now
// agree with the pages. Anything less and the codegen is just a second place
// for the same typo to live.
const { spawnSync } = await import('node:child_process')
const check = spawnSync(process.execPath, [join(root, 'scripts/verify-pricing.mjs')], { encoding: 'utf8' })
process.stdout.write(check.stdout ?? '')
if (check.status !== 0) {
  writeFileSync(target, source)
  process.stderr.write(check.stderr ?? '')
  die(`the rewritten card still does not match the source (verify exited ${check.status}) — reverted, nothing changed`, 1)
}

process.stdout.write('\napply-pricing: rewrote lib/core.js and re-verified it against both pages.\n')
process.stdout.write('apply-pricing: run `npm run build` to regenerate the bundle, the site and the feed.\n')
