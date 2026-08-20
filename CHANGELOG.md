# Changelog

## Unreleased

The rate card stops being a private fact.

- **`docs/pricing.json`**, served at
  <https://dsh.works/dsh-meter/pricing.json>. Static JSON, no key, no rate
  limit: both currencies, both live tariffs, the 24-hour UTC schedule, the
  retired flat card with the date it stopped applying, and the definition
  of each billed bucket. Generated from `lib/core.js` by
  `scripts/build-pricing.mjs` and checked by `pnpm test`, so the feed
  cannot state a price the meter would not charge. It is a pure function
  of the card — no timestamp, no fetch — so the file changes exactly when
  the price does.
- **Because no external source is right.** Checked 2026-08-20, four days
  after the switchover, models.dev and LiteLLM's
  `model_prices_and_context_window.json` both still published DeepSeek's
  retired flat card as current — understating a v4-pro bill by 1.5x
  off-peak, 3x at peak, and 12x on cached input at peak. Neither is a
  staleness bug they can patch: both schemas hold one flat price per model
  per bucket, with nowhere to put a tariff. OpenRouter's numbers are
  accurate but answer a different question — what OpenRouter charges to
  resell the model, not what DeepSeek deducts from your account.
- **`scripts/verify-pricing.mjs`** diffs the shipped card against
  DeepSeek's own two pricing pages — English and Chinese, every rate, the
  peak windows, and the model list, since a model priced upstream and
  missing here would meter at zero. A page it can no longer parse exits
  non-zero too: the alarm should fire when the source changes shape, not
  only when a number moves.
- **A daily job** (`.github/workflows/pricing-watch.yml`) runs it and opens
  or comments on a `pricing-drift` issue. The last price change arrived
  with no announcement in any channel we watch, which is the entire
  argument for it. Deliberately outside `pnpm test`: a unit suite must not
  fail because a documentation site is slow, and a price alarm must not
  stay silent because nobody opened a PR this week.
- `pnpm run build` now regenerates all three artifacts;
  `pnpm run verify:pricing` is the network check. Both READMEs document
  the feed, the npm route (`@dshworks/dsh-meter/core`, which imports
  nothing), and why the aggregators are wrong.

- **The Chinese page's schedule is checked too, and against the English
  one.** `verify-pricing` read only the English footnote's UTC sentence,
  so a change to the mainland windows alone would have been invisible —
  and DeepSeek already publishes two independent rate cards for the two
  platforms, which makes two independent schedules equally possible. It
  now parses the Chinese footnote's Beijing hours, converts at UTC+8,
  compares both against the card, and compares them against each other.
  If the two pages ever disagree, the card needs one schedule per
  currency, which is a design change and not a number edit.
- **The alarm's parsers are unit-tested** (`tests/verify-pricing.spec.mjs`,
  10 tests, no network — only `main()` fetches, and it runs only when the
  file is invoked directly). A parser that quietly reads the wrong row
  still exits 0, so the happy case proves nothing. Covers both locales'
  table shapes, the rows that look like price rows and are not, and the
  Beijing conversion including windows that wrap across the UTC day.
- **The feed says how to read "now", because that is the one way to
  misread it.** New `timeOfUse.anchor` (Asia/Shanghai, UTC+8, no DST
  since 1991, plus the Beijing windows as display strings) and
  `timeOfUse.readingNow`. A test now also asserts the file carries **no**
  `now`/`asOf`/`currentTariff` field: it publishes the schedule, never
  the answer, which is what lets a cached or vendored copy stay correct.
  Both READMEs gained a zero-install `curl | jq` recipe and the two
  silent ways to get it wrong — local-hour indexing, and jq's `gmtime`
  hour being `.[3]` where `.[2]` is the day of the month and also a valid
  index into a 24-hour array. Caught live: at 09:59 UTC `.[2]` reported
  `offpeak` while the tariff was `peak`.

- **The card is generated now, not typed.** `scripts/apply-pricing.mjs`
  splices the scraped rates and windows back into `lib/core.js`, then
  **re-runs the verifier against its own output** and reverts if that
  independent second read disagrees — so a splice that lands a value in
  the wrong slot never survives. Proven by corrupting three unrelated
  values (a USD rate, a CNY rate, a peak window) and watching it
  reproduce the hand-written card byte for byte, retired `flat` rows
  included, so a PR diff can only ever show a real price move.
  `npm run sync:pricing` locally.
- **The daily job now opens a PR instead of an issue.** It rewrites the
  card, regenerates the bundle, site and feed, and pushes to one reusable
  `pricing/auto-sync` branch. It still **never merges**: every invariant
  CI checks is structural — off-peak is half of peak, output beats a
  cache miss, a live request never prices at `flat` — and a
  wrong-but-plausible parse satisfies all of them. No test can tell a
  right price from a believable one. A page it cannot read, or cannot
  rewrite from, still falls back to the issue path.
- **Why any of this exists, in one link.** DeepSeek's own
  [pi integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono)
  ships a `cost` block where v4-flash's cache-read rate is a 10x decimal
  slip (`0.028` for `0.0028`) and the v4-pro figures are exactly 4x the
  card — Azure's resale prices, pasted into DeepSeek's documentation, on
  a page written to be copied into an agent config. Verified live
  2026-08-20. A hand-maintained rate card rots; the vendor is the proof.

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
