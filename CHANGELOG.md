# Changelog

## Unreleased

### Added

- **A model-substitution canary** (`scripts/model-canary.mjs`,
  `data/model-signatures.json`). On 2026-09-09 DeepSeek told its WeChat
  community groups that when V4.1 Flash ships — around 2026-09-10 Beijing
  time — every `deepseek-v4-pro` request will be routed to V4.1 Flash and
  billed at the Flash rate. Nothing about it is in the changelog, the news
  index, the pricing page or `/models`, and the pricing page still lists
  `deepseek-v4-pro` at $1.98/$3.96 per 1M output.
  - This meter prices by the model that *answered* — `assistant/message`'s
    `message.source.model`, which is the API's `model` response field. That
    field is an **echo**: ask for `deepseek-v4-pro` and it says
    `deepseek-v4-pro`. If a substitution keeps echoing, the meter multiplies
    Flash-priced tokens by the Pro rate — **three times the real bill**,
    silently, on the one number this plugin exists to produce.
  - So the name is not the evidence. The canary records two things that are:
    `system_fingerprint`, and the **billed** prompt-token count for four fixed
    probes. Every V4-family model bills exactly 53 tokens more than V4.1 for
    byte-identical input (86/33, 184/131, 148/95, 259/206 — English, Chinese
    and code alike, so it is a per-request preamble and not a denser
    tokenizer). A substitution cannot hide that without changing what you are
    charged.
  - The baseline in `data/model-signatures.json` was taken **before** the
    switchover. After it, the before is unrecoverable.
  - A fingerprint moving on its own is a redeploy and does not fire. Tested
    against the real V4.1 numbers, and mutation-checked: making `compare()`
    trust the echoed model name turns three tests red.
  - Not scheduled. Running it daily needs `DEEPSEEK_API_KEY` in this public
    repo's Actions secrets, which is a decision for a human.

## 0.4.0 - 2026-08-25

### Added

- **Saving mode** (`savingMode`, off by default). One system-prompt section,
  `meter:tariff`, evaluated at every assembly, telling the model which tariff
  the *next* request will be dispatched under and asking for economical
  behaviour inside a peak window. The meter's first model-visible contribution
  in its life, and it stays opt-in: the repo's "keep the model surface empty"
  rule is now "empty by default".
  - The tariff comes from `tariffAt()` at assembly time — the same function and
    clock the billing fold uses — so the nudge and the bill cannot disagree
    about which side of a boundary the next request lands on. Weekends bill
    off-peak all day, so they get no nudge.
  - The text is byte-identical inside a tariff window. A countdown would change
    every minute and roll the session's prompt-prefix cache, which is the most
    expensive way to save money a cost plugin can think of.
  - Outside a peak window the section renders `savingOffPeakPrompt`, empty by
    default, and an empty section renders to nothing: zero prompt tokens when
    there is nothing to warn about.
  - `savingPeakPrompt` and `savingOffPeakPrompt` override both texts.
- `peakHoursPhrase()` — how the current schedule spells its peak hours, read
  off `PEAK_WINDOWS_UTC` and `tariffSchedule()`. The built-in nudge is built
  from it rather than typed, so a schedule change rewrites the sentence. This
  is the failure a sibling project shipped in August: the weekend rule reached
  the table and not the prose, and the prose went on saying peak ran daily.
- `tests/prompt-contract.spec.mjs` — the registration driven through a stand-in
  `systemPrompt` that reads exactly the fields the published registry reads.
  The projection registry renamed its fields in 0.1.1-rc.1 and the dock line
  went blank with no error; a prompt section fails more quietly still, because
  nothing on screen changes when the model simply never hears about the tariff.

## 0.3.2 — 2026-08-24

The meter stops requiring a session, and the tariff strip starts working
again.

### Settings > Meter

- **The instrument, before you spend anything.** The dock line needs a
  session that has already billed a request, so the question this plugin
  exists to answer — what does an hour cost, and when is it cheap — could
  not be asked until after you had paid to ask it. The new settings section
  answers it cold: the tariff running now with its countdown, a seven-day
  tariff grid, the published rate card in your account's currency, and the
  balance.
- **Not a form.** Both config knobs already live in the plugin's own
  configuration, which the harness knows how to edit; a second write path
  for two fields would be the settings-page reflex rather than the content.
  The section holds no controls on purpose.
- **The week, not the day.** The card's 24-hour strip answers "when does
  today change". Weekends going off-peak made that a weekly question, and
  35 amber cells out of 168 is the fastest way to see that peak is 35 hours
  a week rather than 49. Laid out in the reader's local days rather than
  Beijing's, with every cell asking `tariffAt` for its own instant, so the
  picture cannot drift from the bill and nobody has to convert timezones at
  23:00.
