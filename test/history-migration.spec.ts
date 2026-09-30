import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const maintenance = await import(new URL('../scripts/patch-dsh-history.mjs', import.meta.url).href)
const validate = maintenance.assertAdvisorHistoryPayload

describe('Advisor historical migration schema', () => {
  it('validates all four owned records without changing their payloads', () => {
    const events = [
      { type: 'advisor/policy', data: { version: 2, mode: 'continuous', timeoutMs: 600000, allowTools: ['read'], denyTools: ['write'], escalationWait: 'inherit', continuousWait: 'background' } },
      { type: 'advisor/model', data: { version: 1, selection: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } } },
      { type: 'advisor/identity', data: { version: 1, invocationId: 'invocation', advisorId: 'child', requesterId: 'root', rootId: 'root', allowedTools: ['read'] } },
      // Complete AdvisorRunRecord as written by alpha.27 consult(): every field
      // a delivered multi-turn manual consultation actually persists.
      { type: 'advisor/run', data: { version: 1, id: 'review', requesterId: 'root', mode: 'manual', turn: 4, step: 2, taskRevision: 'old:42', taskAnchor: 12, attempt: 1, status: 'delivered', timestamp: '2026-09-10T00:00:00Z', collectorId: 'review#2.1.nonce', turns: 2, childSessionId: 'child', fingerprint: 'fp', score: 3, severity: 'concern', summary: 's', question: 'q', responseText: 'Original reply', verdictTool: 'advisor_verdict', structuredFallback: false, usage: { inputTokens: 10, outputTokens: 5 } } },
    ]
    const original = structuredClone(events)
    events.forEach(event => validate(event))
    expect(events).toEqual(original)
    expect(() => validate({ type: 'advisor/policy', data: { toolPreset: 'custom', tools: ['grep'] } })).not.toThrow()
    expect(() => validate({ type: 'advisor/model', data: { version: 1, selection: null } })).not.toThrow()
  })

  it('refuses foreign types, unknown versions, extra fields and malformed permissions', () => {
    for (const event of [
      { type: 'foreign/required', data: {} },
      { type: 'advisor/model', data: { version: 99, selection: null } },
      { type: 'advisor/model', data: { version: 1, selection: null, extra: true } },
      { type: 'advisor/policy', data: { version: 2, allowTools: ['read'], denyTools: null } },
      { type: 'advisor/policy', data: { version: 2, allowTools: [], denyTools: [], timeoutMs: -1 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', collectorId: '' } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', turns: 0 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', turns: 1.5 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', taskAnchor: -1 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', taskAnchor: 'seq' } },
    ]) expect(() => validate(event)).toThrow()
  })
})


// These tests execute copies of the exact deployed bundles. They never write to
// the installed runtime or a user history. Set DSH_RUNTIME_PACKAGE_JSON to the
// 0.2.0-rc.2 CLI package.json (the runtime suite already uses that anchor).
const runtimeAnchor = process.env.DSH_RUNTIME_PACKAGE_JSON
const currentRuntime = runtimeAnchor !== undefined
  && JSON.parse(readFileSync(resolve(runtimeAnchor), 'utf8')).version === '0.2.0-rc.2'
// Execute the shipped CLI under plain Node: the patch embeds a function's source,
// so Vite's transformed Function#toString is intentionally not the shipped patch.
const patchCopiedRuntime = async (packagePath: string, backup: string) => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/patch-dsh-history.mjs', import.meta.url)), packagePath, backup])
  return JSON.parse(stdout)
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type Row = { type: string; seq: number; time: number; data: Record<string, any>; surfaceOp?: unknown; ignorable?: boolean }
type WorkerResult = { ok: boolean; message?: string; result?: { bytes: number; digest: string } }
const dense = (rows: Omit<Row, 'seq' | 'time'>[]): Row[] => rows.map((row, seq) => ({ ...row, seq, time: seq + 2 }))
const user = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
const runPayload = () => ({
  version: 1, id: 'review', requesterId: 'fixture', mode: 'manual', turn: 1,
  taskRevision: 'fixture:0:0:0:0', taskAnchor: 0, attempt: 1, status: 'delivered',
  timestamp: '2026-09-30T00:00:00Z', collectorId: 'review#0.1.nonce', turns: 2,
  childSessionId: 'child', summary: 'retained summary', responseText: 'Original reply',
  verdictTool: 'advisor_verdict', structuredFallback: false,
  provider: 'mock', model: 'advisor', reasoningEffort: '', advisorProfile: 'reviewer',
  toolCeiling: ['read'], toolSnapshotHash: 'hash', routingReason: 'explicit',
  usage: { inputTokens: 10, outputTokens: 5 },
})
const ownedRows = (): Row[] => dense([
  { type: 'advisor/policy', data: { version: 3, allowTools: ['read'], denyTools: ['write'], defaultProfileId: 'reviewer', allowedProfileIds: ['reviewer'], triggers: { manual: 'on' } } },
  { type: 'advisor/model', data: { version: 2, selection: { provider: 'mock', model: 'advisor' }, defaultProfileId: 'reviewer', allowedProfileIds: ['reviewer'] } },
  { type: 'advisor/identity', data: { version: 1, invocationId: 'invocation', advisorId: 'child', requesterId: 'fixture', rootId: 'fixture', allowedTools: ['read'] } },
  { type: 'advisor/run', data: runPayload() },
  { type: 'user/message', surfaceOp: 'append', data: { ...user('advice'), source: { kind: 'plugin:dsh-escalation-advisor', form: 'notice', summary: 'review', customAttribution: { seq: 42, note: 'retain all fields' } } } },
])

describe.skipIf(!currentRuntime)('pinned DSH 0.2.0-rc.2 history safety', () => {
  let root: string, packagePath: string, workerPath: string, originalWorkerPath: string
  let workerSource: string
  let migrations: any[]
  let format: any, v4: any
  let fixtureCounter = 0
  const beforeMigrationBundles = new Map<string, Buffer>()

  beforeAll(async () => {
    const runtime = createRequire(resolve(runtimeAnchor!))
    root = await mkdtemp(join(tmpdir(), 'advisor-history-bundles-'))
    const scope = join(root, 'node_modules', '@deepseek-ai')
    await mkdir(scope, { recursive: true })
    // Copy every patch target and every migration under test; only immutable
    // dependencies are linked to the runtime. No test patch can reach a symlink.
    for (const name of ['dsh', 'dsh-session-persistence-jsonl', 'dsh-session-format-v0-to-v1', 'dsh-session-format-v1-to-v2', 'dsh-session-format-v2-to-v3', 'dsh-session-format-v3-to-v4']) {
      const original = runtime.resolve('@deepseek-ai/' + name + '/package.json')
      const target = join(scope, name)
      await mkdir(join(target, 'lib'), { recursive: true })
      await copyFile(original, join(target, 'package.json'))
      if (name === 'dsh') continue
      const filename = name === 'dsh-session-persistence-jsonl' ? 'worker.cjs' : 'index.js'
      await copyFile(join(dirname(original), 'lib', filename), join(target, 'lib', filename))
      if (filename === 'index.js') beforeMigrationBundles.set(join(target, 'lib', filename), await readFile(join(target, 'lib', filename)))
    }
    for (const name of ['dsh-session-format', 'dsh-util-values', 'dsh-llm']) {
      await symlink(dirname(runtime.resolve('@deepseek-ai/' + name + '/package.json')), join(scope, name), 'dir')
    }
    packagePath = join(scope, 'dsh', 'package.json')
    workerPath = join(scope, 'dsh-session-persistence-jsonl', 'lib', 'worker.cjs')
    originalWorkerPath = join(dirname(workerPath), 'worker.original.cjs')
    await copyFile(workerPath, originalWorkerPath)
    workerSource = await readFile(workerPath, 'utf8')
    expect(sha256(workerSource)).toBe('cadd901598e2bb8a847409a980f59deea639eeadf21e30da324fb674a4ed8038')
    const load = (name: string) => import(pathToFileURL(join(scope, name, 'lib', 'index.js')).href)
    format = await load('dsh-session-format')
    const v0 = await load('dsh-session-format-v0-to-v1')
    const v1 = await load('dsh-session-format-v1-to-v2')
    const v2 = await load('dsh-session-format-v2-to-v3')
    v4 = await load('dsh-session-format-v3-to-v4')
    migrations = [v0.sessionFormatV0ToV1, v1.sessionFormatV1ToV2, v2.sessionFormatV2ToV3, v4.createSessionFormatV3ToV4([])]
    await patchCopiedRuntime(packagePath, join(root, 'backup'))
  }, 15000)

  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  async function verify(rows: Row[], patched = true, version = 4): Promise<WorkerResult> {
    const path = join(root, 'fixture-' + fixtureCounter++ + '.jsonl')
    const bytes = [JSON.stringify({ type: 'session', version, id: 'fixture', createdAt: 1, isSeeded: false, delegationDepth: 0 }), ...rows.map(row => JSON.stringify(row))].join('\n') + '\n'
    await writeFile(path, bytes)
    const worker = new Worker(patched ? workerPath : originalWorkerPath, {
      execArgv: [], workerData: { path, compression: 'none', expectedId: 'fixture', expectedEventCount: rows.length },
    })
    try {
      const result = await new Promise<WorkerResult>((resolveResult, reject) => {
        worker.once('message', resolveResult)
        worker.once('error', reject)
        worker.once('exit', code => reject(new Error('Verifier exited without a result: ' + code)))
      })
      expect(await readFile(path, 'utf8')).toBe(bytes)
      if (result.ok) expect(result.result).toMatchObject({ bytes: Buffer.byteLength(bytes), digest: sha256(bytes) })
      return result
    } finally { await worker.terminate() }
  }

  function migrate(version: number, rows: Row[]) {
    const migration = migrations[version]
    const sourceHeader = { version, id: 'fixture', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const stage = migration.createStage({ sourceHeader, targetHeader: migration.migrateHeader(sourceHeader), sourceInheritedEventCount: 0, sourceKind: 'decoded' })
    const output = new format.SessionFormatEventCollector()
    for (const row of rows) stage.transformEvent(row, output)
    stage.finish(output)
    return output.values as Row[]
  }

  it('reproduces the isolated-worker refusal before the patch', async () => {
    const result = await verify(ownedRows(), false)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/advisor\/policy.*unknown to this harness.*not marked ignorable/)
  })

  it('verifies native V4 required records without changing any payload, anchor, source field or bytes', async () => {
    const rows = ownedRows(), original = structuredClone(rows)
    expect((await verify(rows)).ok).toBe(true)
    const header = { version: 4, id: 'fixture', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const artifact = { header, inheritedEventCount: 0, events: rows }
    const restored = v4.restoreReleasedV4Artifact(artifact, new Set(rows.map(row => row.type)))
    expect(restored.events).toEqual(original)
    expect(rows).toEqual(original)
    expect(restored.events[3].data.taskAnchor).toBe(0)
    expect(restored.events[4].data.source.customAttribution).toEqual({ seq: 42, note: 'retain all fields' })
  })

  it('retains required foreign-event rejection and rejects malformed owned payloads', async () => {
    const foreign = await verify(dense([{ type: 'foreign/required', data: { important: true } }]))
    expect(foreign.ok).toBe(false)
    expect(foreign.message).toMatch(/foreign\/required.*unknown to this harness/)
    for (const data of [{ ...runPayload(), taskAnchor: -1 }, { ...runPayload(), turns: 0 }, { ...runPayload(), surprise: true }]) {
      const invalid = await verify(dense([{ type: 'advisor/run', data }]))
      expect(invalid.ok).toBe(false)
      expect(invalid.message).toContain('Advisor historical payload:')
    }
  })

  it('does not relax native source syntax or make unknown events required', async () => {
    const rows = ownedRows()
    rows[4]!.data.source = { kind: 'plugin', plugin: 'dsh-escalation-advisor', form: 'notice', summary: 'old syntax' }
    const result = await verify(rows)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/source|plugin/)
    expect((await verify(dense([{ type: 'foreign/optional', data: { untouched: 1 }, ignorable: true }]))).ok).toBe(true)
  })

  it('patches only the current worker, keeps byte-verified idempotence, and saves original bytes', async () => {
    expect(await readFile(join(root, 'backup', 'persistence.worker.cjs'), 'utf8')).toBe(workerSource)
    for (const [path, bytes] of beforeMigrationBundles) expect(await readFile(path)).toEqual(bytes)
    const result = await patchCopiedRuntime(packagePath, join(root, 'backup'))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ alreadyPatched: true, support: maintenance.HISTORY_PATCH_SUPPORT['0.2.0-rc.2'] })
    expect(result[0].support).toContain('Advisor V0–V3 migration is unsupported')
  })

  it('refuses changed bundles even when a patch marker remains, without writing backups', async () => {
    const patched = await readFile(workerPath, 'utf8')
    for (const changed of [workerSource + '\n// local change', patched + '\n// local change']) {
      await writeFile(workerPath, changed)
      try {
        await expect(patchCopiedRuntime(packagePath, join(root, 'tampered-backup'))).rejects.toThrow('Unexpected package checksum')
        expect(await readFile(workerPath, 'utf8')).toBe(changed)
        await expect(readFile(join(root, 'tampered-backup', 'persistence.worker.cjs'))).rejects.toThrow()
      } finally { await writeFile(workerPath, patched) }
    }
  })

  it('rejects unsupported CLI versions before touching any bundle', async () => {
    const original = await readFile(packagePath, 'utf8'), worker = await readFile(workerPath)
    try {
      await writeFile(packagePath, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.3' }))
      await expect(patchCopiedRuntime(packagePath, join(root, 'wrong-version'))).rejects.toThrow('supports exactly')
      expect(await readFile(workerPath)).toEqual(worker)
    } finally { await writeFile(packagePath, original) }
  })

  it.each([0, 1, 2, 3])('keeps required Advisor and foreign events fail-closed in the real V%i migration', version => {
    for (const row of [...ownedRows().slice(0, 4), ...dense([{ type: 'foreign/required', data: {} }])]) {
      expect(() => migrate(version, [{ ...row, seq: 0 }])).toThrow(/unknown|unclassified/)
    }
  })

  it('demonstrates why pass-through task anchors are unsafe across the actual adjacent migrations', () => {
    // V1 consumes multiple chunk events, shifting the later user seq down.
    const v1 = dense([
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: user('task'), surfaceOp: 'append' },
    ])
    expect(migrate(1, v1).find(row => row.type === 'user/message')?.seq).toBe(2)
    expect(v1[3]!.seq).toBe(3)
    // V2 inserts a system head, shifting the task anchor from 2 to 3.
    const v2 = dense([
      { type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: user('task'), surfaceOp: 'append' },
    ])
    expect(migrate(2, v2).find(row => row.type === 'user/message')?.seq).toBe(3)
    expect(v2[2]!.seq).toBe(2)
    // V3 inserts an interrupted-turn closure, shifting an anchor from 3 to 4.
    const v3 = dense([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [user('task')] } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: user('task'), surfaceOp: 'append' },
    ])
    expect(migrate(3, v3).find(row => row.type === 'user/message')?.seq).toBe(4)
    expect(v3[3]!.seq).toBe(3)
  })

  it('preserves old Advisor message-source metadata during the real V3→V4 conversion', () => {
    // Source conversion alone is supported upstream; adding required Advisor
    // run records to this history still refuses in the test above.
    const data = { ...user('notice'), source: { kind: 'plugin', plugin: 'dsh-escalation-advisor', form: 'notice', summary: 'old review', opaqueMetadata: { seq: 42 } } }
    const rows = dense([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data, surfaceOp: 'append' },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]), original = structuredClone(rows)
    const result = migrate(3, rows)
    const artifact = { header: { version: 4, id: 'fixture', createdAt: 1, isSeeded: false, delegationDepth: 0 }, inheritedEventCount: 0, events: result }
    // Ordinary V3 histories still complete the real migration AND native V4
    // relationship validation; only required Advisor records are unsupported.
    expect(v4.restoreReleasedV4Artifact(artifact, new Set(result.map(row => row.type)))).toEqual(artifact)
    expect(result[2]!.data).toEqual({ ...data, source: { kind: 'plugin:dsh-escalation-advisor', form: 'notice', summary: 'old review', opaqueMetadata: { seq: 42 } } })
    expect(rows).toEqual(original)
  })
})

