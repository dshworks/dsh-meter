# Changelog

## 0.3.0 — 2026-08-17

The meter gets a voice — optionally.

- **Saving mode (`savingMode: true`).** Off by default, the meter
  contributes one system-prompt section, `meter:tariff`, evaluated at
  every assembly: inside a peak window it tells the model which tariff
  the next request will be dispatched under, names the peak hours, and
  asks for economical behavior; outside the windows it renders
  `savingOffPeakPrompt`, empty by default, so silence costs zero prompt
  tokens. The tariff comes from the same clock the billing fold uses, so
  the nudge and the bill cannot disagree. This is the plugin's first
  model-visible contribution; CONTRIBUTING.md's "keep the model surface
  empty" rule now reads "empty by default".
- **The nudge is cache-safe by design.** The section text is
  byte-identical inside a tariff window (a countdown would roll the
  session's prompt-prefix cache every minute — the most expensive way to
  save money a cost plugin can think of), so it flips only at the four
  daily tariff boundaries. Both READMEs say so.
- **Both texts are configurable** (`savingPeakPrompt`,
  `savingOffPeakPrompt`), validated with the rest of the config; a custom
  peak nudge replaces the built-in one verbatim.
- Six new tests (`tests/prompt.spec.mjs`) pin the nudge: silence when
  off, the built-in text inside both peak windows, verbatim custom text,
  silence off-peak by default, silence under the retired flat tariff,
  and stability inside a window. 56 tests, CI green.

## 0.2.4 — 2026-08-17

The switchover happened, and the rate card was already right.

- **Re-verified against upstream and against a bill.** DeepSeek's
  time-of-use card took effect at 16:00 UTC on 2026-08-16 and the pricing
  page now publishes only the off-peak and peak rows, in both locales.
  Every figure in `RATES` already matched, in both currencies, so no rate
  changed here. One live check confirmed the billing system flipped too,
  not just the page: 188,542 cache-miss tokens on pro, off-peak, settled
  at ¥0.84 — ¥4.46/1M against the published 4.5, where the flat card
  would have made it 3.0.
- **`flat` is documented as retired, not current.** Both READMEs led with
  the flat row; it now sits below the live card, folded, labelled as what
  the ledger reprices history under. The rate itself stays in `RATES`
  because a session logged before the switchover must still cost what it
  actually cost.
- **A guard against under-billing.** New test: a request made now must
  never price at `flat`. It fails if anyone pushes `TIME_OF_USE_FROM`
  forward, which is the one bug in this file that costs a user real money.
- **The cache discount is derived, not typed.** Both READMEs and the
  card's own cold-cache hint claimed a hit bills at 1/50 of a miss — the
  flat card's flash ratio, over-promising on every live row since the
  switchover, on the one number a prompt-caching user acts on. It is 30x
  now, and `CACHE_DISCOUNT` computes it from `RATES`, floored, with a test
  that fails the day any row gets stingier than the surface claims.
- **A site**, at <https://dsh.works/dsh-meter/>. `scripts/build-site.mjs`
  inlines `lib/core.js` into `docs/index.html` the way `build-client.mjs`
  inlines it into the bundle, so the page's tariff clock is the plugin's
  tariff clock — running in the reader's own timezone, on the reader's own
  clock — and its schedule strip and rate table are rendered from the same
  exports. No price is typed into the HTML. `pnpm test` fails when the
  page drifts from the card.
- Three stale figures from the same cause: 47 tests (50), off-peak output
  at 2.4x flat (2.3x, matching the fold right below it), and a rate card
  "snapshot taken 2026-08-13" that has been re-checked twice since.

## 0.2.3 — 2026-08-16

- **Fix: the Web UI half failed to load when installed from npm.** The
  browser bundle still registered itself as `dsh-meter`, but the harness
  keys client modules by package name and serves the bundle at
  `/plugins/@dshworks/dsh-meter/client.js` — the loader rejected it
  (`loaded without registering "@dshworks/dsh-meter"`) and the web UI
  showed "Failed to load plugins" for the whole profile. The bundle id now
  comes from `package.json`, and a test pins the two together.

## 0.2.2 — 2026-08-15

- Restore the `engines` floor (`node >=20`) that the balance reader's
  global `fetch` needs. It was added and then clobbered by a version bump
  in the same session; 0.2.1 shipped without it.

## 0.2.1 — 2026-08-15

First npm release, as `@dshworks/dsh-meter`.

- **Fix: the bundle patch could not be imported when installed from npm.**
  `cordis.patch.yml` carried the unscoped package name, and `name` is the
  specifier the Loader resolves — a profile that installed the package
  rather than linking a folder called `dsh-meter` failed to boot with
  `Cannot find package 'dsh-meter'`. The row's `id` is still `dsh-meter`,
  so configuration written against it is unchanged.

## 0.2.0 — 2026-08-15

The account joins the meter.

- **Both rate cards, no conversion.** The projection now prices every
  session against DeepSeek's USD *and* CNY tables. Neither is derived from
  the other, so nothing is ever shown through an exchange rate.
- **The currency is detected, not configured.** `GET /user/balance`
  reports which table an account is billed against; the meter reads the
  funded row and switches sides on its own. `currency` becomes an override
  with a new `auto` default.
- **Balance in the card**, with granted credit broken out — granted
  expires, topped-up does not. Read on the host through the harness
  credential seam and served to the browser as parsed numbers over
  `GET /dsh-meter/balance`; the key never leaves the process, and the
  request fires on mount and on opening the card, never on a timer. Turn
  it off with `balance: false`.
- **Instrument styling.** Numerals in the theme's mono face, tabular, with
  the currency symbol dimmed; section labels as small caps; hairline
  rules; the tariff strip's now-marker in brand blue as the one moving
  part.
- **Per-model rows** appear once a session actually used more than one
  model.
- Projection `stateVersion` is 2 — cached rows from 0.1.0 are discarded
  and refolded, which costs one replay and no data.

## 0.1.0 — 2026-08-15

First release, the day before DeepSeek's time-of-use switchover.

- One line in the composer dock: session cost, the running tariff, and the
  countdown to the next change.
- Hover card: a 24-hour tariff strip in local time with a live now-marker,
  the cache/fresh/output split, and the same tokens priced under the other
  tariff.
- Each request billed at the tariff in force when it was **dispatched**, so
  a session spanning a boundary is billed correctly on both sides.
- A step's usage chunk is replaced by its finalized message rather than
  added to it, including when the message names a different model.
- Models with no published rate are counted and named, never priced.
- The rate card lives in one file; `scripts/build-client.mjs` inlines it
  into the browser bundle and `pnpm test` fails if the two drift.
