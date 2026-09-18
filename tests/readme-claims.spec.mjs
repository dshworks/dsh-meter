import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RATES, RETIRED } from '../lib/core.js'

/**
 * The READMEs quote the card. Nothing used to check that they still do.
 *
 * Two drifts this catches, both of which shipped: the Chinese README described
 * peak as every day for four weeks after weekends went off-peak, and both
 * READMEs would have kept printing V4 Flash's price as current after
 * DeepSeek cut it, because a table in prose is a copy nothing diffs.
 */

const README = {
  en: { text: readFileSync(new URL('../README.md', import.meta.url), 'utf8'), offpeak: 'off-peak', peak: 'peak', weekdays: 'Monday to Friday' },
  zh: { text: readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8'), offpeak: '空闲', peak: '高峰', weekdays: '周一至周五' },
}

/** `| **flash** off-peak | $0.003 / ¥0.02 | $0.15 / ¥1 | $0.6 / ¥4 |` -> the six numbers, or undefined. */
function quoted(text, name, label) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\|\\s*(?:\\*\\*)?${escape(name)}(?:\\*\\*)?\\s+${escape(label)}\\s*\\|(.+)\\|\\s*$`, 'm')
  const match = pattern.exec(text)
  if (match === null) return undefined
  const cells = match[1].split('|').map(cell => [...cell.matchAll(/[$¥]\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1])))
  return cells.map(([usd, cny]) => ({ usd, cny }))
}

describe.each(Object.entries(README))('README (%s)', (_locale, readme) => {
  it.each(Object.keys(RATES))('quotes the live card for %s at both tariffs', (model) => {
    const name = model.replace(/^deepseek-/, '')
    for (const tariff of ['offpeak', 'peak']) {
      const row = quoted(readme.text, name, readme[tariff])
      expect(row, `${name} ${readme[tariff]} row`).toBeDefined()
      const [hit, miss, out] = row
      for (const currency of ['usd', 'cny']) {
        expect([hit[currency], miss[currency], out[currency]]).toEqual([
          RATES[model][tariff][currency].hit,
          RATES[model][tariff][currency].miss,
          RATES[model][tariff][currency].out,
        ])
      }
    }
  })

  it('never quotes a retired model as live', () => {
    for (const model of Object.keys(RETIRED)) {
      const name = model.replace(/^deepseek-/, '')
      // Retired rows live inside a <details> block; the live table sits above the first one.
      const live = readme.text.slice(readme.text.indexOf('|---|'), readme.text.indexOf('<details>', readme.text.indexOf('|---|')))
      expect(quoted(live, name, readme.offpeak), `${name} in the live table`).toBeUndefined()
    }
  })

  it('restricts peak to weekdays wherever it states the windows', () => {
    const sentence = readme.text.split('\n').find(line => /01:00.04:00/.test(line) && /06:00.10:00/.test(line))
    expect(sentence).toBeDefined()
    expect(sentence).toContain(readme.weekdays)
  })
})
