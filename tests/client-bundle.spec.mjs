import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the browser bundle', () => {
  it('registers under the package name the harness serves it as', () => {
    // The harness keys its client module table by package name and serves the
    // bundle at /plugins/<name>/client.js; a bundle registering any other id
    // "loaded without registering" and the whole plugin table fails to load.
    const { name } = JSON.parse(read('package.json'))
    const bundle = read('lib/client.js')
    expect(bundle).toContain(`window.__ModuleLoader__.load({\n  id: ${JSON.stringify(name)},`)
  })
})

/** Pull one top-level dictionary literal out of the browser source. */
const dictionary = (name) => {
  const source = read('src/ui.js')
  const start = source.indexOf(`const ${name} = {`)
  if (start < 0) throw new Error(`client-bundle: no ${name} dictionary in src/ui.js`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end)
    .split('\n')
    .map(line => /^\s*'([^']+)':/.exec(line))
    .filter(Boolean)
    .map(([, key]) => key)
}

describe('the locale dictionaries', () => {
  it('carry the same keys in both languages', () => {
    // A key present in `en` and missing from `zh` does not fail — the
    // translator falls back to English — so the Chinese surface silently
    // half-translates. Nothing but this test notices.
    const en = dictionary('en')
    const zh = dictionary('zh')
    expect(en.length).toBeGreaterThan(30)
    expect(zh.filter(key => !en.includes(key)), 'keys in zh with no en original').toEqual([])
    expect(en.filter(key => !zh.includes(key)), 'keys in en with no zh translation').toEqual([])
  })

  it('declares no key twice', () => {
    for (const name of ['en', 'zh']) {
      const keys = dictionary(name)
      expect(new Set(keys).size, `${name} repeats a key`).toBe(keys.length)
    }
  })

  it('gives every placeholder in a key the same name in both languages', () => {
    // `{countdown}` renamed in translation renders the literal brace text.
    const source = read('src/ui.js')
    const values = (name) => {
      const start = source.indexOf(`const ${name} = {`)
      const end = source.indexOf('\n}\n', start)
      return Object.fromEntries(source.slice(start, end).split('\n')
        .map(line => /^\s*'([^']+)':\s*'(.*)',$/.exec(line))
        .filter(Boolean)
        .map(([, key, text]) => [key, [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()]))
    }
    const en = values('en')
    const zh = values('zh')
    for (const [key, params] of Object.entries(en)) {
      if (zh[key] === undefined) continue
      expect(zh[key], `placeholders differ for ${key}`).toEqual(params)
    }
  })
})
