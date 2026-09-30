import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const [version, directory] = process.argv.slice(2)
const supported = ['0.1.2-rc.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.2.0-rc.2']
if (!supported.includes(version) || !directory) throw new Error('Usage: install-test-runtime.mjs <tested DSH version> <new directory>')
const root = resolve(directory)
await mkdir(root, { recursive: true })
if ((await readdir(root)).length) throw new Error('Runtime directory must be empty; refusing to change an existing installation')
const names = JSON.parse(await readFile(new URL('./runtime-package-names.json', import.meta.url), 'utf8'))[version]
// Old DSH prerelease manifests use caret sibling ranges. An exact top-level
// package alone does not pin the runtime; every known sibling needs an override.
await writeFile(join(root, 'package.json'), JSON.stringify({ private: true,
  dependencies: { '@deepseek-ai/dsh': version },
  overrides: Object.fromEntries(names.map(name => [name, version])),
}, null, 2) + '\n')
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
if (result.status !== 0) process.exit(result.status ?? 1)
const packages = []
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) { await inspect(path); continue }
    let manifest
    try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; continue }
    if (manifest.name === '@deepseek-ai/dsh' || manifest.name.startsWith('@deepseek-ai/dsh-')) {
      packages.push({ name: manifest.name, version: manifest.version })
      if (manifest.version !== version) throw new Error(`Runtime drift: ${manifest.name}@${manifest.version}, expected ${version}`)
    }
    try { await inspect(join(path, 'node_modules')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
await inspect(join(root, 'node_modules'))
await writeFile(join(root, 'runtime-versions.json'), JSON.stringify(packages, null, 2) + '\n')
console.log(`Verified ${packages.length} DSH packages at exactly ${version}`)
