import { describe, expect, it } from 'vitest'
import { DEFAULT_PEAK_PROMPT, PEAK_WINDOWS_UTC, TIME_OF_USE_FROM, tariffPrompt } from '../lib/core.js'

const utc = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute)

const inPeak = utc(2026, 8, 17, 2) // inside 01:00-04:00 UTC
const inGap = utc(2026, 8, 17, 5) // inside the 04:00-06:00 gap between the two windows
const offPeak = utc(2026, 8, 17, 12) // outside both windows
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

  it('never speaks under the retired flat tariff', () => {
    expect(tariffPrompt(flat, { mode: true })).toBe('')
    expect(tariffPrompt(flat, { mode: true, peak: 'nudge', offpeak: 'note' })).toBe('')
  })

  it('keeps the text constant inside a tariff window, so the cache prefix holds', () => {
    // The whole point of a static default: any time-varying text would roll
    // the session's prompt-prefix cache on every minute boundary.
    const start = tariffPrompt(utc(2026, 8, 17, 1, 1), { mode: true })
    const end = tariffPrompt(utc(2026, 8, 17, 3, 59), { mode: true })
    expect(start).toBe(DEFAULT_PEAK_PROMPT)
    expect(end).toBe(DEFAULT_PEAK_PROMPT)
  })
})
