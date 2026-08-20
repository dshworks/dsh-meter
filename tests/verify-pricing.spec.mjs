import { describe, expect, it } from 'vitest'

import { scrape, scrapeWindows, scrapeWindowsCn } from '../scripts/verify-pricing.mjs'

/**
 * The drift alarm's parsing half, against synthetic pages.
 *
 * The alarm itself only ever runs against the live site, so its own bugs are
 * invisible in the happy case: a parser that quietly reads the wrong row still
 * exits 0. The timezone conversion is the sharpest edge — the Chinese page
 * states the schedule in Beijing time, and a converter that is silently wrong
 * would agree with the card forever while both drifted from the source.
 */

const table = (rows) => `<html><body><table>${rows.join('')}</table></body></html>`
const row = (...cells) => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`

/** The published table's shape: rowspan labels, a spec section above the prices, a count below. */
const EN_PAGE = table([
  row('MODEL', 'deepseek-v4-flash', 'deepseek-v4-pro'),
  row('CONTEXT LENGTH', '1M'),
  row('MAX OUTPUT', 'MAXIMUM: 384K'),
  row('PRICING(1)', '1M INPUT TOKENS (CACHE HIT)', 'OFF-PEAK', '$0.007', '$0.022'),
  row('PEAK', '$0.014', '$0.044'),
  row('1M INPUT TOKENS (CACHE MISS)', 'OFF-PEAK', '$0.22', '$0.66'),
  row('PEAK', '$0.44', '$1.32'),
  row('1M OUTPUT TOKENS', 'OFF-PEAK', '$0.66', '$1.98'),
  row('PEAK', '$1.32', '$3.96'),
  row('Concurrency Limit(2)', '2500', '500'),
])

const CN_PAGE = table([
  row('模型', 'deepseek-v4-flash', 'deepseek-v4-pro'),
  row('输出长度', '最大 384K'),
  row('价格(1)', '百万tokens输入（缓存命中）', '空闲时段', '0.05元', '0.15元'),
  row('高峰时段', '0.10元', '0.30元'),
  row('百万tokens输入（缓存未命中）', '空闲时段', '1.5元', '4.5元'),
  row('高峰时段', '3.0元', '9.0元'),
  row('百万tokens输出', '空闲时段', '4.5元', '13.5元'),
  row('高峰时段', '9.0元', '27.0元'),
  row('并发限制(2)', '2500', '500'),
])

describe('the table parser', () => {
  it('reads both models at both tariffs from the English table', () => {
    const { models, rates } = scrape(EN_PAGE)
    expect(models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(rates['deepseek-v4-pro'].offpeak).toEqual({ hit: 0.022, miss: 0.66, out: 1.98 })
    expect(rates['deepseek-v4-flash'].peak).toEqual({ hit: 0.014, miss: 0.44, out: 1.32 })
  })

  it('reads the Chinese table, where prices carry a 元 suffix instead of a $ prefix', () => {
    const { rates } = scrape(CN_PAGE)
    expect(rates['deepseek-v4-pro'].offpeak).toEqual({ hit: 0.15, miss: 4.5, out: 13.5 })
    expect(rates['deepseek-v4-flash'].peak).toEqual({ hit: 0.1, miss: 3, out: 9 })
  })

  it('takes nothing from the rows that are not prices', () => {
    // `MAX OUTPUT | MAXIMUM: 384K` sits above the price section and the
    // concurrency row sits below it with two bare numbers in model order —
    // the shape of a price row without being one.
    for (const page of [EN_PAGE, CN_PAGE]) {
      const { rates } = scrape(page)
      for (const model of Object.keys(rates)) {
        expect(Object.keys(rates[model]).sort()).toEqual(['offpeak', 'peak'])
        for (const tariff of ['offpeak', 'peak']) {
          expect(Object.keys(rates[model][tariff]).sort()).toEqual(['hit', 'miss', 'out'])
          expect(Object.values(rates[model][tariff])).not.toContain(2500)
        }
      }
    }
  })

  it('refuses a page that no longer lists every model we price', () => {
    expect(() => scrape(table([row('MODEL', 'deepseek-v4-flash')]))).toThrow(/every model we price/)
  })

  it('refuses a price row whose number count stops matching the model count', () => {
    const short = table([
      row('MODEL', 'deepseek-v4-flash', 'deepseek-v4-pro'),
      row('PRICING(1)', '1M OUTPUT TOKENS', 'OFF-PEAK', '$0.66'),
    ])
    expect(() => scrape(short)).toThrow(/1 prices for 2 models/)
  })
})

describe('the peak-window footnotes', () => {
  it('reads the English footnote, which states UTC directly', () => {
    const page = '<p>(1) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC (all other hours are off-peak).</p>'
    expect(scrapeWindows(page)).toEqual([[1, 4], [6, 10]])
  })

  it('converts the Chinese footnote out of Beijing time', () => {
    const page = '<p>(1) 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。</p>'
    expect(scrapeWindowsCn(page)).toEqual([[1, 4], [6, 10]])
  })

  it('wraps a Beijing window that starts before 08:00 back into the previous UTC day', () => {
    // 02:00-06:00 Beijing is 18:00-22:00 UTC the day before. A converter that
    // subtracts without wrapping would produce negative hours and index the
    // schedule out of bounds.
    const page = '<p>高峰时段为北京时间 02:00 - 06:00（其余为空闲时段）。</p>'
    expect(scrapeWindowsCn(page)).toEqual([[18, 22]])
  })

  it('maps 08:00 Beijing to midnight UTC rather than to 24', () => {
    const page = '<p>高峰时段为北京时间 8:00 - 12:00（其余为空闲时段）。</p>'
    expect(scrapeWindowsCn(page)).toEqual([[0, 4]])
  })

  it('fails loudly when either footnote is gone, rather than reporting no windows', () => {
    expect(() => scrapeWindows('<p>nothing here</p>')).toThrow(/Peak hours are/)
    expect(() => scrapeWindowsCn('<p>nothing here</p>')).toThrow(/高峰时段/)
    expect(() => scrapeWindowsCn('<p>高峰时段为北京时间 9:00（其余为空闲时段）。</p>')).toThrow(/unpaired/)
  })
})
