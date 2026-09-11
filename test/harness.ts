import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type MessageId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import SessionPersistence, {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionHeader,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime, {
  finalAssistantOutput,
  type ContinuableStart,
  type SubagentInterruptAuthority,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { queueHostSubagentPrompt, steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ADVISOR_VERDICT_TOOL } from '../src/verdict-tool.js'
import * as Advisor from '../src/index.js'
import type { Config } from '../src/config.js'

export type { GenerateOptions }

export type ScriptEntry =
  | StreamChunk[]
  | ((request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)

export interface RecordedRequest {
  readonly sequence: number
  readonly request: GenerateOptions
}

export class ScriptedAdapter extends LlmAdapter {
  readonly requests: RecordedRequest[] = []
  private sequence = 0

  constructor(private readonly scripts: Record<string, ScriptEntry[]>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sequence: ++this.sequence, request })
    const script = this.scripts[request.model]
    const entry = script?.shift()
    if (!entry) throw new Error(`ScriptedAdapter: script exhausted for model ${request.model}`)
    const chunks = typeof entry === 'function' ? await entry(request) : entry
    for (const chunk of chunks) {
      if (request.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }

  forModel(model: string): RecordedRequest[] {
    return this.requests.filter(({ request }) => request.model === model)
  }
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private stored: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

interface MemoryStoredSession {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: SessionEvent[]
  revision: number
  writerOpen: boolean
}

/** One open channel onto an in-memory stored session. */
class MemorySessionHandle implements SessionHandle {
  private closed = false

  constructor(private readonly record: MemoryStoredSession, readonly access: SessionAccess) {
    if (access === 'write') record.writerOpen = true
  }

  get id(): SessionId {
    return this.record.header.id
  }

  get header(): SessionHeader {
    return this.record.header
  }

  get inheritedEventCount(): SessionLogOffset {
    return this.record.inheritedEventCount
  }

  async read(
    offset = 0,
    length?: number,
    options: SessionHandleReadOptions = {},
  ): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    options.signal?.throwIfAborted()
    const end = length === undefined ? this.record.events.length : offset + length
    return { eventState: 'shared-frozen', events: this.record.events.slice(offset, end) }
  }

  async append(events: readonly SessionEvent[], options: SessionHandleAppendOptions = {}): Promise<void> {
    this.assertOpen('append')
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    options.signal?.throwIfAborted()
    for (const event of events) {
      if (Number(event.seq) !== this.record.events.length) {
        throw new Error(`MemorySessionPersistence: non-contiguous append at seq ${String(event.seq)} over ${this.record.events.length} stored events`)
      }
      this.record.events.push(event)
    }
    this.record.revision += 1
  }

  async flush(options: SessionHandleFlushOptions = {}): Promise<void> {
    this.assertOpen('flush')
    options.signal?.throwIfAborted()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.access === 'write') this.record.writerOpen = false
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation)
  }
}

/**
 * In-memory `sessionPersistence` backend.
 *
 * Continuable children require the `sessionPersistence` capability, and
 * `@deepseek-ai/dsh-agent-loop` routes EVERY session creation through it once
 * it is mounted (`createStoredSession`), so a presence-only service is not an
 * option: `SessionHandle.append` is on the live publish path and
 * `AgentLoop.resume` reads through the same handle.
 *
 * This backend therefore implements the real contract in memory — contiguous
 * appends, per-session write ownership, revisioned `stat`/`list`, `read` — and
 * nothing more. It exists because the durable backends
 * (`dsh-session-persistence-jsonl`) and the query service cold resume requires
 * (`dsh-session-query`) are absent from this repository's installed dependency
 * set; it is honest about what it is, and a passing test can only conclude that
 * the in-process continuation lifecycle worked, never that storage did.
 */
export class MemorySessionPersistence extends SessionPersistence {
  private readonly stored = new Map<string, MemoryStoredSession>()

  override async create(
    header: SessionHeader,
    options: SessionPersistenceCreateOptions = {},
  ): Promise<SessionHandle> {
    options.signal?.throwIfAborted()
    if (this.stored.has(String(header.id))) throw new SessionAlreadyExistsError(header.id)
    const record: MemoryStoredSession = {
      header,
      inheritedEventCount: options.inheritedEventCount ?? SessionLogOffset(0),
      events: [],
      revision: 0,
      writerOpen: false,
    }
    this.stored.set(String(header.id), record)
    return new MemorySessionHandle(record, 'write')
  }

  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const record = this.stored.get(String(id))
    if (record === undefined) throw new SessionPersistenceNotFoundError(id)
    if (access === 'write' && record.writerOpen) throw new SessionAlreadyOwnedError(id)
    return new MemorySessionHandle(record, access)
  }

  override flush(): Promise<void> {
    return Promise.resolve()
  }

  override stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const record = this.stored.get(String(id))
    return Promise.resolve(record === undefined ? undefined : this.snapshotOf(record))
  }

  override list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([...this.stored.values()].map(record => this.snapshotOf(record)))
  }

  private snapshotOf(record: MemoryStoredSession): SessionPersistenceSnapshot {
    return {
      header: record.header,
      revision: SessionPersistenceRevision(`memory-${record.revision}`),
      eventCount: record.events.length,
    }
  }
}

