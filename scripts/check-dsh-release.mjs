// Can a user install this plugin the way dsh installs plugins, and does it
// then run on the host's harness instead of a copy of its own?
//
// The path users take is `dsh plugin --profile <p> add <spec>`
// (apps/cli/src/plugin.ts). It runs pnpm inside `$DSH_HOME/profiles/<p>` with
// `nodeLinker: hoisted` and `autoInstallPeers: false` (app-boot profile.ts),
// and dsh answers every import the profile does not physically hold from the
// running installation (0.1.7: app-boot profile-resolution/resolver.ts; 0.1.5:
// the `$DSH_HOME/profiles/node_modules` fallback). Two consequences:
//
// - peerDependencies are never installed. Their ranges have one reader: from
//   dsh 0.1.7-rc.1, `dsh plugin add` refuses a plugin whose `@deepseek-ai/dsh`
//   or `@deepseek-ai/dsh-*` peer range does not admit the running version
//   (app-boot plugin-compatibility.ts). It compares with `includePrerelease`,
//   so `^0.1.5-rc.1` admits 0.1.7-rc.2, and `^0.1.x` never admits 0.2.0.
// - `dependencies` ARE installed, hoisted to the profile root, and from then on
//   shadow the host's copy for every plugin in that profile. A plugin that
//   ships its own copy of something the host supplies runs two instances of it
//   and nothing says so.
//
// The previous version of this script installed dsh and the plugin into one
// fresh npm tree and counted harness packages at two versions. No user takes
// that path: npm installs peers, picks the highest match, and hoists. It
// reported ten "split" harness packages for 0.5.3 and 0.5.4 beside 0.1.7-rc.2
// where the real path had none, and it could not see the one real split --
// schemastery in `dependencies`, hoisted into the profile over the host's copy.
//
// So each check installs dsh <version> into a scratch prefix, points DSH_HOME
// at a scratch home, runs `dsh plugin --profile web add <spec>`, and asserts:
// (1) it exits 0, which on 0.1.7+ includes the peer-range gate, and (2) the
// profile's node_modules holds no package the dsh installation also supplies.
//
// Versions: `latest` must pass (DSH_VERSION=<version> replaces it, to prove
// any one version by hand). `next` and anything newer than `latest` are
// advisory: reported, never failing, because nobody can clear a red check
// against a version users do not have yet.
//
// Specs: `--tree-only` checks this tree, packed. Pull requests use it: the
// published package cannot be green on the PR that fixes it. The default also
// checks the published package, because a fix that never shipped is not a fix.
//
// Needs npm and pnpm on PATH (`dsh plugin` runs pnpm). Plain Node, no deps.
// Exit 0 clean, 1 drift, 2 could not check.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const TREE_ONLY = process.argv.includes('--tree-only')
const ROOT = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// Every dsh version installed here costs about half a gigabyte, so the scratch
// tree is removed in the `finally` below: a handful of local runs that left it
// behind filled the disk other checks were running on.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-release-'))
const report = []
let failed = false

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** The last lines of a failed command's output, for the report. */
const tail = (text, lines = 12) => text.trim().split('\n').slice(-lines).join('\n')

/** Something outside the plugin kept the check from finishing (exit 2). */
class CouldNotCheck extends Error {}
function couldNotCheck(message) {
  throw new CouldNotCheck(message)
}

/** Every package name under a node_modules tree, nested copies included. */
function packageNames(nodeModules, names = new Set()) {
  if (!existsSync(nodeModules)) return names
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue
    const scoped = entry.startsWith('@')
    for (const name of scoped ? readdirSync(join(nodeModules, entry)).map(inner => `${entry}/${inner}`) : [entry]) {
      names.add(name)
      packageNames(join(nodeModules, name, 'node_modules'), names)
    }
  }
  return names
}

/** Top-level entries of a hoisted node_modules, as name -> absolute path. */
function topLevel(nodeModules) {
  const entries = new Map()
  if (!existsSync(nodeModules)) return entries
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue
    const names = entry.startsWith('@') ? readdirSync(join(nodeModules, entry)).map(inner => `${entry}/${inner}`) : [entry]
    for (const name of names) entries.set(name, join(nodeModules, name))
  }
  return entries
}

/** One dsh installation per version per run: `npm install` of dsh dominates the runtime. */
const installs = new Map()
function installDsh(version) {
  if (installs.has(version)) return installs.get(version)
  const prefix = join(scratch, `dsh-${version}`)
  mkdirSync(prefix)
  writeFileSync(join(prefix, 'package.json'), '{"private":true}\n')
  try {
    run('npm', ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], prefix)
  } catch (error) {
    couldNotCheck(`installing dsh ${version} failed\n\n\`\`\`\n${tail(`${error.stdout ?? ''}${error.stderr ?? ''}`)}\n\`\`\``)
  }
  const install = { bin: join(prefix, 'node_modules', '.bin', 'dsh'), root: realpathSync(join(prefix, 'node_modules')) }
  install.supplies = packageNames(install.root)
  installs.set(version, install)
  return install
}

