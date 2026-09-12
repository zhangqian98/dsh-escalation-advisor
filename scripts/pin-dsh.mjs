// Pin every @deepseek-ai/* package in the dependency tree to one DSH version,
// so each CI cell exercises a complete isolated runtime closure.
//
// `npm install pkg@x` alone only covers the names the caller happened to list:
// sibling packages resolved transitively float on their own semver ranges and
// land at whatever the newest matching release is. `overrides` pins a name at
// EVERY level of the tree, which is the only reliable way to make the cell
// test one DSH release and nothing else.
//
// Packages not published at the matrix version (a sibling introduced later, or
// @deepseek-ai/cordis on its own release train) are left at their declared
// version — they cannot be part of a closure that never shipped them.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/pin-dsh.mjs <dsh-version>')
  process.exit(1)
}

// execFile cannot spawn the npm.cmd/npm.ps1 shims; run the CLI through node.
const NPM_CLI = process.env.npm_execpath
  ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npm = (args, options) => execFileSync(process.execPath, [NPM_CLI, ...args], options)

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const names = new Set()
for (const key of Object.keys(lock.packages ?? {})) {
  const match = /(?:^|\/)node_modules\/(@deepseek-ai\/[^/]+)$/.exec(key)
  if (match) names.add(match[1])
}
// Names outside the lockfile (fresh peer/dev additions) still get considered.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    if (name.startsWith('@deepseek-ai/')) names.add(name)
  }
}

const overrides = { ...(pkg.overrides ?? {}) }
const skipped = []
for (const name of [...names].sort()) {
  let exists = false
  try {
    exists = npm(['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().length > 0
  } catch { exists = false }
  if (exists) overrides[name] = version
  else skipped.push(name)
}
if (skipped.length) console.log('Not published at ' + version + ' (left as declared): ' + skipped.join(', '))

// An override may not contradict a declared spec, so declared names get their
// spec rewritten to the same exact pin; overrides then cover the transitive
// rest. Strict peer checks are relaxed for packages that cannot exist at the
// matrix version (skipped above) — the verify pass is what enforces isolation.
for (const name of Object.keys(overrides)) {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkg[section]?.[name] !== undefined) pkg[section][name] = version
  }
}
pkg.overrides = overrides
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], { stdio: 'inherit' })

// Verify: nothing @deepseek-ai that we pinned may resolve off-version, at any
// depth. `npm ls` exits nonzero on unmet peers but still prints the tree.
let listing = '{}'
try {
  listing = npm(['ls', '--json', '--all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
} catch (error) {
  listing = error.stdout || '{}'
}
const off = []
;(function walk(node, path) {
  for (const [name, info] of Object.entries(node.dependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/') && overrides[name] !== undefined && info.version !== undefined && info.version !== version) {
      off.push(`${path}/${name}@${info.version}`)
    }
    walk(info, path + '/' + name)
  }
})(JSON.parse(listing || '{}'), '')
if (off.length) {
  console.error('DSH packages resolved off-version:\n' + off.join('\n'))
  process.exit(1)
}
console.log(`Pinned ${Object.keys(overrides).length} @deepseek-ai packages to ${version}.`)