export const TEST_CONFIG: Config = {
  enabled: true,
  mode: 'manual',
  provider: 'mock',
  model: 'advisor',
  reasoningEffort: '',
  subagentProvider: 'spawn',
  defaultEnabledTools: [],
  readOnlyTools: [],
  mutatingTools: ['edit', 'write', 'bash', 'pwsh'],
  retryDelayMs: 0,
  capabilityAmplifierTools: [],
  manualMainAgent: true,
  manualLocalSubagents: true,
  escalationMainAgent: true,
  escalationLocalSubagents: true,
  continuousMainAgent: true,
  continuousLocalSubagents: false,
  escalationWait: 'block',
  continuousWait: 'background',
  timeoutMs: 5000,
  maxManualConsultsPerSession: -1,
  maxAdvisorConsultsPerTask: -1,
  maxConcurrentAdvisorRuns: 2,
  scoreThreshold: 4,
  toolErrorWeight: 2,
  repeatedFailureWeight: 3,
  nonZeroExitWeight: 1,
  repeatedMutationWeight: 2,
  repeatedMutationCount: 3,
  maxAutoConsultsPerTurn: 1,
  maxAutoConsultsPerProblem: 1,
  cooldownTurns: 0,
  continuousMinSeverity: 'concern',
  injectNits: true,
}

export interface CreatedAgentRecord {
  readonly agent: Agent
  disposedEvents?: readonly SessionEvent[]
}

export interface ContinuableStartOptions {
  readonly label?: string
  readonly prompt?: string
  readonly persona?: string
  readonly toolFilter?: SubagentStartRequest['toolFilter']
  readonly model?: string
  readonly parent?: Agent
  readonly signal?: AbortSignal
}

export interface IntegrationHarness {
  readonly ctx: Context
  readonly root: Agent
  readonly adapter: ScriptedAdapter
  readonly created: CreatedAgentRecord[]
  runRoot(prompt: string): Promise<void>
  spawnWorker(options?: {
    model?: string
    label?: string
    prompt?: string
    toolFilter?: SubagentStartRequest['toolFilter']
  }): Promise<SubagentRun>
  /** Start one continuable child and resolve at its initial inbox acceptance. */
  startContinuableChild(options?: ContinuableStartOptions): Promise<ContinuableStart>
  /** The live Agent for one durable child id, or `undefined` once it is released. */
  childAgent(childId: string): Agent | undefined
  /** Deliver one model-authored message exactly as `ctx.subagents.sendMessage` does (steer). */
  sendToChild(childId: string, text: string, signal?: AbortSignal): Promise<MessageId>
  /** Deliver one host-authored message as a distinct queued turn (queue). */
  queueToChild(childId: string, text: string, signal?: AbortSignal): Promise<MessageId>
  interruptChild(childId: string, authority?: SubagentInterruptAuthority): void
}

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

