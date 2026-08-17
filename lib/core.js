/**
 * dsh-meter core — the official DeepSeek rate card, the time-of-use clock, and
 * the pure cost fold.
 *
 * This module is the single source of both halves: the host plugin imports it,
 * and `scripts/build-client.mjs` inlines this exact file into the browser
 * bundle. A price never exists in two places.
 *
 * Money is computed from provider-reported token counts, so it is an estimate
 * of what DeepSeek will bill, not the invoice. The three billed buckets are
 * disjoint by the harness `TokenUsage` convention: `inputTokens` is
 * cache-MISS input (the DeepSeek adapter subtracts hits out of `prompt_tokens`),
 * `cacheReadTokens` is cache-HIT input, and `outputTokens` already contains
 * reasoning tokens.
 */

/* ------------------------------------------------------------------ *
 * PRICING-TABLE-START — verbatim from
 * https://api-docs.deepseek.com/quick_start/pricing (re-checked 2026-08-17).
 * Units: currency per 1M tokens. USD is the international platform's table
 * and CNY the mainland platform's — they are separate published tables, not
 * an exchange-rate conversion of each other.
 *
 * The switchover has happened: upstream now publishes only the off-peak and
 * peak rows, in both locales. `flat` is kept because the ledger reprices
 * history — a session logged before the switchover must still cost what it
 * actually cost — and `tariffAt` will never return it for a new request.
 * Confirmed against a real bill, not just the page: 188,542 cache-miss
 * tokens on pro, off-peak, settled at ¥0.84 — ¥4.46/1M against the
 * published 4.5, where the flat card would have made it 3.0.
 * ------------------------------------------------------------------ */

/** Time-of-use billing began at 16:00 UTC on 2026-08-16 (00:00 Beijing, Aug 17). Before it, one flat rate applied all day. */
export const TIME_OF_USE_FROM = Date.UTC(2026, 7, 16, 16, 0, 0)

/**
 * Peak windows as `[startHourUtc, endHourUtc)` pairs — 01:00-04:00 and
 * 06:00-10:00 UTC (09:00-12:00 and 14:00-18:00 Beijing). Every other hour is
 * off-peak, including the two-hour 04:00-06:00 gap between the windows.
 */
export const PEAK_WINDOWS_UTC = [[1, 4], [6, 10]]

/**
 * Published rates per 1M tokens, by model, tariff, and currency.
 * `hit` = cache-hit input, `miss` = cache-miss input, `out` = output.
 */
export const RATES = {
  'deepseek-v4-flash': {
    flat: { usd: { hit: 0.0028, miss: 0.14, out: 0.28 }, cny: { hit: 0.02, miss: 1, out: 2 } },
    offpeak: { usd: { hit: 0.007, miss: 0.22, out: 0.66 }, cny: { hit: 0.05, miss: 1.5, out: 4.5 } },
    peak: { usd: { hit: 0.014, miss: 0.44, out: 1.32 }, cny: { hit: 0.1, miss: 3, out: 9 } },
  },
  'deepseek-v4-pro': {
    flat: { usd: { hit: 0.003625, miss: 0.435, out: 0.87 }, cny: { hit: 0.025, miss: 3, out: 6 } },
    offpeak: { usd: { hit: 0.022, miss: 0.66, out: 1.98 }, cny: { hit: 0.15, miss: 4.5, out: 13.5 } },
    peak: { usd: { hit: 0.044, miss: 1.32, out: 3.96 }, cny: { hit: 0.3, miss: 9, out: 27 } },
  },
}
/* PRICING-TABLE-END */

/** Tariffs in display order; `flat` is the retired pre-time-of-use single rate. */
export const TARIFFS = ['flat', 'offpeak', 'peak']

/**
 * How many cache misses one cache hit costs, on the live card — the smallest
 * such ratio across every model, tariff, and currency still billed, rounded
 * down so the claim is never larger than the cheapest row supports.
 *
 * Derived rather than typed: the flat card discounted a hit 50x on flash and
 * 120x on pro, time-of-use discounts it 30x, and a hardcoded number in a UI
 * string is a claim nothing fails when it stops being true. `tests/tariff`
 * pins it to the table.
 */
