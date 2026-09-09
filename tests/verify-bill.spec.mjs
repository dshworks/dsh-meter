import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { SETTLE, TOLERANCE, cnyOf, isSettled, judge, predict, probeWords } from '../scripts/verify-bill.mjs'
import { RATES, tariffAt } from '../lib/core.js'
import { BILL_CHECK } from '../lib/bill-check.js'

/**
 * The card checked against money.
 *
 * Every number here is a real measurement from a live account on 2026-09-09,
 * not a round one chosen to make a test pass:
 *
 *   flash, peak: 254,682 miss + 8 out -> card ¥0.7641, settled ¥0.77
 *   pro,   peak: 127,491 miss + 4 out -> card ¥1.1475, settled ¥1.14
 */
const PRO_PEAK = { miss: 127_491, hit: 0, out: 4 }
const FLASH_PEAK = { miss: 254_682, hit: 0, out: 8 }

describe('predicting the bill from the card', () => {
  it('reproduces both live measurements', () => {
    expect(predict(PRO_PEAK, 'deepseek-v4-pro', 'peak')).toBeCloseTo(1.1475, 4)
    expect(predict(FLASH_PEAK, 'deepseek-v4-flash', 'peak')).toBeCloseTo(0.7641, 4)
  })

  it('charges the three buckets at their own rates', () => {
    // A cache hit is ~30x cheaper than a miss; folding them together would
    // still look plausible on a miss-only probe.
    const { miss, hit, out } = RATES['deepseek-v4-pro'].peak.cny
    expect(predict({ miss: 1e6, hit: 1e6, out: 1e6 }, 'deepseek-v4-pro', 'peak')).toBeCloseTo(miss + hit + out, 6)
  })
})

/**
 * The regression that this whole rewrite exists for.
 *
 * v1 of the probe called a delta settled after two consecutive equal reads.
 * Its first real run produced this trace and reported `deepseek-v4-pro`
 * billing ¥1.42/1M against a card of ¥9 — confident, alarming, and false. The
 * charge was mid-settlement; a plateau between two steps is indistinguishable
 * from a finished settlement if a plateau is all you look for.
 */
describe('knowing when a settlement has finished', () => {
  const trace = (...pairs) => pairs.map(([s, delta]) => ({ atMs: s * 1000, delta }))

  it('rejects the exact trace that raised the false alarm', () => {
    const t = trace([60, 0.02], [75, 0.04], [90, 0.04])
    expect(isSettled(t, 90_000)).toBe(false)
  })

  it('rejects a plateau that has not lasted longer than a settlement takes', () => {
    // ~150s is how long a whole charge took to appear. Anything quieter than
    // that is not evidence that no further step is coming.
    expect(isSettled(trace([60, 0.02], [200, 0.25], [300, 0.25]), 300_000)).toBe(false)
  })

  it('accepts a plateau that has outlasted one', () => {
    expect(isSettled(trace([60, 0.02], [200, 0.25], [460, 0.25]), 460_000)).toBe(true)
  })

  it('never settles on zero, however long it holds', () => {
    // For the first two minutes after a real charge this account reports
    // exactly ¥0.00. Reading that as an answer prices a paid request at free.
    expect(isSettled(trace([60, 0], [300, 0], [900, 0]), 900_000)).toBe(false)
  })

  it('will not settle on a young plateau, however still it is', () => {
    expect(isSettled(trace([20, 0.25], [40, 0.25]), 40_000)).toBe(false)
  })

  it('does not restart for a trailing cent, because those never stop', () => {
    // Sampled every 20s, a real charge landed ¥0.27 at t+40s and ¥0.26 at
    // t+100s, then single cents at t+222s and t+749s — 500s apart and still
    // arriving twelve minutes in. "Wait until nothing changes" never returns.
    const t = trace([300, 0.53], [400, 0.53], [500, 0.54], [600, 0.54])
    expect(isSettled(t, 600_000)).toBe(true)
  })

  it('will not let cents creep past it one at a time', () => {
    // Each step here is within the noise band and the total walks ¥0.03 away
    // from where the window opened. Comparing each sample to its predecessor
    // instead of to the latest would call this settled.
    const t = trace([400, 0.53], [480, 0.54], [560, 0.55], [640, 0.56])
    expect(isSettled(t, 640_000)).toBe(false)
  })

  it('keeps the noise band well under anything worth alarming on', () => {
    // A cent of drift must never be able to look like a price change.
    expect(SETTLE.noiseCny).toBeLessThan(0.1)
  })

  it('keeps the quiet window longer than a whole settlement takes', () => {
    // The constant IS the claim: 150s was measured end to end, twice, and a
    // quiet window shorter than that proves nothing about what is still coming.
    expect(SETTLE.quietMs).toBeGreaterThan(SETTLE.observedSettlementMs)
  })
})

