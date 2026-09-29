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
 * `order`, `text` (string or a per-assembly provider), `interpolate` — and
 * renders them the way `renderPrompt` does: strict `{{name}}` interpolation
 * unless `interpolate: false`, then empty sections dropped with
 * `.filter(text => text.length > 0)`. A stand-in that skipped interpolation
 * would pass a section whose text makes every real assembly throw.
 *
 * Re-derived from the harness source at dsh 0.1.7-rc.2
 * (packages/core/system-prompt/src/index.ts: `section()`, `renderPrompt`,
 * `interpolate`). If a later rc changes the shape, this test is what turns red
 * instead of the prompt going quiet.
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

/** `renderPrompt`'s reference grammar, copied from dsh-system-prompt 0.1.7-rc.2. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/**
 * `interpolate()` as the registry runs it: every complete `{{name}}` group must
 * name a registered variable, a malformed group throws, and a lone `{{` with no
 * later `}}` is prose. The meter registers no variables, so none are passed.
 */
const interpolate = (name, text, variables = {}) => {
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) throw new Error(`malformed prompt variable reference in section "${name}"`)
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const variable = group[1]
    if (!VARIABLE_NAME.test(variable)) throw new Error(`malformed prompt variable reference "{{${variable}}}" in section "${name}"`)
    if (!Object.hasOwn(variables, variable)) throw new Error(`unknown prompt variable "{{${variable}}}" in section "${name}"`)
    result += text.slice(last, open) + variables[variable]
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** What the registry puts in front of the model: `renderPrompt` over this one section. */
const rendered = (section, now) => {
  const original = Date.now
  Date.now = () => now
  try {
    const text = typeof section.text === 'function' ? section.text({}) : section.text
    const output = section.interpolate === false ? text : interpolate(section.name, text)
    return [output].filter(t => t.length > 0).join('\n\n')
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
