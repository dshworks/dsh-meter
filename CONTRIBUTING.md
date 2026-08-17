# Contributing

Small repo, few rules.

## The one that bites

`lib/client.js` is **generated**. Edit `lib/core.js` (rate card, tariff
clock, fold) or `src/ui.js` (browser surface), then:

```sh
node scripts/build-client.mjs
```

`pnpm test` runs `--check` first and fails if you forgot. The point is
that the price table lives in exactly one file — a cost plugin with two
copies eventually shows two different numbers for the same session.

## Before opening a PR

```sh
pnpm install
pnpm test
```

- Prices change: update the table in `lib/core.js` **and** its `fetched:`
  date in the README, cite the
  [pricing page](https://api-docs.deepseek.com/quick_start/pricing), and
  add a `CHANGELOG.md` entry. Both READMEs carry the table; both change.
- New behavior gets a test. The fold is pure and the tariff clock is
  arithmetic, so there is no excuse not to.
- UI changes need a screenshot from a real dsh session, not a mock. If
  the visible readout changes, the README's images change with it.
- Keep the model surface empty **by default**. `dsh-meter` adds no tool
  and no prompt section unless `savingMode: true` turns on its one
  system-prompt contribution; a change that puts cost in the agent's
  context window any other way is a different plugin. Saving-mode text
  changes belong in `lib/core.js` (`tariffPrompt` and its default), not
  in a second copy.

## Translations

`README.md` and `README.zh.md` are peers — a change to one that affects
meaning belongs in both. The UI dictionaries live at the top of
`src/ui.js`; a new key needs both `en` and `zh` entries, and the `en`
object doubles as the fallback when no locale service is installed.
