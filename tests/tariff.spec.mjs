import { describe, expect, it } from 'vitest'
import {
  CACHE_DISCOUNT, CURRENCY_SYMBOL, PEAK_WINDOWS_UTC, RATES, TIME_OF_USE_FROM,
  bucketCostOf, costOf, formatCountdown, formatMoney, formatTokens,
  nextTariffChange, tariffAt, tariffSchedule,
} from '../lib/core.js'

const utc = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute)

describe('the published rate card', () => {
  it('carries both platforms of both models at all three tariffs', () => {
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      for (const tariff of ['flat', 'offpeak', 'peak']) {
        for (const currency of ['usd', 'cny']) {
          const rate = RATES[model][tariff][currency]
          expect(rate.hit).toBeGreaterThan(0)
          expect(rate.miss).toBeGreaterThan(rate.hit)
          expect(rate.out).toBeGreaterThan(rate.miss)
        }
      }
    }
  })

  it('prices off-peak at exactly half of peak, as DeepSeek states', () => {
    for (const model of Object.keys(RATES)) {
      for (const currency of ['usd', 'cny']) {
        const peak = RATES[model].peak[currency]
        const offpeak = RATES[model].offpeak[currency]
        for (const bucket of ['hit', 'miss', 'out']) {
          expect(offpeak[bucket]).toBeCloseTo(peak[bucket] / 2, 10)
        }
      }
    }
  })

  it('never claims a bigger cache discount than the cheapest live row gives', () => {
    // The card tells the user a hit bills at 1/CACHE_DISCOUNT of a miss. If any
    // billed row is stingier than that, the claim over-promises and the number
    // has to come down — which is the whole reason it is derived, not typed.
    for (const model of Object.keys(RATES)) {
      for (const tariff of ['offpeak', 'peak']) {
        for (const currency of ['usd', 'cny']) {
          const rate = RATES[model][tariff][currency]
          expect(rate.miss / rate.hit).toBeGreaterThanOrEqual(CACHE_DISCOUNT)
        }
      }
    }
    expect(CACHE_DISCOUNT).toBe(30)
  })

  it('makes every new rate higher than the flat rate it replaces', () => {
    for (const model of Object.keys(RATES)) {
      for (const currency of ['usd', 'cny']) {
        for (const bucket of ['hit', 'miss', 'out']) {
          expect(RATES[model].offpeak[currency][bucket]).toBeGreaterThan(RATES[model].flat[currency][bucket])
        }
      }
    }
  })
})

describe('tariffAt', () => {
  it('bills everything before the switchover at the flat rate', () => {
    expect(tariffAt(TIME_OF_USE_FROM - 1)).toBe('flat')
    expect(tariffAt(utc(2026, 8, 16, 2))).toBe('flat')
  })

  it('bills the two published peak windows at peak', () => {
    expect(tariffAt(utc(2026, 8, 17, 1))).toBe('peak')
    expect(tariffAt(utc(2026, 8, 17, 3, 59))).toBe('peak')
    expect(tariffAt(utc(2026, 8, 17, 6))).toBe('peak')
    expect(tariffAt(utc(2026, 8, 17, 9, 59))).toBe('peak')
  })

  it('treats a window as closed at its end hour, including the gap between the two', () => {
    expect(tariffAt(utc(2026, 8, 17, 0, 59))).toBe('offpeak')
    expect(tariffAt(utc(2026, 8, 17, 4))).toBe('offpeak')
    expect(tariffAt(utc(2026, 8, 17, 5, 59))).toBe('offpeak')
    expect(tariffAt(utc(2026, 8, 17, 10))).toBe('offpeak')
    expect(tariffAt(utc(2026, 8, 17, 23, 59))).toBe('offpeak')
  })

  it('switches exactly at 16:00 UTC on 2026-08-16', () => {
    expect(TIME_OF_USE_FROM).toBe(utc(2026, 8, 16, 16))
    expect(tariffAt(TIME_OF_USE_FROM)).toBe('offpeak')
  })

  // The switchover is behind us, so `flat` is history-only: it must never
  // price a request being made now. This is the guard against someone
  // pushing TIME_OF_USE_FROM forward and quietly under-billing the live
  // card, which is the one bug here that costs a user real money.
  it('never bills a request made now at the retired flat rate', () => {
    expect(Date.now()).toBeGreaterThan(TIME_OF_USE_FROM)
    expect(tariffAt(Date.now())).not.toBe('flat')
  })
})

