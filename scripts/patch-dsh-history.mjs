import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, dirname, relative, isAbsolute } from 'node:path'

// A narrowly versioned maintenance patch for the released migration inventory.
// These records contain no core Session sequence references; their data survives
// adjacent format migrations verbatim. Other unknown historical types still fail.
export const ADVISOR_HISTORY_FIELDS = {
  'advisor/policy': { required: [], optional: ['version', 'mode', 'timeoutMs', 'inheritDefaultTools', 'allowTools', 'denyTools', 'escalationWait', 'continuousWait', 'toolPreset', 'tools'] },
  'advisor/model': { required: ['version', 'selection'], optional: [] },
  'advisor/identity': { required: ['version', 'invocationId', 'advisorId', 'requesterId', 'rootId', 'allowedTools'], optional: [] },
  'advisor/run': { required: ['version', 'id', 'requesterId', 'mode', 'turn', 'taskRevision', 'attempt', 'status', 'timestamp'], optional: ['step', 'fingerprint', 'score', 'childSessionId', 'severity', 'summary', 'question', 'responseText', 'error', 'usage', 'structuredFallback'] },
}

export function assertAdvisorHistoryPayload(event, fields = ADVISOR_HISTORY_FIELDS) {
  const fail = message => { throw new Error('Advisor historical payload: ' + message) }
  if (!Object.hasOwn(fields, event.type)) fail('unknown event ' + event.type)
  const definition = fields[event.type], data = event.data
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const string = value => { if (typeof value !== 'string') fail('expected string') }
  const count = value => { if (!Number.isSafeInteger(value) || value < 0) fail('expected non-negative integer') }
  const strings = value => { if (!Array.isArray(value)) fail('expected string array'); value.forEach(string) }
  const oneOf = (value, options) => { if (!options.includes(value)) fail('unexpected discriminator ' + String(value)) }
  if (!object(data)) fail('expected data object')
  if (definition.required.some(key => !Object.hasOwn(data, key))) fail('missing required field')
  if (Object.keys(data).some(key => !definition.required.includes(key) && !definition.optional.includes(key))) fail('unknown field')
  if (event.type === 'advisor/policy') {
    if (data.version !== undefined) oneOf(data.version, [2])
    if (Array.isArray(data.allowTools) && Array.isArray(data.denyTools)) { strings(data.allowTools); strings(data.denyTools) }
    else {
      if (data.version !== undefined) fail('versioned policy requires allow/deny arrays')
      oneOf(data.toolPreset, ['inherit', 'none', 'inspect', 'research', 'edit', 'custom'])
      if (data.toolPreset === 'custom' || data.tools !== undefined) strings(data.tools)
    }
    for (const key of ['escalationWait', 'continuousWait']) if (data[key] !== undefined) oneOf(data[key], ['inherit', 'block', 'background'])
    if (data.mode !== undefined) oneOf(data.mode, ['manual', 'escalate', 'continuous'])
    if (data.inheritDefaultTools !== undefined && typeof data.inheritDefaultTools !== 'boolean') fail('invalid tool inheritance')
    if (data.timeoutMs !== undefined) { count(data.timeoutMs); if (data.timeoutMs < 1000 || data.timeoutMs > 3600000) fail('invalid timeout') }
    return
  }
  oneOf(data.version, [1])
  if (event.type === 'advisor/model') {
    if (data.selection === null) return
    if (!object(data.selection) || Object.keys(data.selection).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) fail('invalid selection')
    for (const key of ['provider', 'model']) { string(data.selection[key]); if (!data.selection[key].trim()) fail('empty model route') }
    if (data.selection.reasoningEffort !== undefined) string(data.selection.reasoningEffort)
    return
  }
  if (event.type === 'advisor/identity') {
    for (const key of ['invocationId', 'advisorId', 'requesterId', 'rootId']) { string(data[key]); if (!data[key]) fail('empty identity') }
    strings(data.allowedTools)
    return
  }
  for (const key of ['id', 'requesterId', 'taskRevision', 'timestamp']) string(data[key])
  for (const key of ['turn', 'attempt']) count(data[key])
  if (data.attempt < 1) fail('invalid attempt')
  for (const key of ['step', 'score']) if (data[key] !== undefined) count(data[key])
  oneOf(data.mode, ['manual', 'escalation', 'continuous'])
  oneOf(data.status, ['reserved', 'started', 'delivered', 'stale', 'failed-transient', 'failed-permanent', 'cancelled', 'skipped'])
  if (data.severity !== undefined) oneOf(data.severity, ['none', 'nit', 'concern', 'blocker'])
  for (const key of ['fingerprint', 'childSessionId', 'summary', 'question', 'responseText', 'error']) if (data[key] !== undefined) string(data[key])
  if (data.structuredFallback !== undefined && typeof data.structuredFallback !== 'boolean') fail('invalid fallback flag')
  if (data.usage !== undefined) {
    if (!object(data.usage) || Object.keys(data.usage).some(key => !['inputTokens', 'outputTokens'].includes(key))) fail('invalid usage')
    count(data.usage.inputTokens); count(data.usage.outputTokens)
  }
}

