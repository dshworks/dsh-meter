#!/usr/bin/env node
/**
 * Check the rate card against the bill.
 *
 * `verify-pricing.mjs` diffs our copy of the card against DeepSeek's published
 * pricing page. That is a copy check. It cannot fail when the page and the card
 * agree and the *billing* is something else — and billing is the only thing a
 * cost meter is actually claiming to know. A published table is what a vendor
 * says; a balance is what it does.
 *
 * So: spend a known number of tokens, wait for the charge to settle, and
 * compare the balance delta against what `lib/core.js` predicts.
 *
 * The two checks answer different questions and the pair is the diagnosis:
 *
 *   pricing  bill   meaning
 *   -------  ----   -------
 *      ok     ok    the card is right
 *     FAIL    ok    the page moved, billing has not — a pre-announcement
 *      ok    FAIL   BILLING MOVED AND THE PAGE DID NOT — no other detector
 *     FAIL   FAIL   a repricing; update the card
 *
 * The third row also covers something that is not a price change: a request
 * served by a model other than the one asked for, billed at that model's rate.
 * The API's `model` response field is an echo of the request — measured across
 * every published id — so the name can never be evidence of that. The money can.
 *
 * ## Everything below was learned by running it, and most of it refuted a
 * ## version of this file that looked correct
 *
 * **Settlement is delayed, and it arrives in steps.** Two hand probes settled
 * as a single lump ~145s after the requests. On that evidence the first version
 * of this script waited for two consecutive equal balance reads. Its very first
 * real run reported `deepseek-v4-pro` billing ¥1.42/1M against a card of ¥9 —
 * a confident, alarming, completely false finding. The charge had settled ¥0.02
 * then ¥0.04, and a plateau between two steps is indistinguishable from a
 * finished settlement if you only look for a plateau. So: a delta is settled
 * only after it has not moved for longer than a whole settlement takes, and
 * never before a floor.
 *
 * **A probe contaminates the next one.** Settlement latency is longer than the
 * gap between two sequential probes, so probe N's tail lands inside probe N+1's
 * window and is billed to the wrong model. Hence one window for all models: the
 * run compares a single delta against the summed prediction, and `--isolate`
 * re-probes one model alone when something needs localising. Paying for
 * isolation only when the aggregate diverges is the same bargain as the
 * re-probe below.
 *
 * **"A bill can only be contaminated upwards" is false.** The first version
 * argued that other traffic on the key can only ADD, so a bill that looked too
 * small had to be a real finding and needed no confirmation. Incomplete
 * settlement also makes a bill look small, and that is exactly what happened.
 * Both directions are re-probed now. An asymmetry that reality refutes inside
 * one run was never an argument, it was a preference.
 *
 * **Settlement has a tail, and the tail was the "unexplained" 3%.** A whole
 * curve, sampled every 20s: ¥0.27 at t+40s, ¥0.26 at t+100s, then single cents
 * at t+222s and t+749s. Roughly two cents a round arrive after any sane
 * observer has stopped watching, which is exactly the ~3% by which every
 * earlier reading fell short of the eventual charge. So a probe cannot wait for
 * the true total, and does not try: cents are noise, steps are steps, and the
 * threshold sits far above both. This check exists to catch STRUCTURAL errors
 * and every one of them is enormous next to a few cents — a rerouted model is
 * 3x, a wrong tariff column 2x, a mispriced cache bucket 30x. A check tuned to
 * the tail would fire every run and be switched off before it caught anything.
 *
 * ## What this does not verify
 *
 * The balance is CNY, so this is the **mainland card only**. The USD table is
 * separately published and there is no USD balance on this account to read.
 *
 * Usage:
 *   node scripts/verify-bill.mjs                all priced models, one window
 *   node scripts/verify-bill.mjs --isolate M    one model alone, to localise
 *   node scripts/verify-bill.mjs --dry-run      size the probes, spend nothing
 *   node scripts/verify-bill.mjs --budget 0.5   yuan per model
 *   node scripts/verify-bill.mjs --expect peak  fail if the run is not in that
 *                                               tariff, so a drifting cron
 *                                               cannot check one column twice
 * Env: DEEPSEEK_API_KEY (required).
 * Exit: 0 the card matches the bill, 1 it does not, 2 could not measure.
 */
import { RATES, tariffAt } from '../lib/core.js'

