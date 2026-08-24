import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  PEAK_WINDOWS_UTC, RATES, TIME_OF_USE_FROM, WEEKEND_OFFPEAK_FROM, tariffSchedule,
} from '../lib/core.js'

/** Read the weekend rows out of the feed itself, so the test cannot drift from what is published. */
const weekend = { daysBeijingOf: feed => feed.timeOfUse.weekend.daysBeijing }

/**
 * docs/pricing.json is published at a stable URL for other people's cost
 * estimators to read. Its staleness is already caught by
 * `build-feed.mjs --check`; what these tests pin is the part a
 * regeneration would happily rewrite — the shape strangers pin against, and
 * the rule that a retired price never appears as a live one.
 */
const feed = JSON.parse(readFileSync(new URL('../docs/pricing.json', import.meta.url), 'utf8'))

describe('the published pricing feed', () => {
  it('declares a schema version, so a consumer can refuse a shape it does not know', () => {
    expect(feed.schema).toBe('dsh-meter/pricing@2')
  })

  it('cites the page each currency came from', () => {
    expect(feed.source.usd).toMatch(/^https:\/\/api-docs\.deepseek\.com\//)
    expect(feed.source.cny).toMatch(/^https:\/\/api-docs\.deepseek\.com\/zh-cn\//)
  })

  it('quotes only tariffs a new request can actually be billed at', () => {
    for (const [name, model] of Object.entries(feed.models)) {
      expect(Object.keys(model.rates).sort()).toEqual(['offpeak', 'peak'])
      // The pre-switchover card is reachable, but only under `retired`, and
      // only with the date it stopped applying attached.
      //
      // A model that never billed flat publishes no `retired` key at all,
      // rather than an empty card carrying only `until` and `note` -- a
      // consumer reading `retired.flat.usd.out` off that would get
      // `undefined` from a block that looks published.
      if (RATES[name].flat === undefined) {
        expect(model.retired).toBeUndefined()
        continue
      }
      expect(model.retired.flat.until).toBe(new Date(TIME_OF_USE_FROM).toISOString())
    }
  })

  it('publishes every live rate exactly as the card holds it', () => {
    for (const [name, byTariff] of Object.entries(RATES)) {
      for (const tariff of ['offpeak', 'peak']) {
        for (const currency of ['usd', 'cny']) {
          expect(feed.models[name].rates[tariff][currency]).toEqual(byTariff[tariff][currency])
        }
      }
      if (byTariff.flat === undefined) continue
      for (const currency of ['usd', 'cny']) {
        expect(feed.models[name].retired.flat[currency]).toEqual(byTariff.flat[currency])
      }
    }
  })

  it('carries the tariff clock, so a consumer needs no window arithmetic', () => {
    expect(feed.timeOfUse.scheduleBeijing).toEqual(tariffSchedule())
    expect(feed.timeOfUse.scheduleBeijing).toHaveLength(7)
    for (const day of feed.timeOfUse.scheduleBeijing) expect(day).toHaveLength(24)
    expect(feed.timeOfUse.peakWindowsUtc.map(w => [w.startHourUtc, w.endHourUtc])).toEqual(PEAK_WINDOWS_UTC)
    expect(feed.timeOfUse.sinceEpochMs).toBe(TIME_OF_USE_FROM)
  })

  it('drops the day-blind @1 schedule rather than deprecating it', () => {
    // A widened-but-kept `scheduleUtc` would let a reader that ignores the new
    // field stay silently wrong. Removing the key turns that into a crash.
    expect(feed.schema).toBe('dsh-meter/pricing@2')
    expect(feed.timeOfUse.scheduleUtc).toBeUndefined()
    expect(feed.timeOfUse.changedInV2).toMatch(/scheduleUtc/)
  })

  it('publishes the weekend rule with the date it started', () => {
    const { weekend } = feed.timeOfUse
    expect(weekend.offPeakAllDay).toBe(true)
    expect(weekend.daysBeijing).toEqual([0, 6])
    // The boundary is what keeps a ledger from refunding money the account
    // never got back: a peak session on Sun 2026-08-17 really did bill peak.
    expect(weekend.sinceEpochMs).toBe(WEEKEND_OFFPEAK_FROM)
    expect(weekend.since).toBe('2026-08-22T16:00:00.000Z')
    // DeepSeek never put this in the changelog, so the only citable source is
    // the archived footnote. Losing that link loses the provenance entirely.
    expect(weekend.note).toMatch(/web\.archive\.org/)
  })

  it('labels the weekend off-peak for all 24 hours, on both rows', () => {
    for (const weekday of weekend.daysBeijingOf(feed)) {
      expect(feed.timeOfUse.scheduleBeijing[weekday]).toEqual(Array(24).fill('offpeak'))
    }
    // And the weekdays must still carry the published peak hours, so an
    // all-off-peak grid cannot pass this file.
    const peakCells = feed.timeOfUse.scheduleBeijing.flat().filter(t => t === 'peak')
    expect(peakCells).toHaveLength(35)
  })

  it('states the Beijing anchor that makes a UTC schedule safe to publish', () => {
    const { anchor } = feed.timeOfUse
    expect(anchor.utcOffsetHours).toBe(8)
    // If China ever observed DST again, fixed UTC hours would drift twice a
    // year and the whole schedule representation would need rethinking.
    expect(anchor.observesDaylightSaving).toBe(false)
    // Display strings must be the same windows, not a second source of truth.
    const fromUtc = PEAK_WINDOWS_UTC.map(([start, end]) => {
      const local = hour => String((hour + anchor.utcOffsetHours) % 24).padStart(2, '0')
      return `${local(start)}:00-${local(end)}:00`
    })
    expect(anchor.peakWindowsBeijing).toEqual(fromUtc)
  })

  it('tells a reader the one way to misread it', () => {
    // The failure this guards against is real and silent: indexing a
    // UTC-indexed schedule with local hours returns a plausible tariff that is
    // wrong by 2x for most of the world.
    expect(feed.timeOfUse.readingNow).toMatch(/getUTCHours/)
    expect(feed.timeOfUse.readingNow).toMatch(/getUTCDay/)
    expect(feed.timeOfUse.readingNow).toMatch(/[Nn]ever index with local hours/)
    // Both indices must come off the same shifted instant. Mixing the reader's
    // weekday with the vendor's hour is wrong for eight hours of every day.
    expect(feed.timeOfUse.readingNow).toMatch(/BOTH indices/)
    // And no field may claim to know what time it is — a cached copy would lie.
    for (const key of ['now', 'currentTariff', 'asOf', 'generatedAt']) {
      expect(feed.timeOfUse[key]).toBeUndefined()
      expect(feed[key]).toBeUndefined()
    }
  })

  it('defines the three billed buckets, which is the half a price list cannot give you', () => {
    expect(Object.keys(feed.buckets).sort()).toEqual(['hit', 'miss', 'out'])
    for (const bucket of Object.values(feed.buckets)) expect(bucket.from).toMatch(/usage\./)
  })
})
