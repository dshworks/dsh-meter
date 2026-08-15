/**
 * dsh-meter — host half.
 *
 * Registers one session-projection unit, `costMeter`: a pure fold of every
 * request's provider-reported token usage into per-(tariff x model) billing
 * buckets, priced from DeepSeek's published rate card at the tariff in force
 * when the request was dispatched. The Web UI reads the finished value through
 * the projection seam; this half owns no timers, no polling, and no network.
 *
 * The unit follows the standard contract: pure synchronous init/apply/view,
 * plain-JSON state, and `apply` returns the same reference for events it does
 * not fold.
 */
import z from '@deepseek-ai/schemastery'
import { foldEvent, init, schema, view } from './core.js'

export const name = 'dsh-meter'

export const Config = z.object({
  /**
   * The currency your DeepSeek account is billed in. DeepSeek publishes two
   * separate rate cards — USD for the international platform, CNY for the
   * mainland one — so this selects a table, never an exchange rate.
   */
  currency: z.union([z.const('usd'), z.const('cny')]).default('usd'),
})

/**
 * Mount the cost projection.
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
      stateVersion: 1,
    })
  })
}
