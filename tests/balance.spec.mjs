import { describe, expect, it } from 'vitest'
import { chooseBalanceRow, createBalanceReader, readBalance } from '../lib/balance.js'

const row = (currency, total, granted = '0.00', toppedUp = '0.00') => ({
  currency,
  total_balance: total,
  granted_balance: granted,
  topped_up_balance: toppedUp,
})

/** A fetch stand-in returning one canned response and counting its calls. */
const stubFetch = (response) => {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (response instanceof Error) throw response
    return response
  }
  impl.calls = calls
  return impl
}

const json = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
})

describe('chooseBalanceRow', () => {
  it('picks the funded row — a live account lists both currencies', () => {
    expect(chooseBalanceRow([row('USD', '0.00'), row('CNY', '73.40')])).toMatchObject({ currency: 'CNY' })
    expect(chooseBalanceRow([row('CNY', '0.00'), row('USD', '12.00')])).toMatchObject({ currency: 'USD' })
  })

  it('falls back to the first row when nothing is funded, rather than inventing a side', () => {
    expect(chooseBalanceRow([row('USD', '0.00'), row('CNY', '0.00')])).toMatchObject({ currency: 'USD' })
  })

  it('has no answer for an empty list', () => {
    expect(chooseBalanceRow([])).toBeUndefined()
    expect(chooseBalanceRow(undefined)).toBeUndefined()
  })
})

describe('readBalance', () => {
  it('parses the funded row into numbers and a lowercase currency', () => {
    expect(readBalance({ is_available: true, balance_infos: [row('CNY', '110.00', '10.00', '100.00')] }))
      .toEqual({ currency: 'cny', total: 110, granted: 10, toppedUp: 100, available: true })
  })

  it('drops an unparseable amount instead of printing NaN', () => {
    const value = readBalance({ is_available: true, balance_infos: [row('USD', 'n/a')] })
    expect(value.total).toBeUndefined()
    expect(value.currency).toBe('usd')
  })

  it('reports a body with no rows as unsupported', () => {
    expect(readBalance({ is_available: false, balance_infos: [] })).toEqual({ error: 'unsupported' })
    expect(readBalance(undefined)).toEqual({ error: 'unsupported' })
  })
})

describe('createBalanceReader', () => {
  const reader = (fetchImpl, resolveKey = async () => 'sk-test') => createBalanceReader({
    resolveKey,
    baseUrl: 'https://api.deepseek.com/',
    ttlMs: 1000,
    timeoutMs: 100,
    fetchImpl,
  })

  it('sends the key as a bearer token to the balance endpoint', async () => {
    const impl = stubFetch(json({ is_available: true, balance_infos: [row('USD', '12.50')] }))
    const snapshot = await reader(impl).read(1000)
    expect(impl.calls[0].url).toBe('https://api.deepseek.com/user/balance')
    expect(impl.calls[0].headers.authorization).toBe('Bearer sk-test')
    expect(snapshot).toMatchObject({ currency: 'usd', total: 12.5, checkedAt: 1000 })
  })

  it('serves the cached snapshot inside the TTL and refetches past it', async () => {
    const impl = stubFetch(json({ is_available: true, balance_infos: [row('USD', '1.00')] }))
    const account = reader(impl)
    await account.read(0)
    await account.read(500)
    expect(impl.calls).toHaveLength(1)
    await account.read(1500)
    expect(impl.calls).toHaveLength(2)
  })

  it('coalesces concurrent reads into one request', async () => {
    const impl = stubFetch(json({ is_available: true, balance_infos: [row('USD', '1.00')] }))
    const account = reader(impl)
    await Promise.all([account.read(0), account.read(0), account.read(0)])
    expect(impl.calls).toHaveLength(1)
  })

  it('says no-key rather than calling out with nothing', async () => {
    const impl = stubFetch(json({}))
    expect(await reader(impl, async () => undefined).read(0)).toEqual({ error: 'no-key', checkedAt: 0 })
    expect(impl.calls).toHaveLength(0)
  })

  it('separates a rejected key from an endpoint that does not serve balance', async () => {
    expect(await reader(stubFetch(json({}, 401))).read(0)).toEqual({ error: 'unauthorized', checkedAt: 0 })
    expect(await reader(stubFetch(json({}, 404))).read(0)).toEqual({ error: 'unsupported', checkedAt: 0 })
    // A relay answering 200 with HTML: not a broken account, just no balance here.
    const html = { ok: true, status: 200, json: async () => { throw new Error('not json') } }
    expect(await reader(stubFetch(html)).read(0)).toEqual({ error: 'unsupported', checkedAt: 0 })
  })

  it('never rejects when the network does', async () => {
    expect(await reader(stubFetch(new Error('ECONNREFUSED'))).read(0)).toEqual({ error: 'unreachable', checkedAt: 0 })
  })
})
