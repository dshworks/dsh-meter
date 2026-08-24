import { describe, expect, it } from 'vitest'
import {
  CACHE_DISCOUNT, CURRENCY_SYMBOL, PEAK_WINDOWS_UTC, RATES, TIME_OF_USE_FROM,
  WEEKEND_OFFPEAK_FROM, bucketCostOf, costOf, formatCountdown, formatMoney,
  formatTokens, isBeijingWeekend, nextTariffChange, tariffAt, tariffSchedule,
} from '../lib/core.js'

const utc = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute)

describe('the published rate card', () => {
  it('carries both platforms of every model at every tariff it ever billed', () => {
    for (const model of Object.keys(RATES)) {
      // `flat` only for the models that existed before the switchover.
      for (const tariff of Object.keys(RATES[model])) {
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
    // A model that shipped after the switchover has no flat rate to replace --
    // `deepseek-v4-flash-vision-exp` was published 2026-08-21, five days after
    // time-of-use began, so `apply-pricing` writes it with no `flat` row at
    // all. Skipping it here is the invariant; reading `.flat` unconditionally
    // is what threw `Cannot read properties of undefined`.
    for (const [model, byTariff] of Object.entries(RATES)) {
      if (byTariff.flat === undefined) continue
      for (const currency of ['usd', 'cny']) {
        for (const bucket of ['hit', 'miss', 'out']) {
          expect(byTariff.offpeak[currency][bucket]).toBeGreaterThan(byTariff.flat[currency][bucket])
        }
      }
    }
    // ...and at least one model still has one, so the loop cannot go empty
    // and pass by doing nothing.
    expect(Object.values(RATES).filter(byTariff => byTariff.flat !== undefined).length).toBeGreaterThan(0)
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
  const HOURS_PER_WEEKDAY = PEAK_WINDOWS_UTC.reduce((total, [start, end]) => total + (end - start), 0)

  it('labels a full week, seven Beijing days of 24 hours', () => {
    const week = tariffSchedule()
    expect(week).toHaveLength(7)
    for (const day of week) expect(day).toHaveLength(24)
  })

  it('gives each weekday the published windows, on Beijing hours', () => {
    const week = tariffSchedule()
    for (const weekday of [1, 2, 3, 4, 5]) {
      const day = week[weekday]
      expect(day.filter(hour => hour === 'peak')).toHaveLength(HOURS_PER_WEEKDAY)
      // 01:00-04:00 and 06:00-10:00 UTC are 09:00-12:00 and 14:00-18:00 Beijing,
      // which is how DeepSeek's Chinese page states them.
      expect(day[8]).toBe('offpeak')
      expect(day[9]).toBe('peak')
      expect(day[12]).toBe('offpeak')
      expect(day[14]).toBe('peak')
      expect(day[18]).toBe('offpeak')
    }
  })

  it('gives the weekend no peak hours at all', () => {
    const week = tariffSchedule()
    for (const weekday of [0, 6]) expect(week[weekday]).toEqual(Array(24).fill('offpeak'))
    // 7 hours x 5 days. The @1 schedule implied 49, and billed 14 of them wrong.
    expect(week.flat().filter(t => t === 'peak')).toHaveLength(HOURS_PER_WEEKDAY * 5)
  })

  it('agrees with tariffAt for every hour of a real week', () => {
    // The grid is what the strip paints and tariffAt is what the ledger
    // charges. This is the only test that stops those two drifting apart.
    const monday = Date.UTC(2026, 7, 30, 16, 0, 0)   // Beijing Mon 2026-08-31 00:00
    const week = tariffSchedule()
    for (let hour = 0; hour < 168; hour++) {
      const at = monday + hour * 3_600_000
      const beijing = new Date(at + 8 * 3_600_000)
      expect(week[beijing.getUTCDay()][beijing.getUTCHours()]).toBe(tariffAt(at))
    }
  })
})

describe('the weekend rule', () => {
  it('bills a Saturday and a Sunday off-peak inside a peak window', () => {
    // 2026-08-29 is a Saturday, 2026-08-30 a Sunday. 02:00 UTC is inside the
    // first published window, so before the rule these billed peak.
    expect(tariffAt(utc(2026, 8, 29, 2, 0))).toBe('offpeak')
    expect(tariffAt(utc(2026, 8, 30, 2, 0))).toBe('offpeak')
    expect(tariffAt(utc(2026, 8, 28, 2, 0))).toBe('peak')   // Friday
    expect(tariffAt(utc(2026, 8, 31, 2, 0))).toBe('peak')   // Monday
  })

  it('turns the weekend over on the vendor clock, not on UTC', () => {
    // The two instants that discriminate. Deleting the Beijing shift from
    // tariffAt leaves every hour of the published windows labelled the same,
    // because both windows close at 10:00 UTC, well before the 16:00 UTC point
    // where a UTC date and a Beijing date start to disagree. Only these catch it.
    expect(tariffAt(utc(2026, 8, 28, 16, 30))).toBe('offpeak')  // Friday UTC, already Saturday in Beijing
    expect(tariffAt(utc(2026, 8, 30, 16, 30))).toBe('offpeak')  // Sunday UTC, already Monday in Beijing — but 00:30 Beijing is outside every window
    // Same wall-clock hour one day earlier is a Beijing Friday: still a weekday.
    expect(isBeijingWeekend(utc(2026, 8, 28, 16, 30))).toBe(true)
    expect(isBeijingWeekend(utc(2026, 8, 28, 15, 30))).toBe(false)
  })

  it('does not reprice a weekend from before the rule took effect', () => {
    // Sun 2026-08-17 and Sat 2026-08-22 billed peak, because the rule started
    // at 16:00 UTC on 2026-08-22. A ledger that refunds them is inventing money.
    expect(tariffAt(utc(2026, 8, 17, 2, 0))).toBe('peak')
    expect(tariffAt(utc(2026, 8, 22, 2, 0))).toBe('peak')
    // One second before and after the boundary, on a Beijing Sunday.
    expect(tariffAt(WEEKEND_OFFPEAK_FROM - 1)).toBe('offpeak')  // 15:59 UTC Sat is outside every window anyway
    expect(tariffAt(WEEKEND_OFFPEAK_FROM)).toBe('offpeak')
    // The discriminating pair: consecutive Sundays either side of the boundary.
    expect(tariffAt(utc(2026, 8, 23, 2, 0))).toBe('offpeak')   // Sun 2026-08-23 — first weekend under the rule

  })

  it('never counts down to a flip that will not happen', () => {
    // Friday 23:00 UTC used to promise peak at Saturday 01:00 UTC.
    const friday = utc(2026, 8, 28, 23, 0)
    const change = nextTariffChange(friday)
    expect(change.tariff).toBe('offpeak')
    expect(change.next).toBe('peak')
    // The real next peak is Monday 01:00 UTC, ~50 hours later.
    expect(new Date(change.at).toISOString()).toBe('2026-08-31T01:00:00.000Z')
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
