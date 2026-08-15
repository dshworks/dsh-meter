import { describe, expect, it } from 'vitest'
import { RATES, TIME_OF_USE_FROM, billedTokens, foldEvent, init, schema, view } from '../lib/core.js'

const utc = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute)

/** Build a session-event envelope; `seq` is irrelevant to the fold and stays 0. */
const event = (type, time, data) => ({ type, seq: 0, time, data })

const stepStart = (time, turn = 0, step = 0) => event('step/start', time, { turn, step })

const header = (time, model) => event('request/header', time, {
  header: { config: { provider: 'deepseek', model } },
  reason: 'initial',
})

const usageChunk = (time, usage, turn = 0, step = 0) =>
  event('assistant/chunk', time, { turn, step, chunk: { type: 'usage', usage } })

const message = (time, model, usage, turn = 0, step = 0) => event('assistant/message', time, {
  turn,
  step,
  message: { source: { kind: 'model', provider: 'deepseek', model } },
  usage,
})

const usage = (input, cacheRead, output) => ({
  inputTokens: input,
  cacheReadTokens: cacheRead,
  outputTokens: output,
})

/** Fold a list of events from the empty state. */
const fold = events => events.reduce(foldEvent, init())

describe('billedTokens', () => {
  it('reads the three disjoint buckets, reasoning already inside output', () => {
    expect(billedTokens({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 40 }))
      .toEqual({ miss: 100, hit: 900, out: 50 })
  })

  it('bills a cache write at the miss rate — DeepSeek publishes no write price', () => {
    expect(billedTokens({ inputTokens: 100, cacheWriteTokens: 20, outputTokens: 0 }))
      .toEqual({ miss: 120, hit: 0, out: 0 })
  })

  it('survives an adapter that reports nothing', () => {
    expect(billedTokens({})).toEqual({ miss: 0, hit: 0, out: 0 })
  })
})