export interface IntegrationHarnessOptions {
  /**
   * Mount {@link PresenceOnlySessionPersistence}. Off by default so every
   * existing test keeps the environment it was written against; continuable
   * children cannot even be started without it.
   */
  readonly sessionPersistence?: boolean
}

export async function createIntegrationHarness(
  scripts: Record<string, ScriptEntry[]>,
  config: Partial<Config> = {},
  rootOptions: Partial<AgentOptions> = {},
  options: IntegrationHarnessOptions = {},
): Promise<IntegrationHarness> {
  const ctx = new Context()
  const adapter = new ScriptedAdapter(scripts)
  const created: CreatedAgentRecord[] = []

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await mountInvariants(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  if (options.sessionPersistence !== false) await ctx.plugin(MemorySessionPersistence)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Advisor, { ...TEST_CONFIG, ...config })

  ctx.on('agent/created', ({ agent }) => {
    created.push({ agent })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const record = created.find(candidate => candidate.agent === agent)
    if (record) record.disposedEvents = agent.session.snapshotEvents()
  })

  const root = await ctx.agentLoop.create(SessionId('integration-root'), {
    provider: 'mock',
    model: 'weak',
    ...rootOptions,
  })

  return {
    ctx,
    root,
    adapter,
    created,
    async runRoot(prompt: string): Promise<void> {
      root.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await root.whenIdle()
    },
    spawnWorker(options = {}): Promise<SubagentRun> {
      return ctx.subagents.start('spawn', {
        parent: root,
        signal: new AbortController().signal,
        label: options.label ?? 'Worker A',
        prompt: [{ type: 'text', text: options.prompt ?? 'Complete the delegated task.' }],
        agentOptions: { provider: 'mock', model: options.model ?? 'worker' },
        ...(options.toolFilter === undefined ? {} : { toolFilter: options.toolFilter }),
      })
    },
    startContinuableChild(startOptions = {}): Promise<ContinuableStart> {
      const signal = startOptions.signal ?? new AbortController().signal
      return ctx.subagents.startContinuable({
        provider: 'spawn',
        label: startOptions.label ?? 'Continuable Worker',
        signal,
        request: {
          parent: startOptions.parent ?? root,
          prompt: [{ type: 'text', text: startOptions.prompt ?? 'Complete the continuable task.' }],
          agentOptions: { provider: 'mock', model: startOptions.model ?? 'worker' },
          ...(startOptions.persona === undefined ? {} : { persona: startOptions.persona }),
          ...(startOptions.toolFilter === undefined ? {} : { toolFilter: startOptions.toolFilter }),
        },
      })
    },
    childAgent(childId: string): Agent | undefined {
      return ctx.agents.get(SessionId(childId))
    },
    sendToChild(childId: string, text: string, signal?: AbortSignal): Promise<MessageId> {
      return ctx.subagents.sendMessage(root, SessionId(childId), [{ type: 'text', text }], {
        signal: signal ?? new AbortController().signal,
      })
    },
    queueToChild(childId: string, text: string, signal?: AbortSignal): Promise<MessageId> {
      return queueHostSubagentPrompt(
        ctx.subagents,
        root,
        SessionId(childId),
        [{ type: 'text', text }],
        { kind: 'plugin', plugin: 'test-harness' },
        signal ?? new AbortController().signal,
      )
    },
    interruptChild(childId: string, authority?: SubagentInterruptAuthority): void {
      ctx.subagents.interrupt(SessionId(childId), authority ?? { kind: 'ancestor', agent: root })
    },
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(callId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export function advisorVerdictResponse(overrides: Record<string, unknown> = {}): StreamChunk[] {
  return toolCallResponse('advisor-verdict', ADVISOR_VERDICT_TOOL, {
    severity: 'concern',
    disposition: 'revise',
    summary: 'Independent review found a concrete issue.',
    diagnosis: 'The repeated attempt preserves the failing assumption.',
    next_actions: ['Change the assumption and rerun the focused check.'],
    evidence_used: [],
    assumptions: [],
    recommended_next_action: 'Change the assumption and rerun the focused check.',
    validation_plan: ['Rerun the focused check.'],
    needs_more_evidence: false,
    confidence: 0.9,
    changes_made: [],
    ...overrides,
  })
}

/**
 * One Advisor consultation now costs two model requests: the verdict tool call,
 * then the closing response the model produces after the tool result. The
 * verdict channel is an ordinary tool, unlike the one-shot structured_output
 * runtime, which ended the run at capture.
 */
export function advisorScript(...entries: ScriptEntry[]): ScriptEntry[] {
  return entries.flatMap(entry => [entry, textResponse('Verdict submitted.')])
}

export function descriptorOf(agent: Agent): Record<string, unknown> | undefined {
  return agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data as Record<string, unknown> | undefined
}

export function advisorChildren(harness: IntegrationHarness): CreatedAgentRecord[] {
  return harness.created.filter(({ agent }) => descriptorOf(agent)?.label?.toString().startsWith('Advisor ·') === true)
}

export function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

export function systemPromptOf(request: GenerateOptions): string {
  // The runtime delivers the composed system prompt on `GenerateOptions.system`
  // in some versions and as a leading system message in others. Read both so an
  // assertion about persona or guidance holds on either.
  const carried = typeof (request as { system?: unknown }).system === 'string' ? String((request as { system?: unknown }).system) : ''
  const first = request.messages[0]
  const leading = first?.role === 'system'
    ? first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    : ''
  return carried + leading
}

export function deferred<T = void>(): {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * One ordered observation of a continuable child's turn. Every detail holds
 * owned leaf data only: ids, statuses, turn numbers, and reasons — never a live
 * Agent, Session, or subscriber object.
 */
export interface ContinuationTraceEntry {
  readonly order: number
  readonly name: string
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

const TRACED_SESSION_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/message',
  'subagent/descriptor',
])

function sessionEventDetail(event: SessionEvent): Record<string, string | number | boolean> {
  const data = event.data as { turn?: number; reason?: { kind?: string }; source?: { kind?: string } }
  return {
    seq: event.seq,
    ...(data.turn === undefined ? {} : { turn: data.turn }),
    ...(data.reason?.kind === undefined ? {} : { reason: data.reason.kind }),
    ...(data.source?.kind === undefined ? {} : { source: data.source.kind }),
  }
}

/**
 * Recorder for every observable boundary a continuable child crosses, as seen
 * from a listener registered on the harness's own (unscoped) root context.
 *
 * `@deepseek-ai/dsh-scope` admits an untagged listener to every carrier, so
 * this is exactly the visibility a host-tier plugin has; nothing here is
 * child-local. Register the recorder before dispatching so no boundary can be
 * missed, and note that observations that arrive before a dispatch promise
 * resolves are recorded first, because the trace is append-only over time.
 */
export class ContinuationTrace {
  readonly entries: ContinuationTraceEntry[] = []
  private order = 0

  constructor(ctx: Context) {
    ctx.on('agent/created', ({ agent }) => this.push('agent/created', { agent: String(agent.id) }))
    ctx.on('agent/disposed', ({ agent }) => this.push('agent/disposed', { agent: String(agent.id) }))
    ctx.on('agent/status', ({ agent, status }) => this.push('agent/status', { agent: String(agent.id), status: String(status) }))
    ctx.on('agent/inbox/inserted', ({ agent, message }) => this.push('agent/inbox/inserted', {
      agent: String(agent.id),
      message: String(message.id),
      source: String(message.source?.kind ?? ''),
    }))
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => this.push('agent/inbox/claimed', {
      agent: String(agent.id),
      message: String(message.id),
      turn,
    }))
    ctx.on('agent/inbox/discarded', ({ agent, message }) => this.push('agent/inbox/discarded', {
      agent: String(agent.id),
      message: String(message.id),
    }))
    ctx.on('agent/turn-stopping', ({ agent, turn }) => this.push('agent/turn-stopping', {
      agent: String(agent.id),
      turn,
      turnAlreadyClosed: agent.session.snapshotEvents().some(event =>
        event.type === 'turn/end' && (event.data as { turn?: number }).turn === turn),
    }))
    ctx.on('subagent/start', info => this.push('subagent/start', {
      id: String(info.id),
      provider: String(info.provider),
      local: info.local,
    }))
    ctx.on('subagent/end', info => this.push('subagent/end', {
      id: String(info.id),
      provider: String(info.provider),
      stopReason: String(info.stopReason),
    }))
    ctx.on('session/event', (session, event) => {
      if (!TRACED_SESSION_EVENTS.has(String(event.type))) return
      this.push(`session/${String(event.type)}`, { session: String(session.id), ...sessionEventDetail(event) })
    })
  }

  /** Record a caller-side observation (an awaited promise settling) in the same order. */
  mark(name: string, detail: Record<string, string | number | boolean> = {}): void {
    this.push(name, detail)
  }

  private push(name: string, detail: Record<string, string | number | boolean>): void {
    this.entries.push({ order: ++this.order, name, detail })
  }

  /** Every recorded boundary in arrival order, for one session id when given. */
  of(sessionId?: string): readonly ContinuationTraceEntry[] {
    if (sessionId === undefined) return this.entries
    return this.entries.filter(entry => entry.detail.session === sessionId || entry.detail.agent === sessionId || entry.detail.id === sessionId)
  }

  /** One-line rendering of the recorded order, used in failure output and reports. */
  render(sessionId?: string): string {
    return this.of(sessionId)
      .map(({ order, name, detail }) => `${String(order).padStart(3, ' ')} ${name} ${JSON.stringify(detail)}`)
      .join('\n')
  }

  /** Position of the first entry matching `name` and every optional detail pair. */
  position(name: string, detail: Record<string, string | number | boolean> = {}): number {
    return this.entries.findIndex(entry => entry.name === name &&
      Object.entries(detail).every(([key, value]) => entry.detail[key] === value))
  }

  /** All entries matching `name` and every optional detail pair. */
  all(name: string, detail: Record<string, string | number | boolean> = {}): readonly ContinuationTraceEntry[] {
    return this.entries.filter(entry => entry.name === name &&
      Object.entries(detail).every(([key, value]) => entry.detail[key] === value))
  }
}

/**
 * The child's own closing output, selected by the same rule the one-shot
 * `SubagentResult.output` uses. A fresh continuable child owns every event in
 * its log, so the whole snapshot is the child-owned suffix.
 */
export function childOutputText(agent: Agent): string {
  return (finalAssistantOutput(agent.session.snapshotEvents()) ?? [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
}

/** Turn numbers the given session has closed, with each turn's recorded reason. */
export function closedTurns(agent: Agent): { turn: number; reason: string }[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'turn/end')
    .map(event => {
      const data = event.data as { turn: number; reason?: { kind?: string } }
      return { turn: data.turn, reason: String(data.reason?.kind ?? '') }
    })
}

/**
 * Await the child's own `turn/end` for one specific claimed turn — the
 * settlement boundary a delivered message is actually attributable to. The
 * listener is installed before the wait so a turn that closes early is still
 * observed; `agent/turn/end` is a durable session append, not a live-only edge.
 */
export function waitForTurnEnd(agent: Agent, turn: number, timeoutMs = 5000): Promise<{ turn: number; reason: string }> {
  const observed = closedTurns(agent).find(closed => closed.turn === turn)
  if (observed !== undefined) return Promise.resolve(observed)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error(`Timed out waiting for turn ${turn} to close in session ${String(agent.id)}`))
    }, timeoutMs)
    const dispose = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'turn/end') return
      const data = event.data as { turn: number; reason?: { kind?: string } }
      if (data.turn !== turn) return
      clearTimeout(timer)
      dispose()
      resolve({ turn: data.turn, reason: String(data.reason?.kind ?? '') })
    })
  })
}

