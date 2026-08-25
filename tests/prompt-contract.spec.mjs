/**
 * The saving-mode registration contract, driven through a stand-in registry.
 *
 * The lesson this file exists on: the session-projection registry renamed its
 * fields in 0.1.1-rc.1 and the meter's dock line silently stopped rendering —
 * no error, no log, only a wrong picture. A prompt section can fail the same
 * way, and worse, because nothing on screen changes when it does: the model
 * simply never hears about the tariff.
 *
 * So this drives `apply()` through a stand-in `systemPrompt` that reads exactly
 * the fields the published `@deepseek-ai/dsh-system-prompt` reads — `name`,
 * `order`, `text` (string or a per-assembly provider) — and asserts a real
 * string comes out the far end, including the empty one, which the registry
 * drops with `.filter(text => text.length > 0)` in `renderPrompt`.
 *
 * Checked against the harness source at dsh 0.1.0-rc.8. If a later rc changes
 * the shape, this test is what turns red instead of the prompt going quiet.
 */
import { describe, expect, it } from 'vitest'
import { apply as applyPlugin } from '../lib/index.js'
import { DEFAULT_PEAK_PROMPT } from '../lib/core.js'

const utc = (year, month, day, hour) => Date.UTC(year, month - 1, day, hour)
const PEAK_WEEKDAY = utc(2026, 8, 26, 2) // Wednesday, inside 01:00-04:00 UTC
const OFFPEAK_WEEKDAY = utc(2026, 8, 26, 12) // Wednesday, outside both windows
const PEAK_HOUR_SATURDAY = utc(2026, 8, 29, 2) // peak hour, but a weekend

/**
 * Capture the section the plugin registers. `services` is what the plugin asks
 * for; a stand-in that answered every inject would hide a plugin that asked
 * for the wrong service name.
 */
const registeredSection = (config = {}) => {
  let captured
  const ctx = {
    inject: (services, callback) => {
      if (!services.includes('systemPrompt')) return
      callback({ systemPrompt: { section: (definition) => { captured = definition } } })
    },
    get: () => undefined,
  }
  applyPlugin(ctx, { currency: 'auto', balance: false, savingMode: false, savingPeakPrompt: DEFAULT_PEAK_PROMPT, savingOffPeakPrompt: '', ...config })
  return captured
}

/** What the registry puts in front of the model, empty sections dropped. */
const rendered = (section, now) => {
  const original = Date.now
  Date.now = () => now
  try {
    const text = typeof section.text === 'function' ? section.text({}) : section.text
    return [text].filter(t => t.length > 0).join('\n\n')
  } finally {
    Date.now = original
  }
}

describe('meter:tariff registration', () => {
  it('registers one named, ordered section', () => {
    const section = registeredSection()
    expect(section, 'the plugin registered no prompt section').toBeDefined()
    expect(section.name).toBe('meter:tariff')
    expect(Number.isFinite(section.order), 'a non-finite order is a TypeError in the registry').toBe(true)
    // Before the deployment persona would put a cost note above the operator's
    // own instructions; tool guidance is 100+.
    expect(section.order).toBeGreaterThan(0)
    expect(section.order).toBeLessThan(100)
  })

  it('is a provider, not a string, so it is re-read at every assembly', () => {
    // A static string would be resolved once at registration and then lie for
    // the rest of the session — which is every hour but the one it booted in.
    expect(typeof registeredSection().text).toBe('function')
  })

  it('renders nothing at all while saving mode is off', () => {
    const section = registeredSection({ savingMode: false })
    expect(rendered(section, PEAK_WEEKDAY)).toBe('')
    expect(rendered(section, OFFPEAK_WEEKDAY)).toBe('')
  })

  it('renders the nudge in a peak window and nothing outside it', () => {
    const section = registeredSection({ savingMode: true })
    expect(rendered(section, PEAK_WEEKDAY)).toBe(DEFAULT_PEAK_PROMPT)
    expect(rendered(section, OFFPEAK_WEEKDAY)).toBe('')
    expect(rendered(section, PEAK_HOUR_SATURDAY), 'weekends bill off-peak all day').toBe('')
  })

  it('mounts on a composition with no systemPrompt service', () => {
    // Headless and ACP profiles have no prompt registry. The projection
    // registration takes the same shape for the same reason.
    const ctx = { inject: () => {}, get: () => undefined }
    expect(() => applyPlugin(ctx, { currency: 'auto', balance: false, savingMode: true, savingPeakPrompt: DEFAULT_PEAK_PROMPT, savingOffPeakPrompt: '' })).not.toThrow()
  })
})