describe('judging a settled delta', () => {
  it('accepts the real pro measurement, cent-rounding and all', () => {
    expect(judge(1.1475, 1.14).verdict).toBe('match')
  })

  it('absorbs the unexplained 3% residual rather than firing on it every run', () => {
    // Measured cumulative overshoot across ¥2.49 of probes. Unexplained. An
    // alarm that fires on it would be switched off before catching anything.
    expect(judge(1.0, 1.03).verdict).toBe('match')
  })

  it('still catches every failure worth catching', () => {
    expect(judge(1.0, 1 / 3).verdict).toBe('cheaper') // model rerouted to a cheaper one
    expect(judge(1.0, 0.5).verdict).toBe('cheaper')   // wrong tariff column
    expect(judge(1.0, 2.0).verdict).toBe('dearer')    // ditto, other way
    expect(judge(0.03, 0.9).verdict).toBe('dearer')   // cache bucket mispriced
  })

  it('treats a small bill and a large one alike', () => {
    // v1 believed a small bill immediately, arguing other traffic can only
    // ADD. Incomplete settlement also makes a bill look small, and did.
    // Neither verdict is trusted without a second round.
    expect(judge(1.0, 0.2).verdict).toBe('cheaper')
    expect(judge(1.0, 5.0).verdict).toBe('dearer')
  })

  it('abstains rather than guessing when nothing settled', () => {
    expect(judge(1.0, null).verdict).toBe('abstain')
    expect(judge(1.0, -5).verdict).toBe('abstain')
  })

  it('scales the allowance with the bill, with a floor at the granularity', () => {
    expect(judge(0.001, 0.03).verdict).toBe('match') // tiny bill: absolute floor rules
    expect(TOLERANCE.absoluteCny).toBeGreaterThanOrEqual(0.02)
  })
})

describe('sizing a probe', () => {
  it('spends about the budget whatever the model costs', () => {
    for (const model of Object.keys(RATES)) {
      for (const tariff of ['peak', 'offpeak']) {
        const spend = predict({ miss: probeWords(model, tariff, 0.2) * 3.54, hit: 0, out: 0 }, model, tariff)
        expect(spend).toBeGreaterThan(0.15)
        expect(spend).toBeLessThan(0.25)
      }
    }
  })

  it('buys more tokens where they are cheaper, not more money', () => {
    expect(probeWords('deepseek-v4-flash', 'peak')).toBeGreaterThan(probeWords('deepseek-v4-pro', 'peak'))
    expect(probeWords('deepseek-v4-pro', 'offpeak')).toBeGreaterThan(probeWords('deepseek-v4-pro', 'peak'))
  })

  it('refuses a model it has no rate for rather than probing blind', () => {
    expect(() => probeWords('deepseek-v9-imaginary', 'peak')).toThrow(/no CNY miss rate/)
  })
})

