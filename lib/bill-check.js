/**
 * The receipt for the rate card, kept out of `core.js` on purpose.
 *
 * `lib/client.js` is composed by concatenating `core.js` and `src/ui.js`, so
 * everything in core ships to every browser session. The card belongs there —
 * the UI prices with it. A record of what a probe measured last Tuesday does
 * not, and putting it there quietly added it to the bundle.
 *
 * Read by `scripts/build-feed.mjs` and by the tests. Never by the UI.
 */
export const BILL_CHECK = {
  date: '2026-09-09',
  tariff: 'peak',
  currency: 'cny',
  method: 'balance delta over GET /user/balance, settled',
  note: 'Settlement is delayed ~150s and arrives in steps; a balance read too early reports 0.00. A tail of single-cent adjustments keeps arriving for 12+ minutes afterwards, so `settled` is the charge once the steps have landed, not the eventual total — about two cents a round land later.',
  samples: [
    { model: 'deepseek-v4-flash', tokens: { miss: 254_682, hit: 0, out: 8 }, settled: 0.77 },
    { model: 'deepseek-v4-pro', tokens: { miss: 127_491, hit: 0, out: 4 }, settled: 1.14 },
  ],
}