export const CACHE_DISCOUNT = Math.floor(
  Math.min(...Object.values(RATES).flatMap((byTariff) =>
    TARIFFS.filter((tariff) => tariff !== 'flat').flatMap((tariff) =>
      Object.values(byTariff[tariff]).map((rate) => rate.miss / rate.hit)))),
)

/** Currency symbols for the two published tables. */
export const CURRENCY_SYMBOL = { usd: '$', cny: '¥' }

/**
 * The tariff a request dispatched at `epochMs` is billed under.
 * @param {number} epochMs - request dispatch time.
 * @returns {'flat'|'peak'|'offpeak'} the tariff in force at that instant.
 */
export function tariffAt(epochMs) {
  if (epochMs < TIME_OF_USE_FROM) return 'flat'
  const hour = new Date(epochMs).getUTCHours()
  for (const [start, end] of PEAK_WINDOWS_UTC) if (hour >= start && hour < end) return 'peak'
  return 'offpeak'
}

/**
 * When the tariff next changes, and to what. Before the switchover the answer
 * is the switchover itself — that is the next change a user can act on.
 * @param {number} epochMs - the instant to look forward from.
 * @returns {{ tariff: string, next: string, at: number }} current tariff, the one that follows, and when it starts.
 */
export function nextTariffChange(epochMs) {
  const tariff = tariffAt(epochMs)
  if (epochMs < TIME_OF_USE_FROM) {
    return { tariff, next: tariffAt(TIME_OF_USE_FROM), at: TIME_OF_USE_FROM }
  }
  const hourMs = 3_600_000
  const dayStart = Math.floor(epochMs / (24 * hourMs)) * 24 * hourMs
  const boundaries = []
  for (const [start, end] of PEAK_WINDOWS_UTC) boundaries.push(start, end)
  boundaries.sort((a, b) => a - b)
  for (const hour of boundaries) {
    const at = dayStart + hour * hourMs
    if (at > epochMs) return { tariff, next: tariffAt(at), at }
  }
  // Past the last boundary of the UTC day: the next change is the first one tomorrow.
  const at = dayStart + 24 * hourMs + boundaries[0] * hourMs
  return { tariff, next: tariffAt(at), at }
}

/**
 * The published schedule itself: 24 UTC hours labelled peak or off-peak, for
 * the clock strip. Independent of the switchover date — before it the strip
 * shows the schedule that is about to apply, which is exactly what a user
 * planning the next hour needs to see.
 * @returns {string[]} 24 tariff names, index = UTC hour.
 */
export function tariffSchedule() {
  const hours = []
  for (let hour = 0; hour < 24; hour++) {
    hours.push(PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end) ? 'peak' : 'offpeak')
  }
  return hours
}

/** Whether a model id has a published rate. */
export const isPriced = model => Object.prototype.hasOwnProperty.call(RATES, model)

/**
 * Cost of one token bucket set under one tariff.
 * @param {{miss: number, hit: number, out: number}} tokens - billed token counts.
 * @param {string} model - provider model id.
 * @param {string} tariff - tariff key.
 * @param {string} currency - `usd` or `cny`.
 * @returns {number} cost in the currency's units, 0 for an unpriced model.
 */
export function costOf(tokens, model, tariff, currency) {
  const split = bucketCostOf(tokens, model, tariff, currency)
  return split.miss + split.hit + split.out
}

/**
 * The same cost, kept split by billed bucket — what the breakdown rows show.
 * @param {{miss: number, hit: number, out: number}} tokens - billed token counts.
 * @param {string} model - provider model id.
 * @param {string} tariff - tariff key.
 * @param {string} currency - `usd` or `cny`.
 * @returns {{miss: number, hit: number, out: number}} cost per bucket, all zero for an unpriced model.
 */
export function bucketCostOf(tokens, model, tariff, currency) {
  const rate = RATES[model]?.[tariff]?.[currency]
  if (rate === undefined) return { miss: 0, hit: 0, out: 0 }
  return {
    miss: (tokens.miss * rate.miss) / 1_000_000,
    hit: (tokens.hit * rate.hit) / 1_000_000,
    out: (tokens.out * rate.out) / 1_000_000,
  }
}