describe('the fold', () => {
  const before = utc(2026, 8, 15, 12)

  it('ignores a log with no usage', () => {
    const state = init()
    expect(foldEvent(state, stepStart(before))).not.toBe(state)
    expect(foldEvent(state, event('tool/call', before, { turn: 0, step: 0 }))).toBe(state)
    expect(view(fold([stepStart(before)]), 'usd').requests).toBe(0)
  })

  it('bills one request at the tariff in force when it was dispatched', () => {
    const value = view(fold([
      stepStart(before),
      header(before, 'deepseek-v4-pro'),
      message(before + 4000, 'deepseek-v4-pro', usage(1_000_000, 0, 0)),
    ]), 'usd')
    expect(value.cost).toBeCloseTo(RATES['deepseek-v4-pro'].flat.usd.miss, 10)
    expect(value.byTariff.flat).toBeCloseTo(value.cost, 10)
    expect(value.requests).toBe(1)
  })

  it('replaces a step usage chunk with the finalized message rather than adding to it', () => {
    const events = [
      stepStart(before),
      header(before, 'deepseek-v4-flash'),
      usageChunk(before + 500, usage(1000, 0, 10)),
      message(before + 900, 'deepseek-v4-flash', usage(1000, 0, 400)),
    ]
    const value = view(fold(events), 'usd')
    expect(value.requests).toBe(1)
    expect(value.tokens).toEqual({ miss: 1000, hit: 0, out: 400 })
  })

  it('re-attributes a replaced sample when the message names a different model', () => {
    const events = [
      stepStart(before),
      header(before, 'deepseek-v4-flash'),
      usageChunk(before + 500, usage(1000, 0, 10)),
      message(before + 900, 'deepseek-v4-pro', usage(1000, 0, 10)),
    ]
    const value = view(fold(events), 'usd')
    expect(value.requests).toBe(1)
    expect(value.models).toHaveLength(1)
    expect(value.models[0].model).toBe('deepseek-v4-pro')
  })

  it('keeps a chunk-only sample from a step whose request then failed', () => {
    const value = view(fold([
      stepStart(before),
      header(before, 'deepseek-v4-flash'),
      usageChunk(before + 500, usage(2000, 0, 30)),
    ]), 'usd')
    expect(value.requests).toBe(1)
    expect(value.models[0].model).toBe('deepseek-v4-flash')
  })

  it('returns the same state reference for a repeated identical sample', () => {
    const base = fold([stepStart(before), header(before, 'deepseek-v4-flash')])
    const once = foldEvent(base, usageChunk(before + 1, usage(10, 0, 10)))
    expect(foldEvent(once, message(before + 2, 'deepseek-v4-flash', usage(10, 0, 10)))).toBe(once)
  })

  it('bills each step of a session that crosses a tariff boundary on its own side', () => {
    const offpeak = utc(2026, 8, 17, 0, 50)
    const peak = utc(2026, 8, 17, 1, 10)
    const value = view(fold([
      stepStart(offpeak, 0, 0),
      header(offpeak, 'deepseek-v4-flash'),
      message(offpeak + 60_000, 'deepseek-v4-flash', usage(1_000_000, 0, 0), 0, 0),
      stepStart(peak, 0, 1),
      message(peak + 1000, 'deepseek-v4-flash', usage(1_000_000, 0, 0), 0, 1),
    ]), 'usd')
    expect(value.byTariff.offpeak).toBeCloseTo(RATES['deepseek-v4-flash'].offpeak.usd.miss, 10)
    expect(value.byTariff.peak).toBeCloseTo(RATES['deepseek-v4-flash'].peak.usd.miss, 10)
    expect(value.cost).toBeCloseTo(value.byTariff.offpeak + value.byTariff.peak, 10)
  })

  it('bills a request by its dispatch time, not by when the answer landed', () => {
    // Dispatched one minute before the peak window opens, answered inside it.
    const dispatch = utc(2026, 8, 17, 0, 59)
    const value = view(fold([
      stepStart(dispatch),
      header(dispatch, 'deepseek-v4-flash'),
      message(utc(2026, 8, 17, 1, 3), 'deepseek-v4-flash', usage(1_000_000, 0, 0)),
    ]), 'usd')
    expect(value.byTariff.offpeak).toBeGreaterThan(0)
    expect(value.byTariff.peak).toBe(0)
  })

  it('counts an unpriced model without inventing money for it', () => {
    const value = view(fold([
      stepStart(before),
      header(before, 'mystery-model'),
      message(before + 10, 'mystery-model', usage(500, 0, 500)),
    ]), 'usd')
    expect(value.cost).toBe(0)
    expect(value.requests).toBe(1)
    expect(value.unpricedRequests).toBe(1)
    expect(value.models[0]).toMatchObject({ model: 'mystery-model', priced: false })
  })
})

describe('the projected value', () => {
  const at = TIME_OF_USE_FROM + 3_600_000 * 12 // an off-peak hour after the switchover

  const session = () => fold([
    stepStart(at),
    header(at, 'deepseek-v4-pro'),
    message(at + 1000, 'deepseek-v4-pro', usage(100_000, 900_000, 20_000)),
  ])

  it('splits cost by billed bucket, summing to the total', () => {
    const value = view(session(), 'usd')
    expect(value.byBucket.miss + value.byBucket.hit + value.byBucket.out).toBeCloseTo(value.cost, 10)
    expect(value.byBucket.hit).toBeGreaterThan(0)
  })

  it('prices the counterfactuals off the same tokens', () => {
    const value = view(session(), 'usd')
    expect(value.counterfactual.peak).toBeCloseTo(value.counterfactual.offpeak * 2, 8)
    expect(value.counterfactual.offpeak).toBeCloseTo(value.cost, 10)
    // Every cache hit repriced as a miss: strictly more expensive.
    expect(value.counterfactual.noCache).toBeGreaterThan(value.cost)
  })

  it('answers in the requested currency', () => {
    expect(view(session(), 'cny').currency).toBe('cny')
    expect(view(session(), 'cny').cost).toBeGreaterThan(view(session(), 'usd').cost)
  })

  it('passes its own schema, and rejects a broken fold', () => {
    expect(() => schema.parse(view(session(), 'usd'))).not.toThrow()
    expect(() => schema.parse({ ...view(session(), 'usd'), cost: Number.NaN })).toThrow(/cost/)
    expect(() => schema.parse({ cost: 1, models: [] })).toThrow()
  })

  it('is plain JSON, as the persisted projection cache requires', () => {
    const state = session()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    const value = view(state, 'usd')
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })
})