describe('nextTariffChange', () => {
  it('points at the switchover itself while the flat rate still applies', () => {
    const change = nextTariffChange(utc(2026, 8, 15, 12))
    expect(change).toEqual({ tariff: 'flat', next: 'offpeak', at: TIME_OF_USE_FROM })
  })

  it('finds the next boundary within the day', () => {
    expect(nextTariffChange(utc(2026, 8, 17, 0, 30))).toEqual({ tariff: 'offpeak', next: 'peak', at: utc(2026, 8, 17, 1) })
    expect(nextTariffChange(utc(2026, 8, 17, 2))).toEqual({ tariff: 'peak', next: 'offpeak', at: utc(2026, 8, 17, 4) })
    expect(nextTariffChange(utc(2026, 8, 17, 5))).toEqual({ tariff: 'offpeak', next: 'peak', at: utc(2026, 8, 17, 6) })
    expect(nextTariffChange(utc(2026, 8, 17, 9))).toEqual({ tariff: 'peak', next: 'offpeak', at: utc(2026, 8, 17, 10) })
  })

  it('rolls to tomorrow past the last boundary of the UTC day', () => {
    expect(nextTariffChange(utc(2026, 8, 17, 22))).toEqual({ tariff: 'offpeak', next: 'peak', at: utc(2026, 8, 18, 1) })
  })

  it('never returns a boundary in the past', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = utc(2026, 8, 20, hour, 37)
      expect(nextTariffChange(now).at).toBeGreaterThan(now)
    }
  })
})

describe('tariffSchedule', () => {
  it('labels 24 hours from the published windows, independent of the switchover date', () => {
    const day = tariffSchedule()
    expect(day).toHaveLength(24)
    expect(day.filter(hour => hour === 'peak')).toHaveLength(
      PEAK_WINDOWS_UTC.reduce((total, [start, end]) => total + (end - start), 0),
    )
    expect(day[0]).toBe('offpeak')
    expect(day[1]).toBe('peak')
    expect(day[4]).toBe('offpeak')
    expect(day[6]).toBe('peak')
    expect(day[10]).toBe('offpeak')
  })
})

describe('costOf', () => {
  const million = { miss: 1_000_000, hit: 0, out: 0 }

  it('prices a million cache-miss input tokens at the published miss rate', () => {
    expect(costOf(million, 'deepseek-v4-flash', 'flat', 'usd')).toBeCloseTo(0.14, 10)
    expect(costOf(million, 'deepseek-v4-pro', 'peak', 'cny')).toBeCloseTo(9, 10)
  })

  it('charges nothing for a model with no published rate', () => {
    expect(costOf(million, 'some-other-model', 'flat', 'usd')).toBe(0)
    expect(bucketCostOf(million, 'some-other-model', 'flat', 'usd')).toEqual({ miss: 0, hit: 0, out: 0 })
  })

  it('splits into buckets that sum to the total', () => {
    const tokens = { miss: 120_000, hit: 900_000, out: 30_000 }
    const split = bucketCostOf(tokens, 'deepseek-v4-pro', 'offpeak', 'usd')
    expect(split.miss + split.hit + split.out).toBeCloseTo(costOf(tokens, 'deepseek-v4-pro', 'offpeak', 'usd'), 12)
  })
})

describe('display helpers', () => {
  it('keeps four decimals on sub-unit amounts and two above', () => {
    expect(formatMoney(0.014278, 'usd')).toBe('$0.0143')
    expect(formatMoney(1.5, 'usd')).toBe('$1.50')
    expect(formatMoney(0, 'cny')).toBe('¥0')
    expect(formatMoney(0.00001, 'usd')).toBe('<$0.0001')
    expect(CURRENCY_SYMBOL.cny).toBe('¥')
  })

  it('scales token counts the way the harness stats line does', () => {
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(12_240)).toBe('12.2K')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('reads a countdown coarsely', () => {
    expect(formatCountdown(45_000)).toBe('45s')
    expect(formatCountdown(12 * 60_000)).toBe('12m')
    expect(formatCountdown(3 * 3_600_000 + 20 * 60_000)).toBe('3h20m')
    expect(formatCountdown(50 * 3_600_000)).toBe('2d')
    expect(formatCountdown(-1)).toBe('0s')
  })
})