const marker = '// dsh-escalation-advisor: explicit 0.1.5-rc.1 history compatibility'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function patchHistoryBundle(source, worker = false) {
  const replaceOnce = (text, from, to) => {
    if (text.split(from).length !== 2) throw new Error('Unexpected DSH migration implementation; refusing to patch')
    return text.replace(from, to)
  }
  if (source.includes(marker)) return source
  const inventory = 'const RELEASED_V0_EVENT_DISPOSITIONS = Object.freeze({'
  const validator = assertAdvisorHistoryPayload.toString()
  let patched = replaceOnce(source, inventory, marker + '\nconst ADVISOR_HISTORY_FIELDS = ' + JSON.stringify(ADVISOR_HISTORY_FIELDS) + ';\n' + validator + '\n' + inventory + '\n...Object.fromEntries(Object.entries(ADVISOR_HISTORY_FIELDS).map(([type, entry]) => [type, disposition(entry.required, entry.optional)])),')
  patched = replaceOnce(patched, 'function assertReleasedPayloadSemantics(event, version) {', 'function assertReleasedPayloadSemantics(event, version) {\nif (Object.hasOwn(ADVISOR_HISTORY_FIELDS, event.type)) return assertAdvisorHistoryPayload(event);')
  if (worker) patched = replaceOnce(patched, 'const request = parseRequest(node_worker_threads.workerData);', 'const request = parseRequest(node_worker_threads.workerData);\nfor (const type of Object.keys(ADVISOR_HISTORY_FIELDS)) KNOWN_SESSION_EVENT_TYPES.add(type);')
  return patched
}

export async function patchDshHistory(dshPackagePath, backupDirectory) {
  const packagePath = await realpath(resolve(dshPackagePath))
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.1.5-rc.1') throw new Error('This compatibility patch supports exactly DSH 0.1.5-rc.1')
  const runtime = createRequire(packagePath)
  const targets = [
    { package: '@deepseek-ai/dsh-session-format-v0-to-v1', file: 'lib/index.js', expected: '15ae26b90310d83b1b90a5e7cad9e2f34282fddaba2f19f2fd2232382065603d', worker: false, backup: 'format-v0.index.js' },
    { package: '@deepseek-ai/dsh-session-persistence-jsonl', file: 'lib/worker.cjs', expected: 'b067a35a421d5a5313b1e197a00bcc829d8d6921d2829503d4604c13e226fd64', worker: true, backup: 'persistence.worker.cjs' },
  ]
  const changes = []
  for (const target of targets) {
    const owner = dirname(await realpath(runtime.resolve(target.package + '/package.json')))
    const path = await realpath(resolve(owner, target.file))
    const rel = relative(owner, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Patch target leaves its package')
    const bytes = await readFile(path), source = bytes.toString('utf8')
    const patched = patchHistoryBundle(source, target.worker)
    if (patched === source) { changes.push({ path, alreadyPatched: true, after: hash(bytes) }); continue }
    if (hash(bytes) !== target.expected) throw new Error('Unexpected package checksum; refusing to overwrite local edits: ' + path)
    changes.push({ ...target, path, bytes, patched })
  }
  await mkdir(backupDirectory, { recursive: true })
  for (const change of changes) if (!change.alreadyPatched) await writeFile(resolve(backupDirectory, change.backup), change.bytes, { flag: 'wx' })
  const applied = []
  try {
    for (const change of changes) if (!change.alreadyPatched) { applied.push(change); await writeFile(change.path, change.patched) }
  } catch (error) {
    for (const change of applied) await writeFile(change.path, change.bytes)
    throw error
  }
  const result = changes.map(change => ({ path: change.path, alreadyPatched: !!change.alreadyPatched, before: change.expected, after: change.alreadyPatched ? change.after : hash(change.patched) }))
  await writeFile(resolve(backupDirectory, 'patch-manifest.json'), JSON.stringify(result, null, 2))
  return result
}

export async function runCli() {
  const [packagePath, backupDirectory] = process.argv.slice(2)
  if (!packagePath || !backupDirectory) throw new Error('Usage: patch-dsh-history.mjs <absolute dsh package.json> <backup directory>')
  console.log(JSON.stringify(await patchDshHistory(packagePath, backupDirectory), null, 2))
}
if (import.meta.main) await runCli()
