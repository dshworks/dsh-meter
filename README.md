<table>
<tr>
<td width="42%" valign="top">

# dsh-meter

English | [中文](README.zh.md)

### DeepSeek bills by time of day now. This is the meter for it.

Two peak windows a day, off-peak at half the peak rate. Cost stopped
being a number you read afterwards and became **a rate you are standing
in**.

One line under the composer: what this session cost, which tariff is
running, how long until it flips. Hover it for the tariff clock, the
cache economics, and your balance.

[![site](https://img.shields.io/badge/site-dsh.works%2Fdsh--meter-00c2e9)](https://dsh.works/dsh-meter/)
[![ci](https://github.com/dshworks/dsh-meter/actions/workflows/ci.yml/badge.svg)](https://github.com/dshworks/dsh-meter/actions/workflows/ci.yml)
[![powered by dsh](https://img.shields.io/badge/powered__by-dsh-4D6BFE?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</td>
<td width="58%" valign="top">

<img src="https://raw.githubusercontent.com/dshworks/dsh-meter/main/docs/meter-light.png" alt="The meter's line under the composer, with its card open: session total, tariff clock, cache and input breakdown, and account balance" width="420">

</td>
</tr>
</table>

## Install

```sh
dsh plugin --profile web add @dshworks/dsh-meter
dsh --profile web
```

`dsh plugin` forwards to pnpm, so pnpm must be on PATH. Nothing else to
configure: the meter appears under the composer as soon as a session bills
its first request.

## The line

```
2 turns · 2 steps | LLM 3.1s | TTFT avg 1.3s · 41 tok/s | Cache hit 50% | Input 44.3K tok
                    ¥0.0672  |  peak  |  off-peak in 48m
```

The harness's own stats line, untouched, and ours under it. This plugin
**adds** a line — it does not shadow the shipped one, which is what a
cost plugin has to do to append to it.

Hover or focus for the card. Inside a peak window the tariff is called
out in amber and the countdown runs to the next off-peak hour:

<img src="https://raw.githubusercontent.com/dshworks/dsh-meter/main/docs/meter-dark.png" alt="The same card in dark mode inside a peak window" width="620">

| The card shows | Why it is there |
|---|---|
| The session total, request count, models | The number, once, at full size |
| A 24-hour tariff strip in **your** local time, with a live now-marker | Peak windows are published in UTC. Reading them off a strip beats doing timezone arithmetic at 11pm |
| cache hits / fresh input / output — tokens and money on each | A cache hit costs **1/30th** of a miss. This is the row that shows whether your prompt prefix is stable |
| Your account balance, and how much of it is granted credit | Granted balance expires; topped-up balance does not |
| The same tokens priced under the other tariff | Before the switchover: what the new rates do to this session. After: what waiting for off-peak is worth |
| What the cache saved | The counterfactual where every hit had been a miss |

## Proof

Live-verified against dsh `0.1.0-rc.6` on 2026-08-15, in a real web
session on DeepSeek-V4-Pro — not a mock:

| Claim | How it was checked |
|---|---|
| Loads in a stock web profile | `dsh --profile web --dump-config` lists it; `/plugins/@dshworks/dsh-meter/client.js` serves 200 |
| The readout is correct | 22.2K cache-miss input on v4-pro at the flat rate = ¥0.0665; the line and the card agree with the harness's own token counts |
| Survives a restart | Server restarted, session reopened cold — the projection replays from the durable log at the same figure |
| Both themes, both tariff states | Light and dark, flat and peak, captured above — this predates the 08-16 switchover, so the flat readout is one a new session no longer reaches |
| Currency detection | A live account returns `{"currency":"cny", ...}` and the whole surface switches to ¥ with no configuration |
| 50 tests, CI green | `pnpm test` — the fold, the tariff clock, the rate card, the balance reader, and the generated-bundle sync check |

## Two currencies, no conversion

DeepSeek publishes **two independent rate cards** — USD for the
international platform, CNY for the mainland one. An account is billed
against exactly one of them, and neither table is a conversion of the
other, so a plugin that picks with an exchange rate is wrong twice.

`dsh-meter` computes both and lets the account decide. `GET
/user/balance` returns the currency the account is denominated in — a
live account lists both rows with only one funded — so the meter reads
the funded row and shows that side. Nothing to configure, nothing to
guess from your interface language.

The balance request runs on the host, keyed by the same credential seam
the LLM adapter uses; the browser gets parsed numbers over
`GET /dsh-meter/balance` and never the key. It fires when the meter
mounts and when you open the card, not on a schedule — set
`balance: false` to turn the whole thing off and the meter keeps working.

## The rate card

Carried verbatim in [`lib/core.js`](lib/core.js), per 1M tokens.

| | cache hit | cache miss | output |
|---|---|---|---|
| **v4-flash** off-peak | $0.007 / ¥0.05 | $0.22 / ¥1.5 | $0.66 / ¥4.5 |
| v4-flash peak | $0.014 / ¥0.10 | $0.44 / ¥3 | $1.32 / ¥9 |
| **v4-pro** off-peak | $0.022 / ¥0.15 | $0.66 / ¥4.5 | $1.98 / ¥13.5 |
| v4-pro peak | $0.044 / ¥0.30 | $1.32 / ¥9 | $3.96 / ¥27 |

Peak is **01:00–04:00 and 06:00–10:00 UTC** (09:00–12:00 and 14:00–18:00
Beijing). Every other hour is off-peak, including the two-hour gap
between the windows. Off-peak is exactly half of peak — and still above
the flat rate it replaced, by about 2.3x on output.

<details>
<summary>The retired flat card, kept to reprice history</summary>

Billed at every hour until **2026-08-16 16:00 UTC**. Upstream no longer
publishes it; the meter keeps it because a session logged before the
switchover must still cost what it actually cost.

| | cache hit | cache miss | output |
|---|---|---|---|
| **v4-flash** flat | $0.0028 / ¥0.02 | $0.14 / ¥1 | $0.28 / ¥2 |
| **v4-pro** flat | $0.003625 / ¥0.025 | $0.435 / ¥3 | $0.87 / ¥6 |

Against it, pro rose 6x/12x on cached input, 1.5x/3x on cache-miss input
and 2.3x/4.6x on output (off-peak/peak). The steepest rise is on the
cheapest token, which is the one an agent sends most of.

</details>

Source: <https://api-docs.deepseek.com/quick_start/pricing>, re-checked
2026-08-17 — and against a real bill: 188,542 cache-miss tokens on pro,
off-peak, settled at ¥0.84, i.e. ¥4.46/1M against the published 4.5.

## How the money is counted

| Behavior | Detail |
|---|---|
| Source of truth | Provider-reported token counts in the durable session log. Nothing is sampled or inferred |
| Tariff per request | Decided by **dispatch** time (`step/start`), not by when the answer finished. A request sent at 00:59 UTC is billed off-peak even if it streams into the peak window, and a session that spans a boundary is billed correctly on both sides |
| Billed buckets | `inputTokens` at the cache-MISS rate, `cacheReadTokens` at the cache-HIT rate, `outputTokens` at the output rate. The harness reports these disjoint (the DeepSeek adapter subtracts hits out of `prompt_tokens`), and reasoning tokens are already inside output |
| Cache writes | Folded into the miss bucket. DeepSeek publishes no separate write price and bills a first-time prompt at the miss rate; the DeepSeek adapter never reports one |
| Failed requests | A step's usage chunk is counted even when the request then fails; the finalized message REPLACES that sample rather than adding to it, including when the message names a different model than the request header did |
| Unknown models | Counted and named, never priced. A model with no published rate contributes tokens and requests to the readout and zero money, and the card says so |
| Durability | One session projection (`costMeter`), folded from the log. It survives paging, compaction, a reload, and a server restart, and rides the standard projection cache |

## Model Experience

None. `dsh-meter` adds no tool, no system-prompt section, no message, and
no model call; it does not touch the request. Cost belongs to the person
paying, not to the agent's context window.

#### KV Cache effect

None — the plugin never participates in a request.

## Configuration

Everything below is a validated config field, set in your profile's
`cordis.patch.yml`:

```yaml
- id: dsh-meter
  config:
    currency: cny        # pin a rate card instead of detecting it
    balance: false       # never call /user/balance
```

| Key | Default | Meaning |
|---|---|---|
| `currency` | `auto` | Which rate card to show: `auto` (the account's own balance currency, then the interface language), `usd`, or `cny` |
| `balance` | `true` | Serve the account balance to the Web UI |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference holding the API key |
| `baseUrl` | `https://api.deepseek.com` | Origin the balance is read from |
| `balanceTtlMs` | `300000` | Minimum age before a card opening refetches the balance |
| `balanceTimeoutMs` | `4000` | Per-request timeout for the balance read |

## Development

```sh
pnpm install
pnpm test                        # bundle-sync check, then vitest
node scripts/build-client.mjs    # regenerate lib/client.js after editing core/ui
```

`lib/core.js` holds the rate card, the tariff clock, and the fold.
`lib/balance.js` is the account reader. `src/ui.js` is the browser
surface. `scripts/build-client.mjs` inlines core + ui into
`lib/client.js`, the bundle the harness serves — so the price table
exists in exactly one file, and `pnpm test` fails if the generated bundle
drifts from it.

## Known limitations

- **It is an estimate, not the invoice.** List prices times reported
  tokens. Promotional pricing and any relay in front of the API are
  invisible to it.
- **Tariff is inferred from the dispatch timestamp**, which is the
  harness's clock. A request DeepSeek receives on the far side of a
  boundary can bill differently by a second or two.
- **Non-DeepSeek routes are not priced.** Their tokens are counted and
  their model named; the card reports them as unpriced instead of quietly
  applying DeepSeek's rates to someone else's API.
- **The rate card is compiled in.** DeepSeek changes prices; this plugin
  ships the time-of-use card as re-checked on 2026-08-17 and needs a
  release to follow the next change.
- **Web only.** The projection is available to any surface, but the
  readout is built for the Web UI. There is no TUI line.

## Prior art

The dsh registry lists [~50 cost and usage
plugins](https://github.com/dshworks/awesome-dsh-plugins/blob/main/lists/usage-cost.md);
several arrived the same week DeepSeek dated the switchover, and reading
them shaped this one. The cache-savings framing comes from
[`deepseek-cli`](https://github.com/thevibeworks/deepseek-cli)'s local
usage ledger.

## License

MIT
