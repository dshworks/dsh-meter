# Changelog

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
