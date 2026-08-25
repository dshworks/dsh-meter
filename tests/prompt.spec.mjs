import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PEAK_PROMPT,
  PEAK_WINDOWS_UTC,
  TIME_OF_USE_FROM,
  WEEKEND_OFFPEAK_FROM,
  peakHoursPhrase,
  tariffPrompt,
} from '../lib/core.js'

const utc = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute)

// Every instant here is after WEEKEND_OFFPEAK_FROM, and every weekday is named
// in the comment, because "a peak hour" stopped being a property of the clock
// alone on 2026-08-22 and a fixture that does not say which day it is cannot
// tell a passing test from a lucky one.
const inPeak = utc(2026, 8, 26, 2) // Wednesday, inside 01:00-04:00 UTC
const inGap = utc(2026, 8, 26, 5) // Wednesday, inside the 04:00-06:00 gap
const offPeak = utc(2026, 8, 26, 12) // Wednesday, outside both windows
const saturday = utc(2026, 8, 29, 2) // peak hour, Saturday — off-peak since the weekend rule
const sunday = utc(2026, 8, 30, 7) // peak hour, Sunday — likewise
const flat = TIME_OF_USE_FROM - 1 // before the switchover

describe('tariffPrompt', () => {
  it('is silent when saving mode is off, whatever the tariff', () => {
    expect(tariffPrompt(inPeak, { mode: false })).toBe('')
    expect(tariffPrompt(inPeak, {})).toBe('')
    expect(tariffPrompt(inPeak, { mode: false, peak: 'nudge' })).toBe('')
  })

  it('warns with the built-in nudge inside a peak window', () => {
    const text = tariffPrompt(inPeak, { mode: true })
    expect(text).toBe(DEFAULT_PEAK_PROMPT)
    expect(text).toMatch(/peak/i)
    // The nudge names the published windows, so the model can reason about
    // when it is allowed to spend again instead of guessing.
    for (const [start, end] of PEAK_WINDOWS_UTC) {
      expect(text).toContain(`${String(start).padStart(2, '0')}:00-${String(end).padStart(2, '0')}:00`)
    }
  })

  it('uses a custom peak nudge verbatim', () => {
    expect(tariffPrompt(inPeak, { mode: true, peak: 'peak! be cheap' })).toBe('peak! be cheap')
  })

  it('is silent off-peak unless an off-peak note is configured', () => {
    expect(tariffPrompt(offPeak, { mode: true })).toBe('')
    expect(tariffPrompt(inGap, { mode: true })).toBe('')
    expect(tariffPrompt(offPeak, { mode: true, offpeak: 'off-peak, spend freely' })).toBe('off-peak, spend freely')
    expect(tariffPrompt(inGap, { mode: true, offpeak: 'off-peak, spend freely' })).toBe('off-peak, spend freely')
  })

  it('does not cry peak on a weekend, even inside a peak hour', () => {
    // The nudge asks the model to spend less. Asking for that on a day that
    // bills at the off-peak rate is a plugin lying to a model about money.
    expect(saturday).toBeGreaterThan(WEEKEND_OFFPEAK_FROM)
    expect(tariffPrompt(saturday, { mode: true })).toBe('')
    expect(tariffPrompt(sunday, { mode: true })).toBe('')
    expect(tariffPrompt(saturday, { mode: true, offpeak: 'cheap day' })).toBe('cheap day')
  })

  it('never speaks under the retired flat tariff', () => {
    expect(tariffPrompt(flat, { mode: true })).toBe('')
    expect(tariffPrompt(flat, { mode: true, peak: 'nudge', offpeak: 'note' })).toBe('')
  })

  it('keeps the text constant inside a tariff window, so the cache prefix holds', () => {
    // The whole point of a static default: any time-varying text would roll
    // the session's prompt-prefix cache on every minute boundary.
    const start = tariffPrompt(utc(2026, 8, 26, 1, 1), { mode: true })
    const end = tariffPrompt(utc(2026, 8, 26, 3, 59), { mode: true })
    expect(start).toBe(DEFAULT_PEAK_PROMPT)
    expect(end).toBe(DEFAULT_PEAK_PROMPT)
  })
})

describe('peakHoursPhrase', () => {
  it('spells the schedule the meter is actually in', () => {
    expect(peakHoursPhrase()).toBe('01:00-04:00 and 06:00-10:00 UTC, Monday to Friday')
  })

  it('is derived, so the nudge cannot outlive the schedule', () => {
    // The failure this guards is the one a sibling project shipped: the
    // weekend rule reached the table and not the sentence, and the sentence
    // went on telling readers peak ran daily. Asserting the phrase appears
    // verbatim in the default prompt means one edit to the windows fails
    // here rather than shipping a prompt that contradicts the bill.
    expect(DEFAULT_PEAK_PROMPT).toContain(peakHoursPhrase())
  })
})
