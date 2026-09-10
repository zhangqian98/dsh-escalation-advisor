/**
 * ACCEPTANCE PROOF: post-eviction follow-up on the CONTINUABLE subagent path
 * through PUBLIC APIs only, against the DEPLOYED DSH runtime.
 *
 * This file is SKIPPED unless `DSH_RUNTIME_PACKAGE_JSON` is set, because it
 * exercises a runtime that is not this repository's installed dependency set
 * and it mounts real on-disk persistence. Run it with:
 *
 *   $env:DSH_RUNTIME_PACKAGE_JSON = "$env:APPDATA/npm/node_modules/@deepseek-ai/dsh/package.json"
 *   npx vitest run --config vitest.runtime.config.ts test/continuable-runtime.spec.ts
 *
 * `npm run check` runs vitest with the DEFAULT config, whose `include` is
 * `test/**\/*.spec.ts`; without the env var every test below is reported as
 * skipped there and the default suite stays green.
 *
 * Public API surface used (no `@deepseek-ai/dsh-subagent/internal`, no direct
 * `agents.resume`, no hand-flushed sessions, no macrotask timing tricks):
 *
 *   ctx.subagents.startContinuable  ctx.subagents.sendMessage
 *   ctx.subagents.interrupt         ctx.subagents.start
 *   ctx.agents.get / ctx.sessions.get / ctx.tools / ctx.sessionPersistence
 *   ctx.sessionQuery.observeSession / readSession / listEvents
 *
 * The runtime packages are resolved through `createRequire(DSH_RUNTIME_PACKAGE_JSON)`
 * so every assertion below is made against the DEPLOYED build, never a stub.
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import type { GenerateOptions, LlmResolvedModelInfo, MessageId, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ContinuableStart, SubagentInterruptAuthority, SubagentRun } from '@deepseek-ai/dsh-subagent'

const GATED = process.env.DSH_RUNTIME_PACKAGE_JSON
const DEFAULT_TIMEOUT = 180_000

// ---------------------------------------------------------------------------
// Runtime resolution: load every package from the DEPLOYED install.
// ---------------------------------------------------------------------------

const runtimeRequire = createRequire(GATED ?? join(process.cwd(), 'package.json'))

const loadRuntime = async (specifier: string): Promise<any> =>
  import(pathToFileURL(runtimeRequire.resolve(specifier)).href)

const runtimeVersions = (): Record<string, string> => {
  const names = [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-persistence',
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-session-query',
    '@deepseek-ai/dsh-session-query-sqlite',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-subagent-spawn-in-process',
    '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/cordis',
  ]
  const versions: Record<string, string> = {}
  for (const name of names) {
    try {
      versions[name] = runtimeRequire(`${name}/package.json`).version as string
    } catch (error) {
      versions[name] = `UNRESOLVED (${String((error as { code?: string }).code)})`
    }
  }
  return versions
}

// ---------------------------------------------------------------------------
// Scripted LLM adapter (same chunk protocol the repository harness uses).
// ---------------------------------------------------------------------------

type ScriptEntry = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)

class ScriptedAdapter extends LlmAdapter {
  readonly requests: { sequence: number; request: GenerateOptions }[] = []
  private sequence = 0

  constructor(private readonly scripts: Record<string, ScriptEntry[]>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sequence: ++this.sequence, request })
    const entry = this.scripts[request.model]?.shift()
    if (entry === undefined) throw new Error(`ScriptedAdapter: script exhausted for model ${request.model}`)
    const chunks = typeof entry === 'function' ? await entry(request) : entry
    for (const chunk of chunks) {
      if (request.signal?.aborted === true) throw new Error('aborted')
      yield chunk
    }
  }

  forModel(model: string): { sequence: number; request: GenerateOptions }[] {
    return this.requests.filter(({ request }) => request.model === model)
  }
}

const textResponse = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const toolCallResponse = (callId: string, name: string, args: object): StreamChunk[] => {
  const id = callId as ToolCallId
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}


// ---------------------------------------------------------------------------
// Observation trace: owned leaf data only, never a live runtime object.
// ---------------------------------------------------------------------------

interface TraceEntry {
  readonly order: number
  readonly name: string
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

class Trace {
  readonly entries: TraceEntry[] = []
  private order = 0

  constructor(ctx: Context) {
    ctx.on('agent/created', ({ agent }) => { this.push('agent/created', { agent: String(agent.id) }) })
    ctx.on('agent/disposed', ({ agent }) => { this.push('agent/disposed', { agent: String(agent.id) }) })
    ctx.on('agent/status', ({ agent, status }) => { this.push('agent/status', { agent: String(agent.id), status: String(status) }) })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => { this.push('agent/inbox/inserted', { agent: String(agent.id), message: String(message.id), source: String(message.source?.kind ?? '') }) })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => { this.push('agent/inbox/claimed', { agent: String(agent.id), message: String(message.id), turn: Number(turn) }) })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => { this.push('agent/inbox/discarded', { agent: String(agent.id), message: String(message.id) }) })
    ctx.on('agent/turn-stopping', ({ agent, turn }) => { this.push('agent/turn-stopping', { agent: String(agent.id), turn: Number(turn) }) })
    ctx.on('subagent/start', (info: any) => { this.push('subagent/start', { id: String(info.id), provider: String(info.provider) }) })
    ctx.on('subagent/end', (info: any) => { this.push('subagent/end', { id: String(info.id), stopReason: String(info.stopReason) }) })
    ctx.on('session/event', (session: any, event: any) => {
      if (event.type !== 'turn/start' && event.type !== 'turn/end') return
      const data = event.data as { turn?: number; reason?: { kind?: string } }
      this.push(`session/${String(event.type)}`, {
        session: String(session.id),
        turn: Number(data.turn),
        reason: String(data.reason?.kind ?? ''),
      })
    })
  }

  private push(name: string, detail: Record<string, string | number | boolean>): void {
    this.entries.push({ order: ++this.order, name, detail })
  }

  of(sessionId: string): readonly TraceEntry[] {
    return this.entries.filter(entry => entry.detail.session === sessionId || entry.detail.agent === sessionId || entry.detail.id === sessionId)
  }

  position(name: string, detail: Record<string, string | number | boolean> = {}): number {
    return this.entries.findIndex(entry => entry.name === name && Object.entries(detail).every(([key, value]) => entry.detail[key] === value))
  }

  all(name: string, detail: Record<string, string | number | boolean> = {}): readonly TraceEntry[] {
    return this.entries.filter(entry => entry.name === name && Object.entries(detail).every(([key, value]) => entry.detail[key] === value))
  }

  render(sessionId?: string): string {
    return this.of(sessionId ?? '').map(({ order, name, detail }) => `${String(order).padStart(4, ' ')} ${name} ${JSON.stringify(detail)}`).join('\n')
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PERSONA = 'CONTINUABLE-PERSONA-MARKER'
const PROBE = 'probe'
const MARKER = 'TURN-ONE-DISTINCTIVE-CONTEXT-MARKER'

interface RuntimeHarness {
  readonly ctx: Context
  readonly root: Agent
  readonly adapter: ScriptedAdapter
  readonly trace: Trace
  readonly sessionRoot: string
  readonly versions: Record<string, string>
  readonly probeCalls: string[]
  startContinuableChild(options?: {
    label?: string
    prompt?: string
    persona?: string
    toolFilter?: { allow: string[] }
  }): Promise<ContinuableStart>
  sendToChild(childId: string, text: string, signal?: AbortSignal): Promise<MessageId>
  interruptChild(childId: string, authority?: SubagentInterruptAuthority): void
  childAgent(childId: string): Agent | undefined
  logFileFor(childId: string): string
  dispose(): Promise<void>
}

async function mountRealPersistence(
  ctx: Context,
  sessionRoot: string,
  /** `openAt: never` mirrors the deployed `dsh-base/cordis.patch.yml`. */
  openAt: 'never' | 'startup',
): Promise<{ persistence: any; query: any }> {
  // `dsh-base/cordis.patch.yml` configures `root: dshHomePath('sessions')`;
  // this suite points the SAME backend at a temp root so the on-disk artifact
  // is attributable to this test.
  const JsonlPlugin = await loadRuntime('@deepseek-ai/dsh-session-persistence-jsonl')
  const QueryPlugin = await loadRuntime('@deepseek-ai/dsh-session-query-sqlite')
  await ctx.plugin(JsonlPlugin.default ?? JsonlPlugin, { root: sessionRoot })
  await ctx.plugin(QueryPlugin.default ?? QueryPlugin, { path: ':memory:', openAt })
  return { persistence: ctx.get('sessionPersistence'), query: ctx.get('sessionQuery') }
}

