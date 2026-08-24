/**
 * The registration contract, against both spellings of it.
 *
 * `@deepseek-ai/dsh-session-projection` 0.1.1-rc.1 renamed the definition's
 * fields — `schema` became `stateSchema`, and the top-level `view` moved into
 * an OPTIONAL `wire: { viewSchema, view }`. The registry reads those fields
 * without validating the definition, so under the new registry the old
 * spelling reads as "this projection is host-only": no error, no log line, and
 * no value on the wire — the dock line simply stops rendering.
 *
 * These tests drive the registration through a stand-in registry of each era
 * and assert a client-visible value comes out of both. A stand-in weaker than
 * the real registry would miss the bug again, so each one reads exactly the
 * fields its published `lib/index.js` reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply as applyPlugin } from '../lib/index.js'
import { foldEvent, init, stateSchema } from '../lib/core.js'

const utc = (year, month, day, hour) => Date.UTC(year, month - 1, day, hour)

const event = (type, time, data) => ({ type, seq: 0, time, data })

/** One priced request, enough to make the dock line non-empty. */
const oneRequest = () => {
  const at = utc(2026, 8, 20, 12)
  let state = init()
  state = foldEvent(state, event('step/start', at, { turn: 0, step: 0 }))
  state = foldEvent(state, event('request/header', at, {
    header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
    reason: 'initial',
  }))
  state = foldEvent(state, event('assistant/message', at, {
    turn: 0,
    step: 0,
    message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' } },
    usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 },
  }))
  return state
}

/**
 * Capture the definition the plugin registers, with the balance route off so
 * the projection is the only contribution under test.
 */
const registeredDefinition = () => {
  let captured
  const ctx = {
    inject: (services, callback) => {
      if (!services.includes('sessionProjections')) return
      callback({ sessionProjections: { register: definition => { captured = definition } } })
    },
    get: () => undefined,
  }
  applyPlugin(ctx, { currency: 'auto', balance: false })
  expect(captured, 'the plugin registered no projection').toBeDefined()
  return captured
}

/** The registry as published up to 0.1.0-rc.8: `schema` validates `view(state)`. */
const wireValueUnderOldRegistry = (definition, state) => definition.schema.parse(definition.view(state))

/** The registry from 0.1.1-rc.1: a value reaches the client only through `wire`. */
const wireValueUnderNewRegistry = (definition, state) => {
  if (definition.wire === undefined) return undefined
  return definition.wire.viewSchema.parse(definition.wire.view(state))
}

describe('costMeter registration', () => {
  it('reaches the client under the pre-0.1.1 registry', () => {
    const value = wireValueUnderOldRegistry(registeredDefinition(), oneRequest())
    expect(value.requests).toBe(1)
    expect(value.money.usd.cost).toBeGreaterThan(0)
  })

  it('reaches the client under the 0.1.1-rc.1 registry', () => {
    const value = wireValueUnderNewRegistry(registeredDefinition(), oneRequest())
    // The regression: `wire` absent means host-only, and the dock renders null.
    expect(value, 'no wire contribution — the dock line would render nothing').toBeDefined()
    expect(value.requests).toBe(1)
    expect(value.money.usd.cost).toBeGreaterThan(0)
  })

  it('shows the same value through either spelling', () => {
    const definition = registeredDefinition()
    const state = oneRequest()
    expect(wireValueUnderNewRegistry(definition, state))
      .toEqual(wireValueUnderOldRegistry(definition, state))
  })

  it('honours the configured currency through the new wire', () => {
    let captured
    const ctx = {
      inject: (services, callback) => {
        if (!services.includes('sessionProjections')) return
        callback({ sessionProjections: { register: definition => { captured = definition } } })
      },
      get: () => undefined,
    }
    applyPlugin(ctx, { currency: 'cny', balance: false })
    expect(captured.wire.view(oneRequest()).preferred).toBe('cny')
  })

  it('restores a checkpoint the new registry parses with stateSchema', () => {
    const definition = registeredDefinition()
    const state = oneRequest()
    // 0.1.1-rc.1 feeds the persisted row through `stateSchema` before folding
    // onto it; a definition without one throws on the first resumed session.
    expect(definition.stateSchema).toBeDefined()
    const restored = definition.stateSchema.parse(structuredClone(state))
    expect(wireValueUnderNewRegistry(definition, restored).requests).toBe(1)
  })

  it('registers at a non-negative integer stateVersion', () => {
    const { stateVersion } = registeredDefinition()
    expect(Number.isSafeInteger(stateVersion) && stateVersion >= 0).toBe(true)
  })

  it('is a no-op where the registry is absent', () => {
    const register = vi.fn()
    const ctx = { inject: () => {}, get: () => undefined }
    expect(() => applyPlugin(ctx, { currency: 'auto', balance: false })).not.toThrow()
    expect(register).not.toHaveBeenCalled()
  })
})

describe('stateSchema', () => {
  it('accepts an empty fold state', () => {
    expect(stateSchema.parse(init())).toEqual(init())
  })

  it('accepts a folded state', () => {
    const state = oneRequest()
    expect(stateSchema.parse(structuredClone(state))).toEqual(state)
  })

  it('rejects a row that is not an object', () => {
    expect(() => stateSchema.parse(null)).toThrow(/state is not an object/)
    expect(() => stateSchema.parse([])).toThrow(/state is not an object/)
  })

  it('rejects a bill bucket with a non-count', () => {
    const state = oneRequest()
    const key = Object.keys(state.bills)[0]
    state.bills[key].miss = -1
    expect(() => stateSchema.parse(state)).toThrow(/miss is not a count/)
  })

  it('rejects a bill bucket that lost a field', () => {
    const state = oneRequest()
    const key = Object.keys(state.bills)[0]
    delete state.bills[key].requests
    expect(() => stateSchema.parse(state)).toThrow(/requests is not a count/)
  })

  it('rejects a malformed replacement marker', () => {
    const state = oneRequest()
    state.last.key = 42
    expect(() => stateSchema.parse(state)).toThrow(/last\.key is not a string/)
  })

  it('rejects a non-timestamp firstAt', () => {
    const state = oneRequest()
    state.firstAt = 'yesterday'
    expect(() => stateSchema.parse(state)).toThrow(/firstAt is not a timestamp/)
  })

  it('keeps null the legal empty value for the nullable fields', () => {
    const state = { ...init(), bills: {} }
    expect(() => stateSchema.parse(state)).not.toThrow()
  })
})