/* ------------------------------------------------------------------ *
 * The fold: session log -> billed token buckets.
 * ------------------------------------------------------------------ */

const zero = () => ({ miss: 0, hit: 0, out: 0, requests: 0 })

const add = (target, sample, requests) => ({
  miss: target.miss + sample.miss,
  hit: target.hit + sample.hit,
  out: target.out + sample.out,
  requests: target.requests + requests,
})

/**
 * The three billed buckets of one usage report. A `cacheWriteTokens` count
 * (never reported by the DeepSeek adapter, possible from another) joins the
 * cache-miss bucket: DeepSeek publishes no separate write price and bills a
 * first-time prompt at the miss rate.
 * @param {object} usage - harness `TokenUsage`.
 * @returns {{miss: number, hit: number, out: number}} billed token counts.
 */
export function billedTokens(usage) {
  const number = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    miss: number(usage.inputTokens) + number(usage.cacheWriteTokens),
    hit: number(usage.cacheReadTokens),
    out: number(usage.outputTokens),
  }
}

/** Initial fold state for an empty log. */
export const init = () => ({ bills: {}, last: null, step: null, route: null, firstAt: null, lastAt: null })

/** The usage a chunk or a finalized assistant message reports, if any. */
const usageOf = (event) => {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') return event.data.chunk.usage
  if (event.type === 'assistant/message') return event.data.usage
  return undefined
}

/** Bill key: one bucket per (tariff, model) pair. */
const billKey = (tariff, model) => `${tariff}\u0000${model}`

/**
 * Fold one committed session event into the billing state.
 *
 * A step reports usage twice — an early `assistant/chunk` that survives a later
 * request failure, then the finalized `assistant/message` — so a repeated
 * report for the same (turn, step) REPLACES its predecessor rather than adding
 * to it, including when the message's own model differs from the request
 * header that preceded it.
 * @param {object} state - state covering all prior events.
 * @param {object} event - the next committed session event.
 * @returns {object} next state, or the same reference when the event is not ours.
 */
export function foldEvent(state, event) {
  if (event.type === 'step/start') {
    return { ...state, step: { turn: event.data.turn, step: event.data.step, time: event.time } }
  }
  if (event.type === 'request/context') {
    const route = { model: event.data.model, provider: event.data.provider }
    if (state.route !== null && state.route.model === route.model && state.route.provider === route.provider) return state
    return { ...state, route }
  }
  if (event.type === 'request/header') {
    const model = event.data.header.config?.model
    if (typeof model !== 'string' || model === '') return state
    const route = { model, provider: event.data.header.config?.provider ?? state.route?.provider ?? '' }
    if (state.route !== null && state.route.model === route.model && state.route.provider === route.provider) return state
    return { ...state, route }
  }

  const usage = usageOf(event)
  if (usage === undefined) return state

  const { turn, step } = event.data
  // The message carries the model that actually answered; a chunk-only report
  // (a step whose request later failed) falls back to the last routed model.
  const source = event.type === 'assistant/message' ? event.data.message?.source : undefined
  const model = source?.kind === 'model' && typeof source.model === 'string' && source.model !== ''
    ? source.model
    : state.route?.model
  if (typeof model !== 'string' || model === '') return state

  // Dispatch time decides the tariff, not the time the answer finished: a
  // request sent one minute before the peak window opens is billed off-peak.
  const dispatchedAt = state.step !== null && state.step.turn === turn && state.step.step === step
    ? state.step.time
    : event.time
  const tariff = tariffAt(dispatchedAt)
  const sample = billedTokens(usage)
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
  if (previous !== null
    && previous.key === billKey(tariff, model)
    && previous.sample.miss === sample.miss
    && previous.sample.hit === sample.hit
    && previous.sample.out === sample.out) {
    return state
  }

  const bills = { ...state.bills }
  if (previous !== null) {
    const held = bills[previous.key] ?? zero()
    bills[previous.key] = add(held, { miss: -previous.sample.miss, hit: -previous.sample.hit, out: -previous.sample.out }, -1)
  }
  const key = billKey(tariff, model)
  bills[key] = add(bills[key] ?? zero(), sample, 1)

  return {
    ...state,
    bills,
    last: { turn, step, key, sample },
    firstAt: state.firstAt ?? dispatchedAt,
    lastAt: dispatchedAt,
  }
}

