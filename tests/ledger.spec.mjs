import { describe, expect, it } from 'vitest'
import { RATES, TIME_OF_USE_FROM, V41_FLASH_FROM, billedTokens, foldEvent, init, rateOf, schema, view } from '../lib/core.js'

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

/** The projected value flattened to one currency, which is what most assertions are about. */
const priced = (state, currency = 'usd') => {
  const value = view(state)
  return { ...value, ...value.money[currency] }
}

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
    expect(priced(fold([stepStart(before)])).requests).toBe(0)
  })

  it('bills one request at the tariff in force when it was dispatched', () => {
    const value = priced(fold([
      stepStart(before),
      header(before, 'deepseek-v4-pro'),
      message(before + 4000, 'deepseek-v4-pro', usage(1_000_000, 0, 0)),
    ]))
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
    const value = priced(fold(events))
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
    const value = priced(fold(events))
    expect(value.requests).toBe(1)
    expect(value.models).toHaveLength(1)
    expect(value.models[0].model).toBe('deepseek-v4-pro')
  })

  it('keeps a chunk-only sample from a step whose request then failed', () => {
    const value = priced(fold([
      stepStart(before),
      header(before, 'deepseek-v4-flash'),
      usageChunk(before + 500, usage(2000, 0, 30)),
    ]))
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
    const value = priced(fold([
      stepStart(offpeak, 0, 0),
      header(offpeak, 'deepseek-v4-flash'),
      message(offpeak + 60_000, 'deepseek-v4-flash', usage(1_000_000, 0, 0), 0, 0),
      stepStart(peak, 0, 1),
      message(peak + 1000, 'deepseek-v4-flash', usage(1_000_000, 0, 0), 0, 1),
    ]))
    expect(value.byTariff.offpeak).toBeCloseTo(rateOf('deepseek-v4-flash', 'offpeak', 'usd').miss, 10)
    expect(value.byTariff.peak).toBeCloseTo(rateOf('deepseek-v4-flash', 'peak', 'usd').miss, 10)
    expect(value.cost).toBeCloseTo(value.byTariff.offpeak + value.byTariff.peak, 10)
  })

  describe('the V4.1 Flash retirement', () => {
    /* Weekday off-peak on both sides of the cutover: 2026-09-09 is a
     * Wednesday, and 12:00 / 16:30 UTC are outside both peak windows. */
    const oldDays = utc(2026, 9, 9, 12)
    const newDays = utc(2026, 9, 9, 16, 30)
    const flashSession = at => fold([
      stepStart(at),
      header(at, 'deepseek-v4-flash'),
      message(at + 5_000, 'deepseek-v4-flash', usage(1_000_000, 0, 0)),
    ])

    it('bills a legacy name at the old Flash price before the cutover', () => {
      expect(newDays).toBeGreaterThan(V41_FLASH_FROM)
      expect(oldDays).toBeLessThan(V41_FLASH_FROM)
      const value = priced(flashSession(oldDays), 'cny')
      expect(value.cost).toBe(1.5)
      expect(value.modelCost).toEqual({ 'deepseek-v4-flash': 1.5 })
    })

    it('bills the same name as deepseek-flash, at its price, after it', () => {
      // The echo still says deepseek-v4-flash; the bill says V4.1 Flash.
      const value = priced(flashSession(newDays), 'cny')
      expect(value.cost).toBe(RATES['deepseek-flash'].offpeak.cny.miss)
      expect(value.cost).toBe(1)
      expect(value.modelCost).toEqual({ 'deepseek-flash': 1 })
    })

    it('folds the retired vision model into the same successor', () => {
      const value = priced(fold([
        stepStart(newDays),
        header(newDays, 'deepseek-v4-flash-vision-exp'),
        message(newDays + 5_000, 'deepseek-v4-flash-vision-exp', usage(0, 0, 1_000_000)),
      ]), 'cny')
      expect(value.modelCost).toEqual({ 'deepseek-flash': 4 })
    })

    it('prices the new name, which the old card billed at zero', () => {
      const value = priced(fold([
        stepStart(newDays),
        header(newDays, 'deepseek-flash'),
        message(newDays + 5_000, 'deepseek-flash', usage(1_000_000, 1_000_000, 1_000_000)),
      ]), 'usd')
      expect(value.cost).toBeCloseTo(0.15 + 0.003 + 0.6, 10)
    })
  })

  describe('dsh 0.1.5 attempts', () => {
    const at = utc(2026, 9, 16, 12)
    const attempt = (time, reported, turn = 0, step = 0) => event('assistant/attempt', time, {
      turn,
      step,
      stream: [
        { type: 'text-chunks', time0: time, index: 0, dt: [0], texts: ['partial'] },
        ...(reported === undefined ? [] : [{ type: 'chunk', time, chunk: { type: 'usage', usage: reported } }]),
      ],
    })

    it('bills a failed attempt that reported usage, and the retry after it', () => {
      const value = priced(fold([
        stepStart(at),
        header(at, 'deepseek-flash'),
        attempt(at + 1_000, usage(1_000_000, 0, 0)),
        message(at + 9_000, 'deepseek-flash', usage(1_000_000, 0, 0)),
      ]), 'cny')
      // Two requests, both charged: the retry must not replace the attempt.
      expect(value.cost).toBe(2)
      expect(value.models[0].requests).toBe(2)
    })

    it('bills nothing for an attempt that died before the usage report', () => {
      const value = priced(fold([
        stepStart(at),
        header(at, 'deepseek-flash'),
        attempt(at + 1_000, undefined),
        message(at + 9_000, 'deepseek-flash', usage(1_000_000, 0, 0)),
      ]), 'cny')
      expect(value.cost).toBe(1)
    })
  })

  it('bills a request by its dispatch time, not by when the answer landed', () => {
    // Dispatched one minute before the peak window opens, answered inside it.
    const dispatch = utc(2026, 8, 17, 0, 59)
    const value = priced(fold([
      stepStart(dispatch),
      header(dispatch, 'deepseek-v4-flash'),
      message(utc(2026, 8, 17, 1, 3), 'deepseek-v4-flash', usage(1_000_000, 0, 0)),
    ]))
    expect(value.byTariff.offpeak).toBeGreaterThan(0)
    expect(value.byTariff.peak).toBe(0)
  })

  it('counts an unpriced model without inventing money for it', () => {
    const value = priced(fold([
      stepStart(before),
      header(before, 'mystery-model'),
      message(before + 10, 'mystery-model', usage(500, 0, 500)),
    ]))
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
    const value = priced(session())
    expect(value.byBucket.miss + value.byBucket.hit + value.byBucket.out).toBeCloseTo(value.cost, 10)
    expect(value.byBucket.hit).toBeGreaterThan(0)
  })

  it('prices the counterfactuals off the same tokens', () => {
    const value = priced(session())
    expect(value.counterfactual.peak).toBeCloseTo(value.counterfactual.offpeak * 2, 8)
    expect(value.counterfactual.offpeak).toBeCloseTo(value.cost, 10)
    // Every cache hit repriced as a miss: strictly more expensive.
    expect(value.counterfactual.noCache).toBeGreaterThan(value.cost)
  })

  it('prices both published rate cards, never converting between them', () => {
    const value = view(session())
    expect(Object.keys(value.money).sort()).toEqual(['cny', 'usd'])
    // The two tables are independent, so neither is a fixed multiple of the other.
    expect(value.money.cny.cost).toBeGreaterThan(value.money.usd.cost)
    expect(value.money.usd.byBucket.hit).toBeGreaterThan(0)
    expect(value.preferred).toBe('auto')
    expect(view(session(), 'cny').preferred).toBe('cny')
  })

  it('passes its own schema, and rejects a broken fold', () => {
    const value = view(session())
    expect(() => schema.parse(value)).not.toThrow()
    expect(() => schema.parse({ ...value, money: { ...value.money, usd: { ...value.money.usd, cost: Number.NaN } } }))
      .toThrow(/money.usd.cost/)
    expect(() => schema.parse({ ...value, money: { usd: value.money.usd } })).toThrow(/money.cny/)
    expect(() => schema.parse({ requests: 1, models: [] })).toThrow()
  })

  it('is plain JSON, as the persisted projection cache requires', () => {
    const state = session()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
    const value = view(state)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })
})