// ---------------------------------------------------------------------------
// The DEPLOYED runtime harness (isolated config only)
//
// `createIntegrationHarness` above composes the repository's own dependency set
// and its in-memory persistence stand-in. A test that must prove a COLD RESUME
// cannot use it: cold resume needs `ctx.sessionQuery`, which the installed set
// does not provide, and it must run against the durable backends the deployment
// actually loads. This harness therefore resolves every `@deepseek-ai/*`
// specifier through `createRequire(DSH_RUNTIME_PACKAGE_JSON)` — the same anchor
// `vitest.runtime.config.ts` aliases with — and mounts the REAL
// `dsh-session-persistence-jsonl` and `dsh-session-query-sqlite` plugins.
//
// It is inert unless that variable is set, so importing this module from any
// other spec (whose factories are never called from a skipped block) changes
// nothing there.
// ---------------------------------------------------------------------------

const runtimeAnchor = process.env.DSH_RUNTIME_PACKAGE_JSON
const runtimeRequire = runtimeAnchor === undefined ? undefined : createRequire(runtimeAnchor)

/**
 * Load one module from the DEPLOYED install rather than from the installed
 * dependency set. The anchor is required: a caller that reached here without it
 * would silently measure the wrong runtime, so it fails loud instead.
 */
async function loadDeployed(specifier: string): Promise<any> {
  if (runtimeRequire === undefined) throw new Error('DSH_RUNTIME_PACKAGE_JSON must be set to load the deployed runtime.')
  return import(pathToFileURL(runtimeRequire.resolve(specifier)).href)
}

