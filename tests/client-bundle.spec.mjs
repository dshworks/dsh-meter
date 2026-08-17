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