- **Rates print as published.** `formatRate` renders the card at DeepSeek's
  own precision — `¥1.5`, not `¥1.50`. `formatMoney` pads a computed total
  so a column of session costs lines up and a sub-cent figure survives; a
  rate is a quotation, and padding it put `¥0.0500` next to `¥1.50` and two
  decimal conventions in one column.
- **An easter egg in Chinese.** 峰 and 谷 — peak and valley — are the old
  words for time-of-use electricity, and the peak half is one character from
  the name of the man who founded the company selling the tokens. Hovering
  an hour slot in zh-Hans reads 文峰 / 文谷. English keeps peak / off-peak.
  It lives in the locale dictionaries rather than a language test, so the
  surface never asks what language it is in.

### The tariff strip was drawing a lie

- **Every cell had read `undefined` since the weekend fix.** `tariffSchedule`
  grew a day axis in 0.3.1 — 24 entries became a 7x24 grid — and its only
  consumer went on indexing it by UTC hour. Hours 0-6 got back a whole row
  object, the rest got `undefined`, and neither is `'peak'`, so the card
  drew a flat off-peak day on a Tuesday afternoon. No throw, no warning: a
  wrong picture is the only symptom a schedule bug has, and 0.3.1 shipped
  with it.
- **The reading is gone, not repaired.** Each cell now asks `tariffAt` for
  its own instant, which is what the schedule's own docstring recommends and
  leaves no index to mistranslate. `localMidnight`, `localTariffDays` and
  `localWeekStart` moved into `lib/core.js` so the clock logic sits where
  the test suite can reach it — it was in the browser half, which nothing
  tested.
- **Tests that fail on the old reading.** Seven of them, asserting what a
  cell *holds* rather than that a call returns: a test checking only
  `length === 24` passed throughout the outage, and one is kept here to say
  so. Plus dictionary parity — a key present in `en` and missing from `zh`
  does not fail, it silently half-translates. 116 tests.

## 0.3.1 — 2026-08-24

The meter is visible again, and everything main did since 0.2.4 finally
reaches npm.

- **The dock line came back.** `@deepseek-ai/dsh-session-projection`
  0.1.1-rc.1 renamed the projection definition: `schema` became
  `stateSchema`, and the top-level `view` moved into an **optional**
  `wire: { viewSchema, view }`. The registry reads those fields one at a
  time and never validates the definition it is handed, so the old spelling
  did not fail — it read as *"this projection is host-only"*. The fold kept
  running, the value never reached the browser, `useProjection('costMeter')`
  returned undefined, and the line rendered nothing. No error, no warning,
  no log line. A registration now carries both spellings, so one build is
  correct on either side of the rename.
- **`stateSchema` is new work, not a rename.** The old contract kept
  checkpoints raw; the new one parses the persisted row before folding onto
  it, so a definition without one throws on the first resumed session.
- **The peer range names both prerelease lines**
  (`^0.1.0-rc.6 || ^0.1.1-rc.1`). `^0.1.0-rc.6` did not match the installed
  `0.1.1-rc.2` at all: npm admits a prerelease only when some comparator
  names the same `[major, minor, patch]`. Correcting it buys documentation,
  not an alarm — a profile resolves harness packages from the dsh
  installation rather than its own tree, so `pnpm peers check` reports every
  one of them as *missing* whatever the range says. Nothing in the install
  path can currently tell you this plugin is talking to the wrong contract
  version; only rendering it can.

### About 0.3.0 on npm

**0.3.0 was published from a branch that never merged.** Its tag sits on a
commit off the 0.2.4 release, and `main` went a different way for seven
commits afterwards — so npm carried the pre-weekend rate card for a week:
peak prices on days that bill off-peak, and `deepseek-v4-flash-vision-exp`
metered at zero. Everything below shipped to `main` in that window and is
reaching npm only now.

