/**
 * dsh-meter — host half.
 *
 * Two contributions, both pull-driven:
 *
 * 1. The `costMeter` session projection: a pure fold of every request's
 *    provider-reported token usage into per-(tariff x model) billing buckets,
 *    priced from DeepSeek's published rate card at the tariff in force when the
 *    request was dispatched. No timers, no network, nothing model-visible.
 * 2. `GET /dsh-meter/balance`: the account's balance and — the reason it earns
 *    a route — the currency DeepSeek bills it in. The API key is resolved
 *    through the same credential seam the LLM adapter uses and never leaves
 *    this process; the browser receives parsed numbers only. The request fires
 *    when a human opens the card, not on a schedule.
 */
import z from '@deepseek-ai/schemastery'
import { createBalanceReader } from './balance.js'
import { foldEvent, init, schema, view } from './core.js'

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
})

/**
 * Mount the cost projection and, when enabled, the balance route.
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
