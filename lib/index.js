/**
 * dsh-meter — host half.
 *
 * Three contributions, two of them pull-driven:
 *
 * 1. The `costMeter` session projection: a pure fold of every request's
 *    provider-reported token usage into per-(tariff x model) billing buckets,
 *    priced from DeepSeek's published rate card at the tariff in force when the
 *    request was dispatched. No timers, no network.
 * 2. `GET /dsh-meter/balance`: the account's balance and — the reason it earns
 *    a route — the currency DeepSeek bills it in. The API key is resolved
 *    through the same credential seam the LLM adapter uses and never leaves
 *    this process; the browser receives parsed numbers only. The request fires
 *    when a human opens the card, not on a schedule.
 * 3. Saving mode (off by default): one system-prompt section that tells the
 *    model the tariff in force at each assembly and how to behave in it. This
 *    is the only model-visible contribution, and the only one that is not
 *    pull-driven — it exists so the meter can be more than a readout.
 */
import z from '@deepseek-ai/schemastery'
import { createBalanceReader } from './balance.js'
import { DEFAULT_PEAK_PROMPT, foldEvent, init, schema, tariffPrompt, view } from './core.js'

export const name = 'dsh-meter'

export const Config = z.object({
  /**
   * Which published rate card to show. `auto` takes the side the account's own
   * balance is denominated in, falling back to the interface language — set it
   * explicitly when the balance route is off or the account is unfunded.
   * DeepSeek publishes two independent tables, so this selects a table, never
   * an exchange rate.
   */
  currency: z.union([z.const('auto'), z.const('usd'), z.const('cny')]).default('auto'),
  /** Serve the account balance to the Web UI (one request per card opening, TTL-cached). */
  balance: z.boolean().default(true),
  /** Credential reference (environment-variable name) holding the DeepSeek API key. */
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  /** API origin the balance is read from. A relay that does not implement `/user/balance` reports as unsupported. */
  baseUrl: z.string().default('https://api.deepseek.com'),
  /** Minimum age before a card opening triggers a new balance request. */
  balanceTtlMs: z.number().min(1000).default(300_000),
  /** Per-request timeout for the balance read. */
  balanceTimeoutMs: z.number().min(200).default(4000),
  /**
   * Saving mode: when on, the meter contributes a system-prompt section that
   * names the tariff in force at each assembly and tells the model how to
   * behave in it. Off by default — the meter otherwise never touches the
   * request. Inside a peak window the section renders `savingPeakPrompt`;
   * outside it, `savingOffPeakPrompt` — empty (the default) means the section
   * renders to nothing and costs zero prompt tokens.
   */
  savingMode: z.boolean().default(false),
  /** The peak-window nudge, injected while a peak window runs. */
  savingPeakPrompt: z.string().default(DEFAULT_PEAK_PROMPT),
  /** The off-peak note, injected while no peak window runs; empty means silence. */
  savingOffPeakPrompt: z.string().default(''),
})

/**
 * Mount the cost projection, the saving-mode prompt section, and, when enabled,
 * the balance route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {ReturnType<typeof Config>} config - validated configuration.
 */
export function apply(ctx, config) {
  // Optional child: a composition without the projection registry (headless,
  // ACP) loads this plugin as a no-op rather than failing.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'costMeter',
      schema,
      init,
      apply: foldEvent,
      view: state => view(state, config.currency),
      stateVersion: 2,
    })
  })

  // Optional child for the same reason: without the system-prompt registry the
  // meter stays a readout, which is all it ever was before saving mode.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'meter:tariff',
      // After the deployment persona and other early guidance, before tool
      // guidance (100+): a behavioral note the model should absorb early.
      order: 50,
      // Evaluated at each assembly, so the section always names the tariff the
      // next request will be dispatched under — the same clock the billing
      // fold uses. The text is constant inside a tariff window, so the prompt
      // prefix, and its cache, survive until a boundary actually flips.
      text: () => tariffPrompt(Date.now(), {
        mode: config.savingMode,
        peak: config.savingPeakPrompt,
        offpeak: config.savingOffPeakPrompt,
      }),
    })
  })

  if (!config.balance) return

  const reader = createBalanceReader({
    // Re-resolved per read, never cached: a rotated key reaches the next read
    // the way it reaches the next model request.
    resolveKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(config.apiKeyEnv)
        if (hit !== undefined && hit.value !== '') return hit.value
      }
      const ambient = process.env[config.apiKeyEnv]
      return ambient === undefined || ambient === '' ? undefined : ambient
    },
    baseUrl: config.baseUrl,
    ttlMs: config.balanceTtlMs,
    timeoutMs: config.balanceTimeoutMs,
  })

  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-meter/balance',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' }).end()
          return
        }
        const snapshot = await reader.read()
        const body = JSON.stringify(snapshot)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          // The snapshot carries its own age; the TTL lives on the host so a
          // reload cannot stampede the upstream.
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }))
  })
}