const API = 'https://api.deepseek.com'
const KEY = process.env.DEEPSEEK_API_KEY ?? ''

/** Tokens per filler word, measured: 9,000 words billed ~31,850. */
const TOKENS_PER_WORD = 3.54

/** Yuan per model. 20x the balance's ¥0.01 granularity. */
const DEFAULT_BUDGET = 0.2

/**
 * Settlement timings.
 *
 * `observedSettlementMs` is not a rule, it is the measurement the rule is
 * derived from: a whole charge took about 150s to appear, twice. `quietMs` is
 * the rule, and the only evidence that no further step is coming is that none
 * came for longer than a settlement takes end to end.
 *
 * There was a `floorMs: 150_000` here too, refusing to settle before the floor.
 * It read like a second guard and could never fire — `since` can never exceed
 * `now`, so a 240s quiet window already implies 240s elapsed. Mutation testing
 * found it: deleting it changed no test. Dead code shaped like a safety
 * property is worse than no code, because a reader counts two guards.
 */
export const SETTLE = {
  /** How long the charge itself takes to land, measured. */
  observedSettlementMs: 150_000,
  /** How long it must sit still before we call it settled. */
  quietMs: 240_000,
  /**
   * Movement at or below this is not movement.
   *
   * A full settlement curve, sampled every 20s: ¥0.27 at t+40s, ¥0.26 at
   * t+100s — and then single cents at t+222s and t+749s. The trailing cents
   * arrive 500 seconds apart and were still coming twelve minutes in, so
   * "wait until nothing changes" never terminates. They are also what the
   * unexplained 3% residual turned out to be: about two cents a round,
   * arriving after everyone had stopped looking.
   *
   * So a cent is noise and a step is a step. Drift is measured against the
   * whole quiet window rather than the previous sample, because three cents
   * in a row would each slip under a per-sample band while the total walked
   * away from the measurement.
   */
  noiseCny: 0.02,
  pollMs: 20_000,
  capMs: 1_200_000,
}

/**
 * How far off the prediction has to be before this is a finding.
 *
 * Not a confidence interval — a floor under which we admit we cannot tell.
 * See the settlement tail above: a few cents a round arrive after any probe
 * has finished, and every failure worth alarming on is several hundred percent.
 */
