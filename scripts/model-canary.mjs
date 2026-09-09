#!/usr/bin/env node
/**
 * Did the model you asked for answer the request?
 *
 * On 2026-09-09 DeepSeek told its WeChat community groups that when V4.1 Flash
 * ships (around 2026-09-10 Beijing time), every `deepseek-v4-pro` request will
 * be routed to V4.1 Flash and billed at V4.1 Flash's rate. Nothing about that
 * appears in the changelog, the news index, the pricing page or `/models`.
 *
 * That breaks this meter in a way no amount of care in `lib/core.js` can fix.
 * The meter prices by the model that answered — `assistant/message`'s
 * `message.source.model` — which is the right field to read and is supplied by
 * the API's `model` response field. Measured today, that field is an ECHO: ask
 * for `deepseek-v4-pro` and it says `deepseek-v4-pro`. If a substitution keeps
 * echoing the requested id, the name is the thing that lies, and the meter
 * confidently multiplies flash-priced tokens by the pro rate — three times the
 * real bill, silently, on the one number this plugin exists to get right.
 *
 * So the name cannot be the evidence. Two signals can be:
 *
 *  1. `system_fingerprint` — distinct per model today.
 *  2. The prompt-token overhead. Every V4-family model bills a fixed 53 tokens
 *     more than V4.1 for byte-identical input (measured across English,
 *     Chinese and code: 86/33, 184/131, 148/95, 259/206 — exactly 53 every
 *     time, so it is a per-request preamble, not a denser tokenizer). It is a
 *     BILLED quantity, which is what makes it usable: it appears in `usage` on
 *     every response and no substitution can hide it without changing what you
 *     are charged.
 *
 * This records both, per model, so a substitution is a dated observation rather
 * than a rumour. `data/model-signatures.json` holds the baseline taken BEFORE
 * the switchover; after it, `--check` says which models moved.
 *
 * Usage:
 *   node scripts/model-canary.mjs              compare against the baseline
 *   node scripts/model-canary.mjs --record     write a new baseline
 *   node scripts/model-canary.mjs --json       machine-readable result
 * Env: DEEPSEEK_API_KEY (required).
 * Exit: 0 unchanged, 1 a signature moved, 2 could not measure.
 *
 * Cost: one max_tokens=1 request per probe per model. Under 1,500 billed
 * prompt tokens for a whole run — a fraction of a cent, off-peak or not.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'data', 'model-signatures.json')
const KEY = process.env.DEEPSEEK_API_KEY ?? ''
const argv = process.argv.slice(2)
const RECORD = argv.includes('--record')
const JSON_OUT = argv.includes('--json')

/**
 * Fixed probes, never edited.
 *
 * The overhead is constant, so ONE probe would show it — but a constant is
 * only a constant across sizes and scripts, and the first sample of this
 * measurement (86 vs 33 tokens) reads as "V4.1's tokenizer is 2.6x denser",
 * which is a much better headline and false. Four probes are what turned a
 * ratio into an offset. They stay for the same reason.
 */
const PROBES = [
  ['en_short', 'Hello world.'],
  ['en_para', 'The quick brown fox jumps over the lazy dog. '.repeat(10)],
  ['zh', '深度求索发布了新的模型，速度更快，价格更低。'.repeat(5)],
  ['code', 'def fib(n):\n    return n if n<2 else fib(n-1)+fib(n-2)\n'.repeat(8)],
]

/** The ids we meter. An id that stops existing is itself a finding. */
const MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']

const post = async (model, content) => {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 1 }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${model}: ${body?.error?.message ?? res.status}`)
  return body
}

/** One model's billable signature: what it charges for known input, and who it says it is. */
export async function signatureOf(model) {
  const promptTokens = {}
  let echoed
  let fingerprint
  for (const [name, text] of PROBES) {
    const body = await post(model, text)
    promptTokens[name] = body.usage.prompt_tokens
    echoed = body.model
    fingerprint = body.system_fingerprint
  }
  return { promptTokens, echoed, fingerprint }
}

/**
 * Compare one model against its baseline.
 *
 * The prompt-token counts are the load-bearing half. `echoed` moving is
 * informative but weak — it is the field we already know can echo — and a
 * fingerprint moves on any redeploy, so on its own it means little. A
 * signature is "substituted" only when the BILLED counts move, and the size of
 * the move names the family: all four probes down by the same offset is a
 * different model preamble, not a reworded system prompt.
 */
export function compare(model, before, after) {
  const moved = PROBES
    .map(([name]) => [name, before.promptTokens[name], after.promptTokens[name]])
    .filter(([, was, now]) => was !== now)
  if (moved.length === 0) {
    return { model, verdict: 'unchanged', echoed: after.echoed }
  }
  const deltas = new Set(moved.map(([, was, now]) => now - was))
  const uniform = deltas.size === 1 && moved.length === PROBES.length
  return {
    model,
    verdict: 'moved',
    uniform,
    delta: uniform ? [...deltas][0] : null,
    moved: moved.map(([name, was, now]) => ({ probe: name, was, now })),
    echoed: after.echoed,
    echoStillClaims: after.echoed === model,
    fingerprintChanged: before.fingerprint !== after.fingerprint,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (KEY === '') {
    process.stderr.write('model-canary: DEEPSEEK_API_KEY is not set\n')
    process.exit(2)
  }

  const measured = {}
  try {
    for (const model of MODELS) measured[model] = await signatureOf(model)
  } catch (error) {
    process.stderr.write(`model-canary: ${error.message}\n`)
    process.exit(2)
  }

  if (RECORD) {
    writeFileSync(OUT, `${JSON.stringify({
      recorded: new Date().toISOString().slice(0, 10),
      why: 'Signatures taken before the announced deepseek-v4-pro -> V4.1 Flash routing. '
        + 'promptTokens are BILLED counts for byte-identical input, which is the only signal '
        + 'a substitution cannot hide without changing what you are charged.',
      probes: Object.fromEntries(PROBES.map(([name, text]) => [name, text.length])),
      models: measured,
    }, null, 2)}\n`)
    process.stdout.write(`model-canary: baseline written to data/model-signatures.json\n`)
    for (const [model, sig] of Object.entries(measured)) {
      process.stdout.write(`  ${model}: ${JSON.stringify(sig.promptTokens)} fp=${sig.fingerprint}\n`)
    }
    process.exit(0)
  }

  const baseline = JSON.parse(readFileSync(OUT, 'utf8'))
  const results = MODELS.map(m => compare(m, baseline.models[m], measured[m]))
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ baseline: baseline.recorded, results }, null, 2)}\n`)
  } else {
    process.stdout.write(`Baseline ${baseline.recorded}.\n\n`)
    for (const r of results) {
      if (r.verdict === 'unchanged') { process.stdout.write(`- ok    ${r.model} — billed prompt tokens unchanged\n`); continue }
      process.stdout.write(
        `- MOVED ${r.model} — ${r.uniform ? `every probe by exactly ${r.delta} tokens` : 'some probes'}: `
        + `${r.moved.map(m => `${m.probe} ${m.was}->${m.now}`).join(', ')}\n`
        + `        the API still calls it \`${r.echoed}\`${r.echoStillClaims ? ' — the name is not evidence' : ''}\n`,
      )
    }
  }
  process.exit(results.some(r => r.verdict === 'moved') ? 1 : 0)
}