const legacyRuntime = runtimeAnchor !== undefined
  && JSON.parse(readFileSync(resolve(runtimeAnchor), 'utf8')).version === '0.1.5-rc.1'
describe.skipIf(!legacyRuntime)('pinned DSH 0.1.5-rc.1 history regression', () => {
  it('retains the original V0→V1 transformation and sequence-preserving owned payloads', async () => {
    const runtime = createRequire(resolve(runtimeAnchor!))
    const root = await mkdtemp(join(tmpdir(), 'advisor-legacy-history-'))
    try {
      const scope = join(root, 'node_modules', '@deepseek-ai')
      for (const [name, filename] of [['dsh', ''], ['dsh-session-format-v0-to-v1', 'index.js'], ['dsh-session-persistence-jsonl', 'worker.cjs']] as const) {
        const original = runtime.resolve('@deepseek-ai/' + name + '/package.json')
        const target = join(scope, name)
        await mkdir(join(target, 'lib'), { recursive: true })
        await copyFile(original, join(target, 'package.json'))
        if (filename) await copyFile(join(dirname(original), 'lib', filename), join(target, 'lib', filename))
      }
      for (const name of ['dsh-session-format', 'dsh-util-values']) {
        await symlink(dirname(runtime.resolve('@deepseek-ai/' + name + '/package.json')), join(scope, name), 'dir')
      }
      const result = await patchCopiedRuntime(join(scope, 'dsh', 'package.json'), join(root, 'backup'))
      expect(result).toHaveLength(2)
      expect(result.every((entry: { alreadyPatched: boolean }) => !entry.alreadyPatched)).toBe(true)
      const format = await import(pathToFileURL(join(scope, 'dsh-session-format', 'lib', 'index.js')).href)
      const historical = await import(pathToFileURL(join(scope, 'dsh-session-format-v0-to-v1', 'lib', 'index.js')).href)
      const header = { version: 0, id: 'fixture', createdAt: 1, isSeeded: false, delegationDepth: 0 }
      const stage = historical.sessionFormatV0ToV1.createStage({ sourceHeader: header, targetHeader: historical.sessionFormatV0ToV1.migrateHeader(header), sourceInheritedEventCount: 0, sourceKind: 'decoded' })
      const output = new format.SessionFormatEventCollector()
      const rows = dense([{ type: 'user/message', surfaceOp: 'append', data: user('task') }, ...ownedRows().slice(0, 4)])
      const original = structuredClone(rows)
      for (const row of rows) stage.transformEvent(row, output)
      stage.finish(output)
      expect(output.values).toEqual(original)
      expect(rows).toEqual(original)
      const foreign = { type: 'foreign/required', seq: rows.length, time: 99, data: {} }
      expect(() => stage.transformEvent(foreign, output)).toThrow(/unknown|unsupported/)
      expect((await patchCopiedRuntime(join(scope, 'dsh', 'package.json'), join(root, 'backup'))).every((entry: { alreadyPatched: boolean }) => entry.alreadyPatched)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