export const TOLERANCE = { relative: 0.25, absoluteCny: 0.03 }

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const after = (name) => (argv.indexOf(name) === -1 ? null : argv[argv.indexOf(name) + 1])

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const call = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path}: ${json?.error?.message ?? res.status}`)
  return json
}

/** Total CNY balance — granted and topped-up together, because deduction spends both. */
export const cnyOf = (balance) => {
  const row = balance?.balance_infos?.find(b => b.currency === 'CNY')
  if (row === undefined) throw new Error('no CNY balance on this account')
  return Number(row.total_balance)
}

/**
 * Filler words to buy about `budget` of cache misses at this model's rate.
 *
 * Sizing off the card is circular only in appearance: a wrong card makes the
 * probe the wrong SIZE, never the comparison wrong, because the prediction is
 * recomputed from the token counts the API says it billed.
 */
export function probeWords(model, tariff, budget = DEFAULT_BUDGET) {
  const missRate = RATES[model]?.[tariff]?.cny?.miss
  if (typeof missRate !== 'number' || missRate <= 0) throw new Error(`no CNY miss rate for ${model} ${tariff}`)
  return Math.max(200, Math.round((budget * 1e6) / missRate / TOKENS_PER_WORD))
}

/** What the card says a measured usage total should have cost, in CNY. */
export function predict(totals, model, tariff) {
  const rate = RATES[model]?.[tariff]?.cny
  if (rate === undefined) throw new Error(`no CNY rates for ${model} ${tariff}`)
  return (totals.miss * rate.miss + totals.hit * rate.hit + totals.out * rate.out) / 1e6
}

/**
 * Is a settlement trace finished?
 *
 * `trace` is `[{ atMs, delta }]`. Settled means: past the floor, non-zero, and
 * nothing has moved for `quietMs`. A zero delta is never settled — for the
 * first two minutes after a real charge this account reports exactly ¥0.00, so
 * treating zero as an answer reads "free" off a request that cost money.
 */
export function isSettled(trace, now, { quietMs, noiseCny } = SETTLE) {
  if (trace.length === 0) return false
  const latest = trace[trace.length - 1]
  if (latest.delta === 0) return false
  // A whole quiet window has to have HAPPENED, not merely been quiet: with
  // less history than that there is nothing yet to be quiet about.
  if (now < quietMs) return false
  // Every sample in the window is compared against the latest, not each
  // against its predecessor. A per-sample band would let trailing cents creep
  // through one at a time while the total walked away from the measurement.
  return trace
    .filter(point => point.atMs >= now - quietMs)
    .every(point => Math.abs(latest.delta - point.delta) <= noiseCny)
}

/**
 * Compare a settled delta against the card.
 *
 * Symmetric on purpose. The version that believed a small bill immediately
 * raised a false alarm on its first run, because incomplete settlement looks
 * exactly like a price cut.
 */
export function judge(predicted, actual, tolerance = TOLERANCE) {
  if (actual === null) return { verdict: 'abstain', why: 'nothing settled inside the cap; a delta that is still moving is not a measurement' }
  if (actual < 0) return { verdict: 'abstain', why: 'the balance went UP — the account was topped up mid-probe' }
  const off = actual - predicted
  const allowed = Math.max(tolerance.absoluteCny, predicted * tolerance.relative)
  if (Math.abs(off) <= allowed) return { verdict: 'match', off, allowed }
  return {
    verdict: off < 0 ? 'cheaper' : 'dearer',
    off,
    allowed,
    ratio: predicted === 0 ? null : actual / predicted,
  }
}

/** Unique every call, so every token is a cache miss and the probe prices one bucket. */
const filler = (words) => {
  const out = new Array(words)
  for (let i = 0; i < words; i++) out[i] = Math.random().toString(36).slice(2, 8)
  return out.join(' ')
}

const balance = async () => cnyOf(await call('/user/balance'))

/**
 * Wait until the account is still.
 *
 * Run BEFORE reading the opening balance. Settlement outlives a probe, so
 * without this the previous run's tail is charged to this one — which is how
 * the first version billed one model's tokens to the next model.
 */
async function quiesce(note) {
  const started = Date.now()
  const seen = []
  for (;;) {
    const atMs = Date.now() - started
    const here = await balance()
    const previous = seen[seen.length - 1]
    if (previous !== undefined && Math.abs(here - previous.value) > SETTLE.noiseCny) {
      note(`    still settling: ¥${previous.value.toFixed(2)} -> ¥${here.toFixed(2)}`)
    }
    seen.push({ atMs, value: here })
    // The same window rule as `isSettled`, applied to a balance rather than a
    // delta — that one refuses a zero, which is right for a charge and wrong
    // for an account that could legitimately be empty.
    const quiet = atMs >= SETTLE.quietMs && seen
      .filter(point => point.atMs >= atMs - SETTLE.quietMs)
      .every(point => Math.abs(here - point.value) <= SETTLE.noiseCny)
    if (quiet) return here
    if (atMs > SETTLE.capMs) throw new Error('the balance is still moving by more than a cent a poll; something else is using this key')
    await sleep(SETTLE.pollMs)
  }
}

/** Poll until the delta is settled by `isSettled`, or give up and return null. */
async function settle(before, note) {
  const started = Date.now()
  const trace = []
  while (Date.now() - started < SETTLE.capMs) {
    await sleep(SETTLE.pollMs)
    const atMs = Date.now() - started
    const delta = Number((before - await balance()).toFixed(2))
    if (trace.length === 0 || trace[trace.length - 1].delta !== delta) note(`    +${Math.round(atMs / 1000)}s  delta ¥${delta.toFixed(2)}`)
    trace.push({ atMs, delta })
    if (isSettled(trace, atMs)) return { delta, trace }
  }
  return { delta: null, trace }
}

async function main() {
  const note = (line) => process.stdout.write(`${line}\n`)
  const budget = Number(after('--budget') ?? DEFAULT_BUDGET)
  const only = after('--isolate')
  const models = only ? [only] : Object.keys(RATES)
  const tariff = tariffAt(Date.now())

  // The schedule picks the tariff: one run inside a peak window, one outside,
  // so both columns get checked against money. Saying which one a run expects
  // turns a drifting cron into a failure instead of a year of silently
  // re-checking the same column.
  const expected = after('--expect')
  if (expected !== null && expected !== tariff) {
    process.stderr.write(`verify-bill: scheduled as ${expected} but this run is ${tariff}; fix the cron\n`)
    return 2
  }

  if (flag('--dry-run')) {
    note(`tariff right now: ${tariff}`)
    for (const model of models) note(`  ${model}: ${probeWords(model, tariff, budget).toLocaleString()} words, ~¥${budget.toFixed(2)}`)
    note(`total ~¥${(budget * models.length).toFixed(2)}`)
    return 0
  }
  if (KEY === '') { process.stderr.write('verify-bill: DEEPSEEK_API_KEY is not set\n'); return 2 }

  /** One measurement: quiesce, spend across every model, wait, compare the total. */
  const round = async () => {
    note('  waiting for the account to go quiet')
    const before = await quiesce(note)
    note(`  opening balance ¥${before.toFixed(2)}`)
    let predicted = 0
    const seen = []
    for (const model of models) {
      const words = probeWords(model, tariff, budget)
      const totals = { miss: 0, hit: 0, out: 0 }
      let echoed
      let fingerprint
      // Four requests, not one: a single prompt can outgrow the context window
      // at large budgets, and four make a partial failure visible.
      for (let i = 0; i < 4; i++) {
        const body = await call('/chat/completions', {
          model, messages: [{ role: 'user', content: filler(Math.ceil(words / 4)) }], max_tokens: 1,
        })
        totals.miss += body.usage.prompt_cache_miss_tokens
        totals.hit += body.usage.prompt_cache_hit_tokens
        totals.out += body.usage.completion_tokens
        echoed = body.model
        fingerprint = body.system_fingerprint
      }
      const cost = predict(totals, model, tariff)
      predicted += cost
      seen.push({ model, totals, cost, echoed, fingerprint })
      note(`  ${model}: ${totals.miss.toLocaleString()} miss / ${totals.hit} hit / ${totals.out} out -> card says ¥${cost.toFixed(4)}`)
    }
    note(`  spent; settled when nothing has moved for ${SETTLE.quietMs / 1000}s`)
    const { delta } = await settle(before, note)
    return { predicted, actual: delta, seen }
  }

  note(`Tariff **${tariff}**. ${models.length} model(s), ~¥${(budget * models.length).toFixed(2)} total.\n`)
  let result
  try {
    result = { ...await round(), ...judge(0, 0) }
    result = { ...result, ...judge(result.predicted, result.actual) }
    // Any divergence buys exactly one confirming round. A price that really
    // moved repeats; a stray request on the key and a slow settlement do not.
    if (result.verdict === 'cheaper' || result.verdict === 'dearer') {
      note(`\n  ${result.verdict} than the card — re-probing once before saying so`)
      const again = await round()
      const verdict = judge(again.predicted, again.actual)
      result = verdict.verdict === result.verdict
        ? { ...again, ...verdict, confirmed: true }
        : { ...again, ...verdict, confirmed: false, first: result }
    }
  } catch (error) {
    process.stderr.write(`verify-bill: ${error.message}\n`)
    return 2
  }

  note('')
  const money = result.actual === null ? 'nothing settled' : `¥${result.actual.toFixed(2)} billed vs ¥${result.predicted.toFixed(4)} predicted`
  if (result.verdict === 'match') { note(`- ok      the card matches the bill — ${money}`); return 0 }
  if (result.verdict === 'abstain') { note(`- ?       ${money}: ${result.why}`); return 2 }
  if (result.confirmed === false) {
    note(`- ?       ${money}: one round read ${result.first.verdict} and the next did not; treat as noise on this key, not a price change`)
    return 2
  }
  note(
    `- DIVERGE ${money}, twice (off by ¥${result.off.toFixed(2)}, allowed ¥${result.allowed.toFixed(2)})\n`
    + `          the bill is ${result.ratio.toFixed(2)}x what the card predicts\n`
    + `          probed: ${result.seen.map(s => `${s.model} ¥${s.cost.toFixed(4)}`).join(', ')}\n`
    + `          re-run with --isolate <model> to find which one\n`
    + `          the API called them ${result.seen.map(s => `\`${s.echoed}\``).join(', ')} — the name is an echo, the money is not`,
  )
  note('\nCNY card only: the balance is CNY and the USD table is published separately.')
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main())