/** The `default ?? namespace` shape every DSH plugin module publishes. */
const pluginOf = (module: any): any => module.default ?? module

export interface DeployedRuntimeHarness {
  readonly ctx: Context
  readonly root: Agent
  readonly adapter: ScriptedAdapter
  /** Durable on-disk session root this harness mounted. */
  readonly sessionRoot: string
  /** Every `agent/created` id in arrival order, for "nothing new was created" claims. */
  readonly agentsCreated: string[]
  /** One more live ROOT Agent in the same context (used for cross-task refusals). */
  secondRoot(id: string): Promise<Agent>
  /** The live Agent for a durable session id, or `undefined` once it is released. */
  liveAgent(sessionId: string): Agent | undefined
  /** The live Session for a durable session id, or `undefined` once it is released. */
  liveSession(sessionId: string): unknown
  /** Run one registered tool through the runtime tool pipeline, as a model call would. */
  runTool(name: string, args: unknown, agent: Agent, signal?: AbortSignal): Promise<{ value?: unknown; isError: boolean; text: string }>
  /** Read one persisted session back through the mounted query service. */
  readPersisted(sessionId: string): Promise<{ id: string; parentSession: string; events: readonly { type: string; seq: number; data: unknown }[] }>
  dispose(): Promise<void>
}

