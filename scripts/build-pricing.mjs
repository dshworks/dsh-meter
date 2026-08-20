#!/usr/bin/env node
/**
 * Compose docs/pricing.json — the machine-readable DeepSeek rate card served
 * at https://dsh.works/dsh-meter/pricing.json — from lib/core.js.
 *
 * It exists because no external source is correct. The two aggregators most
 * people point a cost estimator at, models.dev and LiteLLM's
 * `model_prices_and_context_window.json`, both carry a flat per-token price
 * per model: a schema with nowhere to put a tariff. DeepSeek has billed by
 * time of day since 2026-08-16, so anyone reading a flat number is wrong by
 * 2x for seven hours of every UTC day, and by more than that if the number
 * they are reading is the retired pre-switchover card.
 *
 * This feed publishes the shape the card actually has: rates per bucket per
 * tariff per currency, the clock that selects the tariff, the retired card
 * kept so old sessions still reprice, and the bucket definitions — because
 * mapping a provider's usage report onto the three billed buckets is the half
 * of a cost estimate that a price list cannot help you with.
 *
 * Generated, never typed, from the same module the plugin and the site use, so
 * the feed cannot state a price the meter would not charge. It is a pure
 * function of lib/core.js — no timestamp, no fetch — so `--check` means the
 * file changes exactly when the card does.
 *
 * Usage: `node scripts/build-pricing.mjs` writes the feed;
 *        `node scripts/build-pricing.mjs --check` fails when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CACHE_DISCOUNT, CURRENCIES, CURRENCY_SYMBOL, PEAK_WINDOWS_UTC, RATES, TARIFFS,
  TIME_OF_USE_FROM, tariffSchedule,
} from '../lib/core.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Tariffs still quoted for a new request; `flat` is history, and lives under `retired`. */
const live = TARIFFS.filter(tariff => tariff !== 'flat')

/**
 * How many cache misses one output token costs, on the live card — derived the
 * same way `CACHE_DISCOUNT` is, and for the same reason: a ratio typed into a
 * sentence is a claim nothing fails when it stops being true.
 */
const OUTPUT_MULTIPLE = Math.min(...Object.values(RATES).flatMap(byTariff =>
  live.flatMap(tariff => Object.values(byTariff[tariff]).map(rate => rate.out / rate.miss))))

/**
 * Beijing is UTC+8 and China has not observed daylight saving since 1991, so
 * the Beijing-anchored policy maps to fixed UTC hours all year. That is the
 * only reason a schedule of UTC hours is a safe representation at all.
 */
const BEIJING_OFFSET_HOURS = 8

/** The same windows as DeepSeek's Chinese page states them — strings, never an indexable schedule. */
const beijingWindows = PEAK_WINDOWS_UTC.map(([start, end]) => {
  const local = hour => String((hour + BEIJING_OFFSET_HOURS) % 24).padStart(2, '0')
  return `${local(start)}:00-${local(end)}:00`
})

/** One model's rates, keyed tariff -> currency -> bucket, straight off the card. */
const ratesOf = (byTariff, tariffs) => Object.fromEntries(tariffs.map(tariff => [
  tariff,
  Object.fromEntries(CURRENCIES.map(currency => [currency, { ...byTariff[tariff][currency] }])),
]))