**0.3.1 does not contain `savingMode`.** The system-prompt tariff nudge
exists only in 0.3.0 and in its still-open PR (#3). Upgrading from 0.3.0
keeps a `savingMode: true` config loading — unknown keys pass through — but
the prompt section stops being contributed. Correct pricing was the urgent
half; the nudge lands on its own merits.

### The schedule grows a day axis, and the card grows a model

- **Weekends bill off-peak all day**, from **2026-08-22 16:00 UTC** (00:00
  Beijing, Sunday 23 August). `tariffAt` read the hour and not the day, so
  the meter showed **peak for 14 hours a week that bill at half** — every
  Saturday and Sunday inside the two windows, displayed at exactly 2x what
  they cost. Peak is 35 hours a week, not 49. Reported in #11 by
  [@xyzs996](https://github.com/xyzs996).
- **The weekend is read on the vendor's clock.** DeepSeek wrote the rule as
  "Saturdays and Sundays, **Beijing Time**", so the weekend turns over at
  16:00 UTC, not midnight UTC. With today's windows the two readings label
  all 168 hours identically — both windows close at 10:00 UTC, well before
  the 16:00 UTC point where the dates diverge — so the tests pin the two
  instants that *do* discriminate. The day a window moves past 16:00 UTC,
  the UTC reading starts costing money and nothing else would have said so.
- **The boundary is kept, not backdated.** A session dispatched in a peak
  window on Sun 2026-08-17 or Sat 2026-08-22 genuinely billed peak.
  Repricing those would refund money the account never got back — the same
  reason `TIME_OF_USE_FROM` exists.
- **Feed schema `dsh-meter/pricing@2`** (breaking). The 24-entry
  `timeOfUse.scheduleUtc` is **replaced** by `timeOfUse.scheduleBeijing`, a
  7x24 grid indexed `[beijingWeekday][beijingHour]`, plus a
  `timeOfUse.weekend` block carrying the rule and the date it started. The
  key was removed rather than widened on purpose: a reader that ignored a
  new field would have stayed silently wrong, where a missing key throws.
  `timeOfUse.changedInV2` states the migration inside the feed.
- **`deepseek-v4-flash-vision-exp`** added to the card — shipped 2026-08-21,
  priced identically to `deepseek-v4-flash` in both currencies, and until
  now metered at **zero**. It has no `flat` row because it arrived after the
  switchover, and `scripts/build-feed.mjs` assumed every model had one and
  crashed on it, which is why the daily job could not land the fix itself.
  Fixed in #10 by [@xyzs996](https://github.com/xyzs996).
- **The drift alarm can now see the day axis.** `verify-pricing.mjs` captured
  the footnote with `/Peak hours are ([^.]+)UTC/`, which stopped one
  character before `, Monday through Friday` — so the check reported green
  while the schedule was missing a whole dimension. It now reads the
  weekday clause in both locales and calls its absence drift. A scraper that
  extracts only the fields it already models cannot report a new one; it can
  only be silently wrong about it.


### The rate card stops being a private fact

- **`docs/pricing.json`**, served at
  <https://dsh.works/dsh-meter/pricing.json>. Static JSON, no key, no rate
  limit: both currencies, both live tariffs, the weekly schedule, the
  retired flat card with the date it stopped applying, and the definition
  of each billed bucket. Generated from `lib/core.js` by
  `scripts/build-feed.mjs` and checked by `pnpm test`, so the feed
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
- **Two defects in the sync job, found by rehearsing it rather than by
  waiting for a price to move.** `gh pr view` finds CLOSED pull requests
  too, so the next change would have been posted as a comment on a dead
  PR instead of opening a live one — it now checks `state == OPEN`. And
  the "did anything actually change?" guard used `git status
  --porcelain`, which counts untracked files: the step leaves
  `report.md`, `error.txt` and `applied.txt` in the tree, so the guard
  could never fire. It asks `git diff --quiet HEAD -- lib docs` instead.
  Rehearsed against a scratch remote with a stale card committed as HEAD:
  verify exits 1, the card is repaired from source, and the commit is
  exactly the four artifacts — 7 lines, all of them prices.
- **Why any of this exists, in one link.** DeepSeek's own
  [pi integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono)
  ships a `cost` block where v4-flash's cache-read rate is a 10x decimal
  slip (`0.028` for `0.0028`) and the v4-pro figures are exactly 4x the
  card — Azure's resale prices, pasted into DeepSeek's documentation, on
  a page written to be copied into an agent config. Verified live
  2026-08-20. A hand-maintained rate card rots; the vendor is the proof.

- **The hero instrument actually ticks.** It always repainted every second,
  but `formatCountdown` rounds to `46m`, so nothing on screen moved and the
  card read as a screenshot. The hero gets its own sharper formatter
  (`14:11:49`), a wall clock beside the timezone, and a flip animation —
  because the page's whole claim is that this is a rate you are standing
  in, and the cheapest possible proof is a digit that moves. The zone now
  renders as `PDT` rather than `America/Los_Angeles`, which was pushing
  the clock off the row; the IANA name is one hover away.
- **What the flip does to the bill, once instead of three times.** The
  card briefly showed a `→ next price` per row. Off-peak is exactly half
  of peak on every row, so that was one fact printed three times in a
  narrow column. It is now a single derived clause — `everything 2×` —
  computed from `RATES`, so it stops saying 2x the day the card stops
  meaning it.
- **Generated files say so, and get out of the way in review.**
  `docs/index.html` was generated and admitted it nowhere; it now carries
  a banner like `lib/client.js` always did. New `.gitattributes` marks
  the three artifacts `linguist-generated`, so the automated pricing PR
  opens on the one file a human has to check instead of on a 47 KB
  inlined bundle.
- **`build-pricing.mjs` is now `build-feed.mjs`.** Three `*-pricing`
  scripts and two `build-*` scripts, with one file in both families, made
  the flat `scripts/` directory harder to read than it needed to be. The
  three generators are now `build-client`, `build-site`, `build-feed`;
  the two that talk to DeepSeek are `verify-pricing` and `apply-pricing`.

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