async function createRuntimeHarness(
  scripts: Record<string, ScriptEntry[]>,
  sessionRoot: string,
  options: { openAt?: 'never' | 'startup'; probe?: boolean } = {},
): Promise<RuntimeHarness> {
  const [
    Cordis, AgentRegistry, AgentLoop, SubagentRuntime, Spawn, Llm,
    SessionStore, SystemPrompt, ToolRuntime, SessionProjection, Invariants,
    AgentInvariant, AgentLoopInvariant, SessionInvariant,
  ] = await Promise.all([
    loadRuntime('@deepseek-ai/cordis'),
    loadRuntime('@deepseek-ai/dsh-agent'),
    loadRuntime('@deepseek-ai/dsh-agent-loop'),
    loadRuntime('@deepseek-ai/dsh-subagent'),
    loadRuntime('@deepseek-ai/dsh-subagent-spawn-in-process'),
    loadRuntime('@deepseek-ai/dsh-llm'),
    loadRuntime('@deepseek-ai/dsh-session'),
    loadRuntime('@deepseek-ai/dsh-system-prompt'),
    loadRuntime('@deepseek-ai/dsh-tools'),
    loadRuntime('@deepseek-ai/dsh-session-projection'),
    loadRuntime('@deepseek-ai/dsh-invariants'),
    loadRuntime('@deepseek-ai/dsh-agent/invariant'),
    loadRuntime('@deepseek-ai/dsh-agent-loop/invariant'),
    loadRuntime('@deepseek-ai/dsh-session/invariant'),
  ])

  const ctx = new Cordis.Context() as Context
  const adapter = new ScriptedAdapter(scripts)
  const probeCalls: string[] = []

  await ctx.plugin(Llm.default ?? Llm)
  await ctx.plugin(SessionStore.default ?? SessionStore)
  await ctx.plugin(SessionProjection.default ?? SessionProjection)
  await ctx.plugin(SystemPrompt.default ?? SystemPrompt, {})
  await ctx.plugin(ToolRuntime.default ?? ToolRuntime, {})
  await ctx.plugin(AgentRegistry.default ?? AgentRegistry)
  await ctx.plugin(Invariants.default ?? Invariants)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(AgentLoop.default ?? AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime.default ?? SubagentRuntime)
  await ctx.plugin(Spawn.default ?? Spawn, { providerName: 'spawn' })
  // The REAL durable backend and the REAL query service, configured as the
  // deployment configures them.
  const { persistence, query } = await mountRealPersistence(ctx, sessionRoot, options.openAt ?? 'never')

  const llm = ctx.get('llm') as any
  llm.registerAdapter(['mock'], adapter)

  if (options.probe !== false) {
    const tools = ctx.get('tools') as any
    const { defineContentToolFixture } = ToolRuntime
    tools.register(defineContentToolFixture({
      name: PROBE,
      description: 'Continuable-child evidence fixture.',
      parameters: { note: { type: 'string', description: 'evidence marker' } },
      execute: async (args: any) => {
        probeCalls.push(String(args?.note ?? ''))
        return [{ type: 'text' as const, text: 'probe ok' }]
      },
    }))
  }

  const root = await ctx.agentLoop.create('continuable-runtime-root' as SessionId, {
    provider: 'mock',
    model: 'weak',
  })

  const trace = new Trace(ctx)
  const subagents = ctx.get('subagents') as any

  const harness: RuntimeHarness = {
    ctx,
    root,
    adapter,
    trace,
    sessionRoot,
    versions: runtimeVersions(),
    probeCalls,
    async startContinuableChild(startOptions = {}): Promise<ContinuableStart> {
      return subagents.startContinuable({
        provider: 'spawn',
        label: startOptions.label ?? 'Runtime Continuable Worker',
        signal: new AbortController().signal,
        request: {
          parent: root,
          prompt: [{ type: 'text', text: startOptions.prompt ?? 'Complete the continuable task.' }],
          agentOptions: { provider: 'mock', model: 'worker' },
          ...(startOptions.persona === undefined ? {} : { persona: startOptions.persona }),
          ...(startOptions.toolFilter === undefined ? {} : { toolFilter: startOptions.toolFilter }),
        },
      })
    },
    sendToChild(childId: string, text: string, signal?: AbortSignal): Promise<MessageId> {
      return subagents.sendMessage(root, childId as SessionId, [{ type: 'text', text }], {
        signal: signal ?? new AbortController().signal,
      })
    },
    interruptChild(childId: string, authority?: SubagentInterruptAuthority): void {
      subagents.interrupt(childId as SessionId, authority ?? { kind: 'ancestor', agent: root })
    },
    childAgent(childId: string): Agent | undefined {
      return ctx.agents.get(childId as SessionId)
    },
    logFileFor(childId: string): string {
      const located = persistence.locate({ id: childId as SessionId })
      return String(located.path)
    },
    async dispose(): Promise<void> {
      await ctx.fiber.dispose()
      void query
    },
  }
  return harness
}


