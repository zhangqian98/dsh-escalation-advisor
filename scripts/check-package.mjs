import { spawnSync } from 'node:child_process'

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm run pack:check')

const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  windowsHide: true,
})
if (packed.status !== 0) {
  process.stderr.write(packed.stderr)
  process.exit(packed.status ?? 1)
}

const result = JSON.parse(packed.stdout)[0]
if (!result || result.name !== 'dsh-escalation-advisor') throw new Error('npm pack returned the wrong package')
const files = new Set(result.files.map(entry => entry.path))
const required = [
  'lib/index.js',
  'lib/index.d.ts',
  'client/index.js',
  'cordis.patch.yml',
  'scripts/patch-dsh-history.mjs',
  'README.md',
  'README.zh-CN.md',
  'DESIGN.md',
  'LICENSE',
  'package.json',
]
for (const path of required) if (!files.has(path)) throw new Error(`release tarball is missing ${path}`)

const forbidden = ['src/', 'test/', 'node_modules/', '.github/']
for (const path of files) {
  const prefix = forbidden.find(candidate => path.startsWith(candidate))
  if (prefix) throw new Error(`release tarball unexpectedly contains ${path}`)
}

console.log(JSON.stringify({
  name: result.name,
  version: result.version,
  filename: result.filename,
  files: files.size,
  unpackedSize: result.unpackedSize,
  requiredFiles: required,
}, null, 2))
