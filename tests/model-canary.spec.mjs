import { describe, expect, it } from 'vitest'

import { compare } from '../scripts/model-canary.mjs'

/**
 * The detector for a substitution that has not happened yet.
 *
 * DeepSeek said on 2026-09-09 that `deepseek-v4-pro` requests would be routed
 * to V4.1 Flash and billed at the Flash rate. The meter prices by the model
 * that answered, read out of the API's `model` field — and that field is an
 * echo of what you asked for. If the substitution keeps echoing, the meter
 * prices flash tokens at the pro rate: three times the real bill, on the one
 * number this plugin exists to produce.
 *
 * So these tests are written against real measured numbers rather than round
 * ones. The V4 column is the recorded baseline (data/model-signatures.json);
 * the V4.1 column was measured against
 * `deepseek-v4.1-flash-expires-on-0910` the day before it was due to ship.
 */
const V4 = { promptTokens: { en_short: 86, en_para: 184, zh: 148, code: 259 }, echoed: 'deepseek-v4-pro', fingerprint: 'a307abda487cd1b463329ccb945ce396' }
const V41 = { promptTokens: { en_short: 33, en_para: 131, zh: 95, code: 206 }, echoed: 'deepseek-v4-pro', fingerprint: '6d641ab04c479a91a8f79fb96f1d69c0' }

describe('the model-substitution canary', () => {
  it('says nothing when the same model answers', () => {
    expect(compare('deepseek-v4-pro', V4, V4)).toEqual({
      model: 'deepseek-v4-pro', verdict: 'unchanged', echoed: 'deepseek-v4-pro',
    })
  })

  it('catches the substitution even though the API still says deepseek-v4-pro', () => {
    const r = compare('deepseek-v4-pro', V4, V41)
    expect(r.verdict).toBe('moved')
    // The whole point: the name did not change, and the answer is still yes.
    expect(r.echoStillClaims).toBe(true)
    expect(r.uniform).toBe(true)
    expect(r.delta).toBe(-53)
  })

  it('reports the offset, because the offset is what names the family', () => {
    // -53 on every probe is a different per-request preamble. A reworded
    // system prompt would not land on the same number for English, Chinese
    // and code alike.
    const r = compare('deepseek-v4-pro', V4, V41)
    expect(r.moved).toEqual([
      { probe: 'en_short', was: 86, now: 33 },
      { probe: 'en_para', was: 184, now: 131 },
      { probe: 'zh', was: 148, now: 95 },
      { probe: 'code', was: 259, now: 206 },
    ])
  })

  it('does not call one probe moving a substitution', () => {
    // A single probe drifting is a prompt edit, not a new model. Flagged, but
    // `uniform` false and no delta claimed — the alarm should not assert more
    // than it measured.
    const one = { ...V4, promptTokens: { ...V4.promptTokens, zh: 149 } }
    const r = compare('deepseek-v4-pro', V4, one)
    expect(r.verdict).toBe('moved')
    expect(r.uniform).toBe(false)
    expect(r.delta).toBeNull()
  })

  it('does not fire on a redeploy alone', () => {
    // Fingerprints move whenever they redeploy. If billed tokens are
    // unchanged, that is not a substitution and must not read as one — this
    // is the false positive that would get the canary switched off.
    const redeployed = { ...V4, fingerprint: 'deadbeefdeadbeefdeadbeefdeadbeef' }
    expect(compare('deepseek-v4-pro', V4, redeployed).verdict).toBe('unchanged')
  })
})