/**
 * Add `spec` to a fresh profile on dsh `version`, the way a user would, and
 * judge the profile it leaves behind.
 * `advisory` reports without failing the run.
 */
function check(version, spec, label, advisory = false) {
  const dsh = installDsh(version)
  const home = mkdtempSync(join(scratch, 'home-'))
  const added = spawnSync(dsh.bin, ['plugin', '--profile', 'web', 'add', spec], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  const output = `${added.stdout ?? ''}${added.stderr ?? ''}`
  if (added.error !== undefined) couldNotCheck(`could not run dsh ${version}: ${added.error.message}`)
  if (added.status === 127 || /pnpm was not found/.test(output)) couldNotCheck('pnpm is not on PATH; `dsh plugin` needs it')
  const verdict = advisory ? 'ADVISORY' : 'FAIL'

  if (added.status !== 0) {
    failed = failed || !advisory
    report.push(`- ${verdict}  ${label} -- \`dsh plugin add\` exited ${added.status}\n\n\`\`\`\n${tail(output)}\n\`\`\`\n`)
    return
  }

  // A symlink into the installation IS the host's copy (0.1.5 links bundle
  // packages this way); a real directory under a name the host supplies is a
  // second copy that every plugin in the profile now resolves first.
  const shadows = [...topLevel(join(home, 'profiles', 'web', 'node_modules'))]
    .filter(([name, path]) => {
      if (!dsh.supplies.has(name)) return false
      if (!lstatSync(path).isSymbolicLink()) return true
      return !realpathSync(path).startsWith(dsh.root + sep)
    })
    .map(([name]) => name)
    .sort()
  if (shadows.length === 0) {
    report.push(`- ok    ${label} -- installs, and the profile holds nothing dsh already supplies`)
    return
  }
  failed = failed || !advisory
  report.push(
    `- ${verdict}  ${label} -- the profile now carries its own copy of packages dsh supplies,`
    + ` shadowing the host's for every plugin in it:\n\n\`\`\`\n${shadows.join('\n')}\n\`\`\`\n`,
  )
}

let exitCode
try {
  let tags
  let versions
  try {
    tags = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], ROOT))
    versions = JSON.parse(run('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], ROOT))
  } catch (error) {
    couldNotCheck(`could not read dsh from npm: ${error.message}`)
  }
  const required = process.env.DSH_VERSION?.trim() || tags.latest
  report.push(`dsh ${process.env.DSH_VERSION ? 'DSH_VERSION' : '`latest` on npm'}: **${required}**\n`)

  // Into a scratch dir, never the repo root: a stray .tgz beside package.json is
  // one `git add -A` away from being committed.
  let tarball
  try {
    const packDir = join(scratch, 'pack')
    mkdirSync(packDir)
    tarball = join(packDir, run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', packDir], ROOT).trim().split('\n').pop())
  } catch (error) {
    couldNotCheck(`could not pack this tree: ${error.message}`)
  }

  // The exact version npm tags `latest`, not `@latest`. pnpm 11 resolves no
  // version younger than `minimumReleaseAge` (1440 minutes by default), so
  // `@latest` through `dsh plugin add` means the newest release at least a day
  // old: for a day after every publish it would test the release before, and
  // the daily run would open an issue about a fix that already shipped.
  let published = `${pkg.name}@latest`
  if (!TREE_ONLY) {
    try {
      published = `${pkg.name}@${run('npm', ['view', pkg.name, 'dist-tags.latest'], ROOT).trim()}`
    } catch (error) {
      couldNotCheck(`could not read ${pkg.name}'s dist-tags: ${error.message}`)
    }
  }
  check(required, tarball, `this tree on dsh ${required}`)
  if (!TREE_ONLY) check(required, published, `published ${published} on dsh ${required}`)

  // Ahead of the tag: what users get the day `latest` moves. Newer than `latest`
  // by npm's own version order, which is semver order.
  if (!TREE_ONLY) {
    const newer = v => versions.indexOf(v) > versions.indexOf(tags.latest)
    const ahead = [...new Set([tags.next, versions.at(-1)])].filter(v => v !== undefined && v !== required && newer(v))
    for (const version of ahead) {
      report.push(`\nnpm also serves **${version}**, ahead of \`latest\` (advisory):\n`)
      check(version, tarball, `this tree on dsh ${version}`, true)
      check(version, published, `published ${published} on dsh ${version}`, true)
    }
  }

  exitCode = failed ? 1 : 0
} catch (error) {
  // A bug in this script is not drift either: exit 2, never 1.
  report.push(`- COULD NOT CHECK  ${error instanceof CouldNotCheck ? error.message : error.stack}`)
  exitCode = 2
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(report.join('\n'))
process.exit(exitCode)