describe('reading the balance', () => {
  const body = {
    balance_infos: [
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      { currency: 'CNY', total_balance: '82.33', granted_balance: '10.00', topped_up_balance: '72.33' },
    ],
  }

  it('takes CNY, not the USD row that sorts first', () => {
    expect(cnyOf(body)).toBe(82.33)
  })

  it('takes the total, because deduction spends granted balance too', () => {
    expect(cnyOf(body)).not.toBe(72.33)
  })

  it('refuses an account with no CNY balance rather than returning NaN', () => {
    expect(() => cnyOf({ balance_infos: [{ currency: 'USD', total_balance: '5.00' }] })).toThrow(/no CNY balance/)
  })
})

/**
 * The schedule is a claim about tariffs, so it is checked like one.
 *
 * Two runs a week only check both columns of the card if one lands inside a
 * peak window and one outside. Nothing about a cron expression says that, and
 * the peak windows have already moved once with no changelog entry.
 */
describe('the twice-weekly schedule', () => {
  const workflow = readFileSync(new URL('../.github/workflows/verify-bill.yml', import.meta.url), 'utf8')
  const crons = [...workflow.matchAll(/cron:\s*'(\S+ \S+ \S+ \S+ \S+)'/g)].map(m => m[1])

  /** `m h * * dow` -> the next UTC instant matching it. Enough for these two. */
  const nextRun = (cron) => {
    const [minute, hour, , , dow] = cron.split(' ').map(f => (f === '*' ? f : Number(f)))
    const d = new Date(Date.UTC(2026, 8, 14)) // a Monday, after every rule change
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute)
  }

  it('schedules exactly two runs', () => {
    expect(crons).toHaveLength(2)
  })

  it('puts one run inside a peak window and one outside', () => {
    expect(new Set(crons.map(c => tariffAt(nextRun(c))))).toEqual(new Set(['peak', 'offpeak']))
  })

  it('tells each run which tariff to expect, and is right about it', () => {
    for (const cron of crons) {
      const expected = new RegExp(`'${cron.replace(/\*/g, '\\*')}' && '(\\w+)'`).exec(workflow)?.[1]
      expect(expected, `no --expect mapping for cron '${cron}'`).toBeDefined()
      expect(tariffAt(nextRun(cron))).toBe(expected)
    }
  })
})

/**
 * The published receipt has to still vouch for the published card.
 *
 * `docs/pricing.json` tells anyone building on the feed that this card was
 * settled against a real bill on a date. That claim survives a change to
 * `RATES` only if somebody re-measures. This test is what makes them: change a
 * rate without re-running the probe and the receipt stops matching, here,
 * rather than on a stranger's cost dashboard.
 */
describe('the bill receipt published in the feed', () => {
  it('is still true of the card it is published beside', () => {
    // Deliberately far tighter than the live alarm's 25%. That allowance
    // exists to absorb settlement noise and an unexplained residual in a
    // MEASUREMENT; both numbers here are recorded and exact, so the only
    // slack they need is the balance's own ¥0.01 granularity. Checked with
    // `judge`'s tolerance instead, a 22% rate change slid straight through
    // and a different test happened to catch it — which is a test passing
    // for a reason that has nothing to do with what it claims to check.
    for (const sample of BILL_CHECK.samples) {
      const predicted = predict(sample.tokens, sample.model, BILL_CHECK.tariff)
      expect(
        Math.abs(sample.settled - predicted),
        `${sample.model}: card now predicts ¥${predicted.toFixed(4)} for a bill that settled at ¥${sample.settled} — re-run scripts/verify-bill.mjs and update BILL_CHECK, or drop it`,
      ).toBeLessThanOrEqual(0.02)
    }
  })

  it('records which currency it measured, because only one was', () => {
    // The balance is CNY. Publishing this next to a USD table without saying
    // so would be the exact dishonesty the probe exists to catch.
    expect(BILL_CHECK.currency).toBe('cny')
  })

  it('carries a date, because a receipt without one is a claim about now', () => {
    expect(BILL_CHECK.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
