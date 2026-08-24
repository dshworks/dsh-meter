/**
 * Reading the schedule, and the rate card's own number format.
 *
 * These cover the two things the surfaces get wrong silently. `tariffSchedule`
 * grew a day axis when weekends went off-peak — 24 entries became a 7x24 grid —
 * and its only consumer went on indexing it by UTC hour. Every cell came back
 * `undefined`, nothing compared equal to `'peak'`, and the tariff strip drew a
 * flat off-peak day on a Tuesday afternoon. No throw, no warning: a wrong
 * picture is the only symptom a schedule bug has.
 *
 * So the assertions here are about the *shape and content* of what a cell
 * holds, not just that a call returns. A test that only checked `length === 24`
 * would have passed throughout the outage.
 */
import { describe, expect, it } from 'vitest'
import {
  CURRENCY_SYMBOL,
  PEAK_WINDOWS_UTC,
  RATES,
  TARIFFS,
  formatRate,
  localMidnight,
  localTariffDays,
  localWeekStart,
  tariffAt,
} from '../lib/core.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A Beijing weekday well after the weekend rule started. */
const WEEKDAY = Date.UTC(2026, 7, 25, 2, 0, 0)   // Tue 2026-08-25 10:00 Beijing
/** A Beijing Saturday, likewise. */
const WEEKEND = Date.UTC(2026, 7, 29, 2, 0, 0)   // Sat 2026-08-29 10:00 Beijing

describe('localTariffDays', () => {
  it('yields tariff names, never rows and never undefined', () => {
    // The exact regression: indexing the 7x24 grid by hour handed back a row
    // array for hours 0-6 and undefined for the rest, and both are silently
    // "not peak" to a template.
    const [day] = localTariffDays(localMidnight(WEEKDAY), 1)
    expect(day).toHaveLength(24)
    for (const cell of day) {
      expect(typeof cell, `cell was ${JSON.stringify(cell)}`).toBe('string')
      expect(TARIFFS).toContain(cell)
    }
  })

  it('finds peak hours on a weekday', () => {
    // The visible symptom of the outage: an all-off-peak strip, every day.
    const [day] = localTariffDays(localMidnight(WEEKDAY), 1)
    expect(day.filter(tariff => tariff === 'peak').length).toBeGreaterThan(0)
  })

  it('agrees with tariffAt cell for cell', () => {
    const from = localMidnight(WEEKDAY)
    const rows = localTariffDays(from, 7)
    rows.forEach((day, index) => {
      day.forEach((cell, hour) => {
        expect(cell).toBe(tariffAt(from + (index * DAY) + ((hour + 0.5) * HOUR)))
      })
    })
  })

  it('reads a cell at the middle of its hour, so a half-hour zone lands right', () => {
    // Sampling on the boundary would put an hour that starts at a window edge
    // on the wrong side of it for any zone offset by 30 or 45 minutes.
    const from = localMidnight(WEEKDAY)
    const [day] = localTariffDays(from, 1)
    expect(day[0]).toBe(tariffAt(from + (HOUR / 2)))
  })

  it('lays out as many days as asked', () => {
    expect(localTariffDays(localMidnight(WEEKDAY), 7)).toHaveLength(7)
    expect(localTariffDays(localMidnight(WEEKDAY), 1)).toHaveLength(1)
  })

  it('bills a Beijing weekend off-peak all day', () => {
    const beijingMidnight = Date.UTC(2026, 7, 28, 16, 0, 0)   // Sat 2026-08-29 00:00 Beijing
    const [saturday] = localTariffDays(beijingMidnight, 1)
    expect(saturday.every(tariff => tariff === 'offpeak')).toBe(true)
    expect(tariffAt(WEEKEND)).toBe('offpeak')
  })

  it('counts 35 peak hours in any week, which is the published claim', () => {
    // Peak is 35 hours a week, not 49: two windows totalling 7 hours, on five
    // Beijing weekdays. The pattern is weekly-periodic, so any 168-hour window
    // holds exactly 35 — which makes this independent of the runner's timezone.
    const hours = localTariffDays(localWeekStart(WEEKDAY), 7).flat()
    expect(hours).toHaveLength(168)
    expect(hours.filter(tariff => tariff === 'peak')).toHaveLength(35)
  })

  it('puts the same count in a week offset from the Beijing week', () => {
    const shifted = localTariffDays(localWeekStart(WEEKDAY) + (13 * HOUR), 7).flat()
    expect(shifted.filter(tariff => tariff === 'peak')).toHaveLength(35)
  })
})

describe('localWeekStart', () => {
  it('lands on a local Monday midnight', () => {
    const start = new Date(localWeekStart(WEEKDAY))
    expect(start.getDay()).toBe(1)
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getSeconds()).toBe(0)
  })

  it('keeps a Sunday in the week that just ran, not the one starting', () => {
    // getDay() calls Sunday 0; a naive subtraction sends it forward a week.
    const sunday = localWeekStart(WEEKDAY) + (6 * DAY) + (12 * HOUR)
    expect(localWeekStart(sunday)).toBe(localWeekStart(WEEKDAY))
  })

  it('is stable across every instant inside one week', () => {
    const start = localWeekStart(WEEKDAY)
    for (let hour = 0; hour < 168; hour++) {
      expect(localWeekStart(start + (hour * HOUR) + (HOUR / 2))).toBe(start)
    }
  })
})

describe('formatRate', () => {
  it('prints a published rate at the precision it was published', () => {
    // formatMoney pads a computed total to a fixed width; a rate card is a
    // quotation, and `¥1.50` beside `¥0.0500` invents precision and puts two
    // decimal conventions in one column.
    expect(formatRate(0.05, 'cny')).toBe('¥0.05')
    expect(formatRate(1.5, 'cny')).toBe('¥1.5')
    expect(formatRate(27, 'cny')).toBe('¥27')
    expect(formatRate(0.0028, 'usd')).toBe('$0.0028')
    expect(formatRate(0.435, 'usd')).toBe('$0.435')
  })

  it('reproduces every live cell of the card exactly as the table holds it', () => {
    for (const [model, byTariff] of Object.entries(RATES)) {
      for (const tariff of ['offpeak', 'peak']) {
        for (const [currency, buckets] of Object.entries(byTariff[tariff])) {
          for (const [bucket, rate] of Object.entries(buckets)) {
            expect(formatRate(rate, currency), `${model} ${tariff} ${currency} ${bucket}`)
              .toBe(`${CURRENCY_SYMBOL[currency]}${rate}`)
          }
        }
      }
    }
  })

  it('drops an unknown currency symbol rather than inventing one', () => {
    expect(formatRate(1.5, 'eur')).toBe('1.5')
  })
})

describe('the published windows', () => {
  it('still totals seven peak hours a day', () => {
    const total = PEAK_WINDOWS_UTC.reduce((sum, [start, end]) => sum + (end - start), 0)
    expect(total).toBe(7)
    expect(total * 5).toBe(35)
  })
})