export async function createDeployedRuntimeHarness(
  scripts: Record<string, ScriptEntry[]>,
  config: Partial<Config> = {},
  sessionRoot: string = mkdtempSync(join(tmpdir(), 'dsh-deployed-runtime-sessions-')),
): Promise<DeployedRuntimeHarness> {
  const [Cordis, LlmRuntime, SessionStore, SessionProjection, SystemPrompt, ToolRuntime, AgentRegistry,
    Invariants, AgentInvariant, AgentLoopInvariant, SessionInvariant, AgentLoop, SubagentRuntime, Spawn] =
    await Promise.all([
      loadDeployed('@deepseek-ai/cordis'),
      loadDeployed('@deepseek-ai/dsh-llm'),
      loadDeployed('@deepseek-ai/dsh-session'),
      loadDeployed('@deepseek-ai/dsh-session-projection'),
      loadDeployed('@deepseek-ai/dsh-system-prompt'),
      loadDeployed('@deepseek-ai/dsh-tools'),
      loadDeployed('@deepseek-ai/dsh-agent'),
      loadDeployed('@deepseek-ai/dsh-invariants'),
      loadDeployed('@deepseek-ai/dsh-agent/invariant'),
      loadDeployed('@deepseek-ai/dsh-agent-loop/invariant'),
      loadDeployed('@deepseek-ai/dsh-session/invariant'),
      loadDeployed('@deepseek-ai/dsh-agent-loop'),
      loadDeployed('@deepseek-ai/dsh-subagent'),
      loadDeployed('@deepseek-ai/dsh-subagent-spawn-in-process'),
    ])

  const ctx = new (Cordis.Context ?? Cordis.default)() as Context
  const adapter = new ScriptedAdapter(scripts)
  const agentsCreated: string[] = []

  await ctx.plugin(pluginOf(LlmRuntime))
  await ctx.plugin(pluginOf(SessionStore))
  await ctx.plugin(pluginOf(SessionProjection))
  await ctx.plugin(pluginOf(SystemPrompt), {})
  await ctx.plugin(pluginOf(ToolRuntime), {})
  await ctx.plugin(pluginOf(AgentRegistry))
  await ctx.plugin(pluginOf(Invariants))
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(pluginOf(AgentLoop), { agents: [] })
  await ctx.plugin(pluginOf(SubagentRuntime))
  await ctx.plugin(pluginOf(Spawn), { providerName: 'spawn' })
  // The REAL durable backend and the REAL query service, configured exactly as
  // the deployment configures them (`openAt: never`).
  await ctx.plugin(pluginOf(await loadDeployed('@deepseek-ai/dsh-session-persistence-jsonl')), { root: sessionRoot })
  await ctx.plugin(pluginOf(await loadDeployed('@deepseek-ai/dsh-session-query-sqlite')), { path: ':memory:', openAt: 'never' })
  // The plugin declares `settings` as a hard dependency, so a missing provider
  // would leave `apply` unrun and register nothing. The deployment's own
  // provider, pointed at this test's temp directory (no watcher).
  await ctx.plugin(pluginOf(await loadDeployed('@deepseek-ai/dsh-settings-file')), { path: join(sessionRoot, 'settings.json'), watch: false })

  const llm = ctx.get('llm') as any
  llm.registerAdapter(['mock'], adapter)

  const Advisor = await import('../src/index.js')
  await ctx.plugin(Advisor, { ...TEST_CONFIG, ...config })
  // Fail loud rather than silently measuring a context the plugin never extended.
  const toolRegistry = ctx.get('tools') as any
  for (const required of ['consult_advisor', 'advisor_verdict']) {
    if (toolRegistry.get(required) === undefined) throw new Error(`the Advisor plugin did not register ${required}`)
  }

  ctx.on('agent/created', ({ agent }) => { agentsCreated.push(String(agent.id)) })

  const createRoot = async (id: string): Promise<Agent> => ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'weak' })
  const root = await createRoot('deployed-runtime-root')

  let callSeq = 0
  return {
    ctx,
    root,
    adapter,
    sessionRoot,
    agentsCreated,
    secondRoot: (id: string) => createRoot(id),
    liveAgent: (sessionId: string) => ctx.agents.get(SessionId(sessionId)),
    liveSession: (sessionId: string) => ctx.sessions.get(SessionId(sessionId)),
    async runTool(name, args, agent, signal = new AbortController().signal) {
      const tools = ctx.get('tools') as any
      const result = await tools.execute({ callId: ToolCallId(`deployed-${++callSeq}`), name, arguments: args, agent, signal })
      const text = (result.content as readonly unknown[])
        .flatMap(block => (block as { type?: string; text?: string }).type === 'text' ? [String((block as { text?: string }).text ?? '')] : [])
        .join('')
      // Owned leaf data only: `result.value` is the tool's own JSON DTO, and a
      // failure is reported as `text`. The runtime's failure object is a live
      // value and is deliberately never returned.
      return {
        ...(result.isError ? {} : { value: result.value }),
        isError: Boolean(result.isError),
        text,
      }
    },
    async readPersisted(sessionId: string) {
      const query = ctx.get('sessionQuery') as any
      const read = await query.readSession(SessionId(sessionId))
      return {
        id: String(read.session.id),
        parentSession: String(read.session.parentSession ?? ''),
        events: (read.events as readonly { type: string; seq: number; data: unknown }[]),
      }
    },
    async dispose(): Promise<void> {
      await ctx.fiber.dispose()
      rmSync(sessionRoot, { recursive: true, force: true })
    },
  }
}