// ---------------------------------------------------------------------------
// Session-log helpers (owned leaf data only).
// ---------------------------------------------------------------------------

const messageText = (event: SessionEvent): string => {
  const content = (event.data as { message?: { content?: readonly unknown[] } }).message?.content ?? []
  return content.flatMap(block => {
    const typed = block as { type?: string; text?: string; name?: string; arguments?: string }
    if (typed.type === 'text') return [String(typed.text ?? '')]
    if (typed.type === 'tool-call') return [String(typed.name ?? ''), String(typed.arguments ?? '')]
    return []
  }).join('\n')
}

const snapshotText = (events: readonly SessionEvent[]): string => events.map(messageText).join('\n')

const closedTurns = (events: readonly SessionEvent[]): { turn: number; reason: string }[] =>
  events.filter(event => event.type === 'turn/end').map(event => {
    const data = event.data as { turn: number; reason?: { kind?: string } }
    return { turn: data.turn, reason: String(data.reason?.kind ?? '') }
  })

const errorCodeOf = (error: unknown): string => String((error as { code?: string }).code ?? 'NO-CODE')

interface Refusal {
  readonly ok: boolean
  readonly code: string
  readonly message: string
}

/** Capture an explicit NON-SUCCESS: an accepted delivery is itself the failure. */
const refusalOf = (operation: Promise<unknown>): Promise<Refusal> => operation.then(
  () => ({ ok: true, code: 'NO-ERROR', message: '' }),
  (error: unknown) => ({ ok: false, code: errorCodeOf(error), message: String((error as Error).message) }),
)