const feed = {
  schema: 'dsh-meter/pricing@1',
  generator: `@dshworks/dsh-meter@${version}`,
  homepage: 'https://dsh.works/dsh-meter/',
  /* Two independently published tables. An account bills in exactly one of
   * them, and only the account knows which — never convert between them. */
  source: {
    usd: 'https://api-docs.deepseek.com/quick_start/pricing',
    cny: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  },
  unit: 'currency per 1M tokens',
  currencies: Object.fromEntries(CURRENCIES.map(currency => [currency, { symbol: CURRENCY_SYMBOL[currency] }])),
  currencyNote: 'usd is the international platform table and cny the mainland one. They are separate published prices, not an exchange-rate conversion of each other. GET /user/balance reports which one an account bills in.',

  timeOfUse: {
    since: new Date(TIME_OF_USE_FROM).toISOString(),
    sinceEpochMs: TIME_OF_USE_FROM,
    peakWindowsUtc: PEAK_WINDOWS_UTC.map(([start, end]) => ({ startHourUtc: start, endHourUtc: end })),
    /** 24 entries, index = UTC hour, so a consumer needs no window arithmetic. */
    scheduleUtc: tariffSchedule(),
    offPeakIsHalfOfPeak: true,
    note: 'A request is billed at the tariff in force when it was DISPATCHED, not when the answer completed. A long response that starts off-peak and finishes in a peak window bills off-peak.',

    /* The policy is written in Beijing time on DeepSeek's Chinese page and in
     * UTC on the English one. Both are published and both are checked. */
    anchor: {
      timezone: 'Asia/Shanghai',
      utcOffsetHours: BEIJING_OFFSET_HOURS,
      observesDaylightSaving: false,
      peakWindowsBeijing: beijingWindows,
      note: 'China has not observed daylight saving since 1991, so the UTC hours above are stable year-round and need no timezone database. peakWindowsBeijing is for display only — scheduleUtc is the machine-readable form.',
    },

    /* The one way to misread this file. */
    readingNow: 'tariff = scheduleUtc[new Date(dispatchedAtMs).getUTCHours()]. Index with UTC hours, NEVER local hours: scheduleUtc is not rotated into the reader\'s timezone. This file deliberately carries no current-time field, so a cached or vendored copy can never be stale about which tariff is running.',
  },

  buckets: {
    hit: {
      billsAs: 'input, cache hit',
      from: 'usage.prompt_cache_hit_tokens',
      note: 'A hit costs about 1/' + CACHE_DISCOUNT + ' of a miss on the live card — the single largest lever on a session bill.',
    },
    miss: {
      billsAs: 'input, cache miss',
      from: 'usage.prompt_tokens - usage.prompt_cache_hit_tokens',
      note: 'prompt_tokens is the TOTAL input and already contains the hits. Billing the two side by side double-counts every cached token. DeepSeek publishes no separate cache-write price: a first-time prompt bills here.',
    },
    out: {
      billsAs: 'output',
      from: 'usage.completion_tokens',
      note: `Reasoning tokens are output tokens and are already inside completion_tokens. Output is the most expensive bucket, ${OUTPUT_MULTIPLE}x a cache miss.`,
    },
  },
  formula: 'cost = SUM over buckets of tokens[bucket] * rates[model][tariffAt(dispatchedAt)][currency][bucket] / 1e6',

  models: Object.fromEntries(Object.entries(RATES).map(([model, byTariff]) => [model, {
    rates: ratesOf(byTariff, live),
    retired: {
      /* Kept because a ledger reprices history: a session logged before the
       * switchover must still cost what it actually cost. Never quote it for
       * a new request. */
      flat: {
        ...ratesOf(byTariff, ['flat']).flat,
        until: new Date(TIME_OF_USE_FROM).toISOString(),
        note: 'The single all-day rate DeepSeek billed before time-of-use. Retired — several third-party price feeds still publish it as current.',
      },
    },
  }])),
}

const json = `${JSON.stringify(feed, null, 2)}\n`
const target = join(root, 'docs/pricing.json')

if (process.argv.includes('--check')) {
  const current = (() => {
    try {
      return readFileSync(target, 'utf8')
    } catch {
      return ''
    }
  })()
  if (current !== json) {
    process.stderr.write('build-pricing: docs/pricing.json is stale — run `node scripts/build-pricing.mjs`\n')
    process.exit(1)
  }
  process.stdout.write('build-pricing: docs/pricing.json is in sync\n')
} else {
  writeFileSync(target, json)
  process.stdout.write(`build-pricing: wrote docs/pricing.json (${json.length} bytes)\n`)
}