/** The two published rate cards; both are always computed. */
export const CURRENCIES = ['usd', 'cny']

/**
 * Price one currency's whole ledger.
 * @param {object} bills - the fold's per-(tariff, model) token buckets.
 * @param {string} currency - `usd` or `cny`.
 * @returns {object} every money figure for that rate card.
 */
function priceIn(bills, currency) {
  const byBucket = { miss: 0, hit: 0, out: 0 }
  const byTariff = { flat: 0, offpeak: 0, peak: 0 }
  const counterfactual = { flat: 0, offpeak: 0, peak: 0, noCache: 0 }
  const models = {}
  let cost = 0

  for (const [key, tokens] of Object.entries(bills)) {
    if (tokens.requests === 0 && tokens.miss === 0 && tokens.hit === 0 && tokens.out === 0) continue
    const cut = key.indexOf('\u0000')
    const tariff = key.slice(0, cut)
    const model = key.slice(cut + 1)
    const split = bucketCostOf(tokens, model, tariff, currency)
    byBucket.miss += split.miss
    byBucket.hit += split.hit
    byBucket.out += split.out
    const billed = split.miss + split.hit + split.out
    models[model] = (models[model] ?? 0) + billed
    cost += billed
    byTariff[tariff] += billed
    for (const alternative of TARIFFS) counterfactual[alternative] += costOf(tokens, model, alternative, currency)
    // Every cache hit repriced as a miss: what the reuse was worth.
    counterfactual.noCache += costOf({ miss: tokens.miss + tokens.hit, hit: 0, out: tokens.out }, model, tariff, currency)
  }

  return {
    cost: round(cost),
    byBucket: { miss: round(byBucket.miss), hit: round(byBucket.hit), out: round(byBucket.out) },
    byTariff: { flat: round(byTariff.flat), offpeak: round(byTariff.offpeak), peak: round(byTariff.peak) },
    counterfactual: {
      flat: round(counterfactual.flat),
      offpeak: round(counterfactual.offpeak),
      peak: round(counterfactual.peak),
      noCache: round(counterfactual.noCache),
    },
    modelCost: Object.fromEntries(Object.entries(models).map(([model, amount]) => [model, round(amount)])),
  }
}

/**
 * Project the billing state into the value the Web UI reads.
 *
 * Money is computed against BOTH published rate cards. DeepSeek bills an
 * account in exactly one of them, and the account — not this plugin — decides
 * which: the surface takes the side the account's own balance is denominated
 * in. Nothing here guesses, and no figure is ever a converted one.
 *
 * `counterfactual` is what the same tokens would have cost billed entirely at
 * one tariff — the honest way to show what the time-of-use switchover, or a
 * cold cache, is worth on this session's actual traffic.
 * @param {object} state - the folded billing state.
 * @param {string} [preferred] - configured currency, or `auto` to let the surface decide.
 * @returns {object} the wire value for the `costMeter` projection key.
 */
export function view(state, preferred = 'auto') {
  const models = new Map()
  const totals = { miss: 0, hit: 0, out: 0 }
  let requests = 0
  let unpricedRequests = 0

  for (const [key, tokens] of Object.entries(state.bills)) {
    if (tokens.requests === 0 && tokens.miss === 0 && tokens.hit === 0 && tokens.out === 0) continue
    const model = key.slice(key.indexOf('\u0000') + 1)
    const priced = isPriced(model)
    const held = models.get(model) ?? { model, priced, miss: 0, hit: 0, out: 0, requests: 0 }
    models.set(model, {
      ...held,
      miss: held.miss + tokens.miss,
      hit: held.hit + tokens.hit,
      out: held.out + tokens.out,
      requests: held.requests + tokens.requests,
    })
    totals.miss += tokens.miss
    totals.hit += tokens.hit
    totals.out += tokens.out
    requests += tokens.requests
    if (!priced) unpricedRequests += tokens.requests
  }

  return {
    preferred,
    requests,
    tokens: totals,
    money: Object.fromEntries(CURRENCIES.map(currency => [currency, priceIn(state.bills, currency)])),
    models: [...models.values()]
      .sort((left, right) =>
        (right.miss + right.hit + right.out) - (left.miss + left.hit + left.out)
        || left.model.localeCompare(right.model)),
    unpricedRequests,
    ...state.firstAt === null ? {} : { firstAt: state.firstAt },
    ...state.lastAt === null ? {} : { lastAt: state.lastAt },
  }
}