const evidence = (...lines: string[]): void => { console.log(lines.join('\n')) }

// ---------------------------------------------------------------------------

const openRoots: string[] = []

const freshSessionRoot = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'dsh-runtime-sessions-'))
  openRoots.push(created)
  return created
}

afterAll(() => {
  for (const root of openRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!GATED)('DEPLOYED runtime: continuable cold resume through public APIs', () => {
  it('resolves every relied-on package from the installed runtime', () => {
    const versions = runtimeVersions()
    evidence('--- resolved runtime package versions ---', JSON.stringify(versions, null, 2))
    expect(GATED).toContain('dsh')
    expect(versions['@deepseek-ai/dsh']).toBe('0.1.2-rc.1')
    for (const [name, version] of Object.entries(versions)) {
      expect(`${name}@${version}`).not.toContain('UNRESOLVED')
    }
    expect(versions['@deepseek-ai/dsh-session-persistence-jsonl']).toBe('0.1.2-rc.1')
    expect(versions['@deepseek-ai/dsh-session-query-sqlite']).toBe('0.1.2-rc.1')
  }, 60_000)

  it('cold-resumes an evicted child and closes a follow-up turn that retains context, persona, allow-list and the plugin tool', async () => {
    const sessionRoot = freshSessionRoot()
    const harness = await createRuntimeHarness({
      worker: [
        toolCallResponse('probe-1', PROBE, { note: MARKER }),
        textResponse('TURN-ONE-CLOSE'),
        textResponse('TURN-TWO-CLOSE'),
        textResponse('TURN-THREE-CLOSE'),
      ],
    }, sessionRoot)
    try {
      const started = await harness.startContinuableChild({
        prompt: `TURN ONE PROMPT ${MARKER}`,

        persona: PERSONA,
        toolFilter: { allow: [PROBE] },
      })

      const childId = String(started.childId)
      const messageId = String(started.messageId)

      // ---- Acceptance criterion 1 -----------------------------------------
      // The claim of the ACCEPTED message id maps to the owning turn, and that
      // turn's `turn/end` in THAT child session closed `completed`. The
      // observer was installed before the start call, so nothing was missed.
      const claimOrder = harness.trace.position('agent/inbox/claimed', { agent: childId, message: messageId })
      expect(claimOrder).toBeGreaterThan(0)
      const claim = harness.trace.entries[claimOrder - 1]!
      expect(claim.detail.turn).toBe(1)
      const firstClose = await vi.waitFor(() => {
        const closed = harness.trace.entries.find(entry =>
          entry.name === 'session/turn/end' && entry.detail.session === childId && entry.detail.turn === 1)
        expect(closed?.detail.reason).toBe('completed')
        return closed!
      }, { timeout: 30_000, interval: 10 })
      expect(firstClose.detail).toEqual({ session: childId, turn: 1, reason: 'completed' })
      // The REAL capability the cold path needs is mounted and answering, with the
      // deployment's `openAt: never` (exact reads available, full-text search off).
      expect(harness.ctx.get('sessionPersistence')).toBeDefined()
      const query = harness.ctx.get('sessionQuery') as any
      expect(query).toBeDefined()
      expect(typeof query.observeSession).toBe('function')

      // ---- Acceptance criterion 2: disposal is observed, not assumed ------
      await vi.waitFor(() => {
        expect(harness.childAgent(childId)).toBeUndefined()
      }, { timeout: 30_000, interval: 10 })
      expect(harness.ctx.sessions.get(childId as SessionId)).toBeUndefined()
      await vi.waitFor(() => {
        expect(harness.trace.position('subagent/end', { id: childId })).toBeGreaterThan(0)
      }, { timeout: 30_000, interval: 10 })
      expect(harness.trace.all('subagent/end', { id: childId })[0]!.detail.stopReason).toBe('completed')
      const createdBefore = harness.trace.all('agent/created', { agent: childId }).length
      expect(createdBefore).toBe(1)

      // ---- Real storage evidence ------------------------------------------
      // The child's own log reached the configured JSONL artifact on disk, and
      // the mounted query service read the SAME events back.
      const persistence = harness.ctx.get('sessionPersistence') as unknown as SessionPersistence
      const logFile = harness.logFileFor(childId)
      expect(logFile.startsWith(sessionRoot)).toBe(true)
      const raw = await (persistence as unknown as {
        readRaw(id: SessionId, signal?: AbortSignal): Promise<{ filename: string; content: string } | undefined>
      }).readRaw(childId as SessionId)
      expect(raw).toBeDefined()
      expect(raw!.content).toContain(MARKER)
      expect(raw!.content).toContain('subagent/descriptor')
      const readBack = await query.readSession(childId as SessionId)
      expect(String(readBack.session.id)).toBe(childId)
      const persistedTypes = (readBack.events as SessionEvent[]).map(event => String(event.type))
      expect(persistedTypes).toContain('turn/end')
      expect(persistedTypes).toContain('subagent/descriptor')
      const listed = await query.listEvents(childId as SessionId)
      expect(listed.length).toBe((readBack.events as SessionEvent[]).length)
      evidence(
        '--- storage evidence: the child session on disk and through the query service ---',
        `root            : ${sessionRoot}`,
        `jsonl artifact  : ${logFile}`,
        `artifact file   : ${raw!.filename}`,
        `readRaw bytes   : ${raw!.content.length}`,
        `query.readSession events: ${persistedTypes.length} (${persistedTypes.slice(0, 8).join(', ')}...)`,
        `query.listEvents records: ${listed.length}`,
        `readRaw excerpt : ${raw!.content.slice(0, 700)}`,

      )

      // ---- Acceptance criterion 3 + 6: the cold path, using ONLY sendMessage
      const followUpId = String(await harness.sendToChild(childId, 'TURN TWO PROMPT'))
      const followUpClaim = await vi.waitFor(() => {
        const order = harness.trace.position('agent/inbox/claimed', { agent: childId, message: followUpId })
        expect(order).toBeGreaterThan(0)
        return harness.trace.entries[order - 1]!
      }, { timeout: 30_000, interval: 10 })
      expect(followUpClaim.detail.turn).toBe(2)
      const secondClose = await vi.waitFor(() => {
        const closed = harness.trace.entries.find(entry =>
          entry.name === 'session/turn/end' && entry.detail.session === childId && entry.detail.turn === 2)
        expect(closed?.detail.reason).toBe('completed')
        return closed!
      }, { timeout: 30_000, interval: 10 })
      expect(secondClose.detail).toEqual({ session: childId, turn: 2, reason: 'completed' })
      // Same durable child session id, re-materialized: a second creation for it.
      expect(harness.trace.all('agent/created', { agent: childId }).length).toBe(2)
      expect(harness.trace.all('subagent/start', { id: childId }).length).toBe(2)

      // ---- Acceptance criterion 4 -----------------------------------------
      await vi.waitFor(() => {
        expect(harness.childAgent(childId)).toBeUndefined()
      }, { timeout: 30_000, interval: 10 })
      const reRead = await query.readSession(childId as SessionId)
      const reReadEvents = reRead.events as SessionEvent[]
      expect(String(reRead.session.id)).toBe(childId)
      expect(closedTurns(reReadEvents)).toEqual([
        { turn: 1, reason: 'completed' },
        { turn: 2, reason: 'completed' },
      ])
      // (a) turn 1's distinctive conversational context survived the cold resume
      expect(snapshotText(reReadEvents)).toContain(MARKER)
      expect(snapshotText(reReadEvents)).toContain('probe')
      const requestsAfterTurnOne = harness.adapter.forModel('worker').slice(2)
      expect(requestsAfterTurnOne.length).toBeGreaterThan(0)
      const turnTwoRequests = requestsAfterTurnOne.map(entry => entry.request)
      for (const request of turnTwoRequests) {
        const text = request.messages.flatMap(message => message.content)
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('\n')
        expect(text).toContain(MARKER)
        expect(text).toContain('TURN ONE PROMPT')
        expect(text).toContain('TURN TWO PROMPT')
      }
      const turnTwoRequest = turnTwoRequests[0]!


      // (b) the persona survived
      const requestText = (request: GenerateOptions): string => [
        request.system ?? '',
        ...request.messages.flatMap(message => message.content)
          .flatMap(block => (block.type === 'text' ? [block.text] : [])),
      ].join('\n')
      const allRequestText = turnTwoRequests.map(requestText).join('\n')
      const toolNames = (turnTwoRequests[0]!.tools ?? []).map(tool => tool.name)
      evidence(
        '--- turn 2 after eviction: reconstructed composition ---',
        `request roles   : ${JSON.stringify(turnTwoRequests[0]!.messages.map(message => message.role))}`,
        `system length   : ${String(turnTwoRequests[0]!.system?.length ?? 0)}`,
        `persona present : ${allRequestText.includes(PERSONA)}`,
        `tools           : ${JSON.stringify(toolNames)}`,
        `marker in prompt: ${allRequestText.includes(MARKER)}`,
        `system excerpt  : ${(turnTwoRequests[0]!.system ?? '').slice(0, 300)}`,
      )

      expect(allRequestText).toContain(PERSONA)
      // (c) the tool allow-list survived
      for (const request of turnTwoRequests) {
        expect((request.tools ?? []).map(tool => tool.name)).toEqual([PROBE])
      }

      // (d) the host-registered plugin tool is still callable in a resumed turn
      //     — exercised again in cycle 2 below with a scripted probe call.

      // ---- Acceptance criterion 5: a SECOND eviction + follow-up cycle -----
      const thirdId = String(await harness.sendToChild(childId, 'TURN THREE PROMPT'))
      const thirdClaim = await vi.waitFor(() => {
        const order = harness.trace.position('agent/inbox/claimed', { agent: childId, message: thirdId })
        expect(order).toBeGreaterThan(0)
        return harness.trace.entries[order - 1]!
      }, { timeout: 30_000, interval: 10 })
      expect(thirdClaim.detail.turn).toBe(3)
      const thirdClose = await vi.waitFor(() => {
        const closed = harness.trace.entries.find(entry =>
          entry.name === 'session/turn/end' && entry.detail.session === childId && entry.detail.turn === 3)
        expect(closed?.detail.reason).toBe('completed')
        return closed!
      }, { timeout: 30_000, interval: 10 })
      expect(thirdClose.detail).toEqual({ session: childId, turn: 3, reason: 'completed' })
      expect(harness.trace.all('agent/created', { agent: childId }).length).toBe(3)

      await vi.waitFor(() => {
        expect(harness.trace.all('agent/disposed', { agent: childId }).length).toBe(3)
      }, { timeout: 30_000, interval: 10 })
      expect(harness.childAgent(childId)).toBeUndefined()
      expect(harness.ctx.sessions.get(childId as SessionId)).toBeUndefined()
      const finalRead = await query.readSession(childId as SessionId)
      expect(closedTurns(finalRead.events as SessionEvent[])).toEqual([
        { turn: 1, reason: 'completed' },
        { turn: 2, reason: 'completed' },
        { turn: 3, reason: 'completed' },
      ])
      expect(String(finalRead.session.parentSession)).toBe(String(harness.root.id))

      evidence(
        '--- three eviction+follow-up cycles in ONE durable child session ---',
        harness.trace.render(childId),
      )
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_TIMEOUT)

  it('keeps the plugin tool callable in a resumed turn (probe executes after cold resume)', async () => {
    const sessionRoot = freshSessionRoot()
    const harness = await createRuntimeHarness({
      worker: [
        textResponse('TURN-ONE-CLOSE'),
        toolCallResponse('probe-2', PROBE, { note: 'RESUMED-PROBE-CALL' }),
        textResponse('TURN-TWO-CLOSE'),
      ],
    }, sessionRoot)
    try {
      const started = await harness.startContinuableChild({
        prompt: 'TURN ONE PROMPT',
        persona: PERSONA,
        toolFilter: { allow: [PROBE] },
      })
      const childId = String(started.childId)
      await vi.waitFor(() => { expect(harness.childAgent(childId)).toBeUndefined() }, { timeout: 30_000, interval: 10 })
      expect(harness.probeCalls).toEqual([])

      await harness.sendToChild(childId, 'TURN TWO PROMPT')
      await vi.waitFor(() => { expect(harness.probeCalls).toEqual(['RESUMED-PROBE-CALL']) }, { timeout: 30_000, interval: 10 })
      const closed = await vi.waitFor(() => {
        const read = harness.ctx.get('sessionQuery') as any
        return read.readSession(childId as SessionId) as Promise<{ events: SessionEvent[] }>
      }, { timeout: 30_000, interval: 10 })
      expect(closedTurns(closed.events)).toEqual([
        { turn: 1, reason: 'completed' },
        { turn: 2, reason: 'completed' },
      ])
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_TIMEOUT)

  it('refuses cold follow-ups as explicit non-success: non-continuable descriptor, unknown id, foreign parent, non-live sender', async () => {
    const sessionRoot = freshSessionRoot()
    const harness = await createRuntimeHarness({ worker: [textResponse('UNUSED')] }, sessionRoot)

    try {
      // A persisted session that IS a direct child of the live parent, but whose
      // descriptor is not continuable: the cold path reaches the descriptor fold
      // and must refuse there rather than materialize anything.
      const mislabeledId = 'mislabeled-one-shot-child' as SessionId
      const mislabeled = harness.ctx.sessions.create(mislabeledId, {
        meta: { parentSession: harness.root.id, origin: 'subagent' },
      })
      // The descriptor append goes through the live publish path, so the record
      // really lands in the configured JSONL backend before the cold delivery.
      mislabeled.append('subagent/descriptor', {
        version: 3,
        mode: 'one-shot',
        provider: 'spawn',
        label: 'Mislabeled one-shot child',
      })
      // Give the coordinator a bounded window to land the append, then read the
      // artifact back from the durable backend itself.
      await vi.waitFor(async () => {
        const raw = await (harness.ctx.get('sessionPersistence') as unknown as {
          readRaw(id: SessionId): Promise<{ content: string } | undefined>
        }).readRaw(mislabeledId)
        expect(raw?.content).toContain('one-shot')
      }, { timeout: 30_000, interval: 10 })

      const mislabeledRaw = await (harness.ctx.get('sessionPersistence') as unknown as {
        readRaw(id: SessionId): Promise<{ content: string } | undefined>
      }).readRaw(mislabeledId)
      expect(mislabeledRaw?.content).toContain('one-shot')
      expect(harness.ctx.agents.get(mislabeledId)).toBeUndefined()

      const refusal = await refusalOf(harness.sendToChild(String(mislabeledId), 'TURN TWO PROMPT'))

      evidence('--- negative branch: cold-resume of a NON-continuable persisted child session ---', JSON.stringify(refusal))
      expect(refusal.ok).toBe(false)
      expect(refusal.code).toBe('NOT_RESUMABLE')
      expect(refusal.message).toContain('no supported continuation state')
      // The refusal materialized nothing.
      expect(harness.trace.all('agent/created', { agent: String(mislabeledId) }).length).toBe(0)

      // A follow-up to an id that was never a child is refused too.
      const unknown = await refusalOf(harness.sendToChild('no-such-child-session', 'TURN TWO PROMPT'))

      evidence('--- negative branch: unknown child id ---', JSON.stringify(unknown))
      expect(unknown.ok).toBe(false)
      expect(unknown.code).toBe('NOT_RESUMABLE')
      expect(unknown.message).toContain('is unavailable')
      // A stored session belonging to a DIFFERENT parent is not resumable by this sender.
      const foreignChildId = 'foreign-parent-child' as SessionId
      harness.ctx.sessions.create(foreignChildId, {
        meta: { parentSession: 'some-other-parent-session' as SessionId, origin: 'subagent' },
      })
      const foreignLineage = await refusalOf(harness.sendToChild(String(foreignChildId), 'TURN TWO PROMPT'))
      evidence('--- negative branch: stored child of another parent ---', JSON.stringify(foreignLineage))
      expect(foreignLineage.ok).toBe(false)
      expect(foreignLineage.code).toBe('UNAUTHORIZED')
      expect(foreignLineage.message).toContain('belongs to another parent session')

      // A sender that is not the exact live parent is refused before any delivery.
      const foreignSender = await refusalOf((harness.ctx.get('subagents') as any)
        .sendMessage({ id: 'not-a-live-agent' }, mislabeledId, [{ type: 'text', text: 'x' }], { signal: new AbortController().signal }))
      evidence('--- negative branch: non-live sender ---', JSON.stringify(foreignSender))
      expect(foreignSender.ok).toBe(false)
      expect(foreignSender.code).toBe('UNAUTHORIZED')


    } finally {
      await harness.dispose()
    }
  }, DEFAULT_TIMEOUT)

  it('closes a resumed turn as `aborted` on interrupt, and treats the caller signal as pre-acceptance only', async () => {
    const sessionRoot = freshSessionRoot()
    const harness = await createRuntimeHarness({
      worker: [
        textResponse('TURN-ONE-CLOSE'),
        (async (request: GenerateOptions) => {
          // Block until the interrupt cancels this very request.
          await new Promise<void>((_resolve, reject) => {
            const signal = request.signal
            if (signal === undefined) return
            if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return }
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
          })
          return textResponse('UNREACHABLE')
        }) as ScriptEntry,
      ],
    }, sessionRoot)
    try {
      const started = await harness.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
      const childId = String(started.childId)
      await vi.waitFor(() => { expect(harness.childAgent(childId)).toBeUndefined() }, { timeout: 30_000, interval: 10 })

      // Pre-acceptance: an already-aborted caller signal refuses the delivery
      // outright and inserts nothing.
      const refusedSignal = new AbortController()
      refusedSignal.abort(new Error('caller gave up'))
      const insertedBefore = harness.trace.all('agent/inbox/inserted', { agent: childId }).length
      const refusal = await harness.sendToChild(childId, 'NEVER DELIVERED', refusedSignal.signal).then(
        () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, message: String((error as Error).message) }),
      )
      expect(refusal).toEqual({ ok: false, message: 'caller gave up' })
      expect(harness.trace.all('agent/inbox/inserted', { agent: childId }).length).toBe(insertedBefore)
      expect(harness.trace.all('agent/created', { agent: childId }).length).toBe(1)

      // Post-acceptance: aborting the caller signal does NOT stop the turn, but
      // `interrupt` does.
      const acceptedSignal = new AbortController()
      const resumedId = String(await harness.sendToChild(childId, 'TURN TWO PROMPT', acceptedSignal.signal))
      acceptedSignal.abort(new Error('too late'))
      const claim = await vi.waitFor(() => {
        const order = harness.trace.position('agent/inbox/claimed', { agent: childId, message: resumedId })
        expect(order).toBeGreaterThan(0)
        return harness.trace.entries[order - 1]!
      }, { timeout: 30_000, interval: 10 })
      expect(claim.detail.turn).toBe(2)
      expect(harness.childAgent(childId)).toBeDefined()
      harness.interruptChild(childId, { kind: 'ancestor', agent: harness.root })
      const aborted = await vi.waitFor(() => {
        const closed = harness.trace.entries.find(entry =>
          entry.name === 'session/turn/end' && entry.detail.session === childId && entry.detail.turn === 2)
        expect(closed?.detail.reason).toBe('aborted')
        return closed!
      }, { timeout: 30_000, interval: 10 })
      expect(aborted.detail).toEqual({ session: childId, turn: 2, reason: 'aborted' })
      await vi.waitFor(() => { expect(harness.childAgent(childId)).toBeUndefined() }, { timeout: 30_000, interval: 10 })
      evidence('--- cancellation of a resumed child ---', harness.trace.render(childId))
    } finally {
      await harness.dispose()
    }
  }, DEFAULT_TIMEOUT)

  it('reports the exact capability refusal when the query service is absent (openAt: never keeps it)', async () => {
    const sessionRoot = freshSessionRoot()
    const [Cordis, AgentRegistry, AgentLoop, SubagentRuntime, Spawn, Llm, SessionStore,
      SystemPrompt, ToolRuntime, SessionProjection, Invariants, AgentInvariant,
      AgentLoopInvariant, SessionInvariant, JsonlPlugin] = await Promise.all([
      loadRuntime('@deepseek-ai/cordis'),
      loadRuntime('@deepseek-ai/dsh-agent'),
      loadRuntime('@deepseek-ai/dsh-agent-loop'),
      loadRuntime('@deepseek-ai/dsh-subagent'),
      loadRuntime('@deepseek-ai/dsh-subagent-spawn-in-process'),
      loadRuntime('@deepseek-ai/dsh-llm'),
      loadRuntime('@deepseek-ai/dsh-session'),
      loadRuntime('@deepseek-ai/dsh-system-prompt'),
      loadRuntime('@deepseek-ai/dsh-tools'),
      loadRuntime('@deepseek-ai/dsh-session-projection'),
      loadRuntime('@deepseek-ai/dsh-invariants'),
      loadRuntime('@deepseek-ai/dsh-agent/invariant'),
      loadRuntime('@deepseek-ai/dsh-agent-loop/invariant'),
      loadRuntime('@deepseek-ai/dsh-session/invariant'),
      loadRuntime('@deepseek-ai/dsh-session-persistence-jsonl'),
    ])
    const ctx = new Cordis.Context() as Context
    const adapter = new ScriptedAdapter({ worker: [textResponse('A'), textResponse('B')] })
    await ctx.plugin(Llm.default ?? Llm)
    await ctx.plugin(SessionStore.default ?? SessionStore)
    await ctx.plugin(SessionProjection.default ?? SessionProjection)
    await ctx.plugin(SystemPrompt.default ?? SystemPrompt, {})
    await ctx.plugin(ToolRuntime.default ?? ToolRuntime, {})
    await ctx.plugin(AgentRegistry.default ?? AgentRegistry)
    await ctx.plugin(Invariants.default ?? Invariants)
    await ctx.plugin(SessionInvariant)
    await ctx.plugin(AgentInvariant)
    await ctx.plugin(AgentLoopInvariant)
    await ctx.plugin(AgentLoop.default ?? AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime.default ?? SubagentRuntime)
    await ctx.plugin(Spawn.default ?? Spawn, { providerName: 'spawn' })
    await ctx.plugin(JsonlPlugin.default ?? JsonlPlugin, { root: sessionRoot })
    ;(ctx.get('llm') as any).registerAdapter(['mock'], adapter)
    const root = await ctx.agentLoop.create('no-query-root' as SessionId, { provider: 'mock', model: 'weak' })
    const subagents = ctx.get('subagents') as any
    try {
      expect(ctx.get('sessionQuery')).toBeUndefined()
      expect(ctx.get('sessionPersistence')).toBeDefined()
      const started = await subagents.startContinuable({
        provider: 'spawn',
        label: 'No-query child',
        signal: new AbortController().signal,
        request: {
          parent: root,
          prompt: [{ type: 'text', text: 'TURN ONE PROMPT' }],
          agentOptions: { provider: 'mock', model: 'worker' },
        },
      }) as ContinuableStart
      const childId = String(started.childId)
      await vi.waitFor(() => { expect(ctx.agents.get(childId as SessionId)).toBeUndefined() }, { timeout: 30_000, interval: 10 })
      const refusal = await subagents.sendMessage(root, childId as SessionId, [{ type: 'text', text: 'TURN TWO PROMPT' }], {
        signal: new AbortController().signal,
      }).then(() => ({ ok: true as const }), (error: unknown) => ({
        ok: false as const,
        code: errorCodeOf(error),
        message: String((error as Error).message),
      }))
      evidence('--- negative branch: cold resume without a sessionQuery service ---', JSON.stringify(refusal))
      expect(refusal).toEqual({
        ok: false,
        code: 'CONTINUATION_UNAVAILABLE',
        message: 'continuable subagents require session query (load @deepseek-ai/dsh-session-query)',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  }, DEFAULT_TIMEOUT)
})
