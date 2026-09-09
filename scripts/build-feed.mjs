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
 * Usage: `node scripts/build-feed.mjs` writes the feed;
 *        `node scripts/build-feed.mjs --check` fails when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CACHE_DISCOUNT, CURRENCIES, CURRENCY_SYMBOL, PEAK_WINDOWS_BEIJING, PEAK_WINDOWS_UTC,
  RATES, TARIFFS, TIME_OF_USE_FROM, WEEKEND_OFFPEAK_FROM, tariffSchedule,
} from '../lib/core.js'
import { BILL_CHECK } from '../lib/bill-check.js'

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
  schema: 'dsh-meter/pricing@2',
  generator: `@dshworks/dsh-meter@${version}`,
  homepage: 'https://dsh.works/dsh-meter/',
  /* Two independently published tables. An account bills in exactly one of
   * them, and only the account knows which — never convert between them. */
  source: {
    usd: 'https://api-docs.deepseek.com/quick_start/pricing',
    cny: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  },
  // The card is diffed against those two pages daily. This is the other check:
  // what the vendor actually charged. `predicted` is recomputed here from the
  // same RATES the feed publishes, so the receipt cannot vouch for a card that
  // has since moved.
  verifiedAgainstBill: {
    ...BILL_CHECK,
    samples: BILL_CHECK.samples.map(sample => {
      const rate = RATES[sample.model][BILL_CHECK.tariff][BILL_CHECK.currency]
      const predicted = (sample.tokens.miss * rate.miss + sample.tokens.hit * rate.hit + sample.tokens.out * rate.out) / 1e6
      return { ...sample, predicted: Number(predicted.toFixed(4)) }
    }),
  },
  unit: 'currency per 1M tokens',
  currencies: Object.fromEntries(CURRENCIES.map(currency => [currency, { symbol: CURRENCY_SYMBOL[currency] }])),
  currencyNote: 'usd is the international platform table and cny the mainland one. They are separate published prices, not an exchange-rate conversion of each other. GET /user/balance reports which one an account bills in.',

  timeOfUse: {
    since: new Date(TIME_OF_USE_FROM).toISOString(),
    sinceEpochMs: TIME_OF_USE_FROM,
    peakWindowsUtc: PEAK_WINDOWS_UTC.map(([start, end]) => ({ startHourUtc: start, endHourUtc: end })),
    /**
     * 7 rows of 24, indexed `[beijingWeekday][beijingHour]` — 0 is Sunday, as
     * `Date.prototype.getUTCDay` numbers them. Both axes are on the vendor's
     * clock so one Beijing instant supplies both indices.
     *
     * This replaced the flat 24-entry `scheduleUtc` of `@1`, which had no day
     * axis and so labelled the whole weekend peak. The key was renamed rather
     * than widened deliberately: a consumer still indexing by hour alone now
     * gets `undefined` and fails, instead of quietly reading row 0 and being
     * wrong by 2x for 14 hours a week.
     */
    scheduleBeijing: tariffSchedule(),
    offPeakIsHalfOfPeak: true,

    /* The weekend rule, and the date it started — a ledger repricing a session
     * from before it must still charge peak, because the account did. */
    weekend: {
      offPeakAllDay: true,
      daysBeijing: [0, 6],
      since: new Date(WEEKEND_OFFPEAK_FROM).toISOString(),
      sinceEpochMs: WEEKEND_OFFPEAK_FROM,
      note: 'Saturdays and Sundays on the Beijing clock bill off-peak for all 24 hours. Announced by DeepSeek only in the pricing-page footnote and only until it took effect; the live page now states the settled rule. The announcement survives at https://web.archive.org/web/20260822141620/https://api-docs.deepseek.com/quick_start/pricing/',
    },
    note: 'A request is billed at the tariff in force when it was DISPATCHED, not when the answer completed. A long response that starts off-peak and finishes in a peak window bills off-peak.',

    /* The policy is written in Beijing time on DeepSeek's Chinese page and in
     * UTC on the English one. Both are published and both are checked. */
    anchor: {
      timezone: 'Asia/Shanghai',
      utcOffsetHours: BEIJING_OFFSET_HOURS,
      observesDaylightSaving: false,
      peakWindowsBeijing: beijingWindows,
      peakWindowHoursBeijing: PEAK_WINDOWS_BEIJING.map(([start, end]) => ({ startHour: start, endHour: end })),
      note: 'China has not observed daylight saving since 1991, so the hours here are stable year-round and need no timezone database. peakWindowsBeijing is display text; scheduleBeijing is the machine-readable form. Both windows close at 18:00 Beijing, so neither crosses midnight and every window sits inside one weekday.',
    },

    /* The one way to misread this file. */
    readingNow: 'const beijing = new Date(dispatchedAtMs + 8 * 3600000); tariff = scheduleBeijing[beijing.getUTCDay()][beijing.getUTCHours()]. Take BOTH indices off that one shifted instant, and read them with the getUTC* accessors: the shift has already moved the fields to Beijing, and the reader\'s own weekday and the vendor\'s disagree for the eight hours from 16:00 UTC. Never index with local hours. This file deliberately carries no current-time field, so a cached or vendored copy can never be stale about which tariff is running.',

    /* @1 published `scheduleUtc`, 24 entries with no day axis, so it read the
     * weekend as peak. It is gone rather than deprecated: this feed exists to
     * be vendored, and a wrong number left in place for a release is exactly
     * the failure the file argues against elsewhere. */
    changedInV2: 'scheduleUtc (24 entries, index = UTC hour) was replaced by scheduleBeijing (7 x 24, index = [beijingWeekday][beijingHour]) and the weekend block was added. A reader pinned to @1 was labelling Saturday and Sunday peak and so overstating those sessions by 2x from 2026-08-22T16:00:00Z.',
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
    /* Kept because a ledger reprices history: a session logged before the
     * switchover must still cost what it actually cost. Never quote it for
     * a new request.
     *
     * Omitted entirely for a model that never billed under a flat rate --
     * deepseek-v4-flash-vision-exp shipped after the switchover, so it has no
     * pre-time-of-use history to reprice. `apply-pricing` already drops the
     * row for such a model (see its `held === undefined` branch); emitting
     * `retired.flat: { until, note }` with no rates would publish an empty
     * card that reads like a real one. An absent key is the honest shape. */
    ...(byTariff.flat === undefined ? {} : {
      retired: {
        flat: {
          ...ratesOf(byTariff, ['flat']).flat,
          until: new Date(TIME_OF_USE_FROM).toISOString(),
          note: 'The single all-day rate DeepSeek billed before time-of-use. Retired — several third-party price feeds still publish it as current.',
        },
      },
    }),
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
    process.stderr.write('build-feed: docs/pricing.json is stale — run `node scripts/build-feed.mjs`\n')
    process.exit(1)
  }
  process.stdout.write('build-feed: docs/pricing.json is in sync\n')
} else {
  writeFileSync(target, json)
  process.stdout.write(`build-feed: wrote docs/pricing.json (${json.length} bytes)\n`)
}