/** Money carries eight decimals: a single cheap request is worth ~1e-6 and must not round to nothing. */
const round = amount => Math.round(amount * 1e8) / 1e8

/**
 * Structural check on the projection value, standing in for the Zod schema the
 * registry's typed contract names — the value is produced by {@link view} in
 * this same module, so this is a tripwire against a fold bug, not input parsing.
 */
export const schema = {
  /**
   * Validate one projection value.
   * @param {unknown} value - the `view` output.
   * @returns {object} the same value when it holds.
   */
  parse(value) {
    const fail = (reason) => { throw new Error(`dsh-meter: malformed costMeter projection (${reason})`) }
    if (typeof value !== 'object' || value === null) fail('not an object')
    const money = (amount, field) => {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) fail(`${field} is not a non-negative number`)
    }
    if (!Array.isArray(value.models)) fail('models is not an array')
    if (!Number.isInteger(value.requests) || value.requests < 0) fail('requests is not a count')
    for (const currency of CURRENCIES) {
      const priced = value.money?.[currency]
      if (priced === undefined) fail(`money.${currency} is absent`)
      money(priced.cost, `money.${currency}.cost`)
      for (const key of ['miss', 'hit', 'out']) money(priced.byBucket?.[key], `money.${currency}.byBucket.${key}`)
      for (const key of ['flat', 'offpeak', 'peak']) money(priced.byTariff?.[key], `money.${currency}.byTariff.${key}`)
      for (const key of ['flat', 'offpeak', 'peak', 'noCache']) {
        money(priced.counterfactual?.[key], `money.${currency}.counterfactual.${key}`)
      }
      for (const entry of value.models) {
        if (entry.priced) money(priced.modelCost?.[entry.model], `money.${currency}.modelCost[${entry.model}]`)
      }
    }
    return value
  },
}

/* ------------------------------------------------------------------ *
 * Display helpers — shared so the dock line, the card, and any future
 * surface round money the same way.
 * ------------------------------------------------------------------ */

/**
 * Money at a fixed useful precision: four decimals under a unit (a whole
 * session is often worth less than one cent), two above it, none above 1000.
 * @param {number} amount - cost in currency units.
 * @param {string} currency - `usd` or `cny`.
 * @returns {string} display string with its symbol.
 */
export function formatMoney(amount, currency) {
  const symbol = CURRENCY_SYMBOL[currency] ?? ''
  const magnitude = Math.abs(amount)
  if (magnitude >= 1000) return `${symbol}${Math.round(amount)}`
  if (magnitude >= 1) return `${symbol}${amount.toFixed(2)}`
  if (magnitude === 0) return `${symbol}0`
  if (magnitude < 0.0001) return `<${symbol}0.0001`
  return `${symbol}${amount.toFixed(4)}`
}

/**
 * Compact token count, matching the harness stats line: 517 / 12.2K / 1.2M.
 * @param {number} count - token count.
 * @returns {string} display string.
 */
export function formatTokens(count) {
  const scaled = value => (value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10))
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${scaled(count / 1000)}K`
  return `${scaled(count / 1_000_000)}M`
}

/**
 * Coarse countdown for the tariff clock: 45s, 12m, 3h20m, 2d.
 * @param {number} ms - milliseconds remaining.
 * @returns {string} display string.
 */
export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours < 10 && minutes % 60 !== 0 ? `${hours}h${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
