import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { Config } from './config.js'
import { catalogFor, resetPolicy, updateModeOverride, updateTimeoutOverride, updateToolOverride, updateWaitOverride } from './policy.js'
import { advisorRunHistory, advisorRunKey } from './telemetry.js'
import type { AdvisorTaskLimiter } from './task-limiter.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { advisorModelConfig, configuredModel, parseModelSelection, sessionModelSelection, updateModelSelection } from './model-selection.js'
import { truncateUtf8 } from './redact.js'
import { MAX_AUTO_REMINDERS_PER_TASK, type Disposition, type ObligationKind, type ObligationState, type ObligationStore, type Resolution } from './obligations.js'
import { textContent } from './context.js'

declare module '@deepseek-ai/cordis' { interface Context { advisor: AdvisorRemoteService } }

/** A small strict string envelope avoids depending on the application's generated types. */
const stringCodec = { mode: 'strict' as const, typeSymbol: 'string', schema: { parse(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected string')
  return value
} } }
export const ADVISOR_REMOTE_DESCRIPTORS: InvocationDescriptor[] = [
  { method: 'snapshot', args: ['sessionId'] },
  { method: 'mutate', args: ['sessionId', 'action', 'tool', 'value'] },
  { method: 'selectModel', args: ['sessionId', 'selection'] },
  { method: 'validateModel', args: ['selection'] },
  { method: 'review', args: ['sessionId', 'runId'] },
].map(({ method, args }) => ({
  id: 'dsh-escalation-advisor:advisor/' + method, service: 'advisor', namespace: 'advisor', method,
  invocation: { kind: 'direct' as const },
  parameters: args.map(name => ({ name, wire: name, source: 'json' as const, codec: stringCodec })), result: stringCodec,
}))

/** Runtime-only records must never be read as a statement that verification passed. */
const OBLIGATION_RETENTION_NOTE = 'Verification obligations are runtime-only: a restart keeps no record, so an empty list is not evidence that anything passed.'

/** One current-task item, bounded for display. Raw tool output is never included. */
export interface AdvisorObligationView {
  readonly id: string
  readonly kind: ObligationKind
  readonly state: ObligationState
  readonly summary: string
  readonly repeatCount: number
  readonly disposition?: Disposition['kind']
  readonly resolution?: Resolution['kind']
}

/** The current root task's obligations plus the reminder budget that governs them. */
export interface AdvisorObligationSnapshot {
  readonly retention: 'runtime-only'
  readonly note: string
  readonly taskStartSeq: number
  readonly remindersUsed: number
  readonly remindersLimit: number
  readonly exhausted: boolean
  readonly openCount: number
  readonly items: readonly AdvisorObligationView[]
}

/** Scoped to one root task: another task's records must never appear here. */
export function advisorObligationSnapshot(store: ObligationStore, sessionId: string, taskStartSeq: number): AdvisorObligationSnapshot {
  const remindersUsed = store.remindersUsed(sessionId, taskStartSeq)
  return {
    retention: 'runtime-only',
    note: OBLIGATION_RETENTION_NOTE,
    taskStartSeq,
    remindersUsed,
    remindersLimit: MAX_AUTO_REMINDERS_PER_TASK,
    exhausted: remindersUsed >= MAX_AUTO_REMINDERS_PER_TASK,
    openCount: store.open(sessionId, taskStartSeq).length,
    items: store.list(sessionId, taskStartSeq).map(item => ({
      id: truncateUtf8(item.id, 64), kind: item.kind, state: item.state, summary: truncateUtf8(item.summary, 300), repeatCount: item.repeatCount,
      ...(item.disposition ? { disposition: item.disposition.kind } : {}),
      ...(item.resolution ? { resolution: item.resolution.kind } : {}),
    })),
  }
}

/** Obligation reads handed to the Remote snapshot from the plugin's apply() body. */
interface RemoteObligations { store: ObligationStore; taskStartSeq: (agent: Agent) => number }
interface RemoteConfig { currentConfig: () => Config; limiter: AdvisorTaskLimiter; guidanceFor: (agent: Agent) => { available: boolean; reason: string; text: string }; obligations: RemoteObligations }
export class AdvisorRemoteService extends TypertRemoteService {
  static inject = ['agents', 'llm']
  constructor(ctx: Context, private readonly config: RemoteConfig) {
    super(ctx, 'advisor')
    ctx.inject(['typert'], scoped => {
      scoped.typert.register({ package: 'dsh-escalation-advisor', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: ADVISOR_REMOTE_DESCRIPTORS })
    })
  }

  private root(sessionId: string) {
    if (!sessionId || sessionId.length > 256) throw new Error('Invalid session ID')
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent || agent.session.header.parentSession !== undefined) throw new Error('Advisor settings require a live root session.')
    return agent
  }

  @Remote
  snapshot(sessionId: string): string {
    const root = this.root(sessionId)
    const defaults = this.config.currentConfig()
    const obligations = this.config.obligations
    return JSON.stringify({ ...catalogFor(defaults, root),
      model: configuredModel(advisorModelConfig(defaults, root.session)), modelDefault: configuredModel(defaults), modelOverridden: sessionModelSelection(root.session) !== null,
      guidance: this.config.guidanceFor(root), runs: advisorRunHistory(root).map(run => ({ ...run, responseText: undefined, runKey: advisorRunKey(run) })), budget: this.config.limiter.snapshot(String(root.id)),
      obligations: advisorObligationSnapshot(obligations.store, String(root.id), obligations.taskStartSeq(root)) })
  }

  /** Read the exact injected message when retained, including pre-alpha.5 logs. */
  @Remote
  review(sessionId: string, runId: string): string {
    const root = this.root(sessionId)
    if (!runId || runId.length > 256) throw new Error('Invalid Advisor consultation ID')
    const history = advisorRunHistory(root)
    // `runId` is the per-turn row key (`runKey` in the snapshot): the collector
    // identity for records that carry one, the compatibility key otherwise. A
    // bare consultation id still resolves, to the LAST turn of that
    // conversation — the fallback every pre-runKey caller needs.
    const run = history.find(item => advisorRunKey(item) === runId) ?? history.findLast(item => item.id === runId)
    if (!run) throw new Error('Advisor consultation does not belong to this task')
    const requester = run.requesterId === String(root.id) ? root : this.ctx.agents.get(SessionId(run.requesterId))
    if (run.childSessionId && requester) {
      const events = requester.session.snapshotEvents()
      // The injected report names only the child, which every turn of one
      // conversation shares: for a later turn the latest match is the WRONG
      // one. The stored responseText is a prefix of this turn's own injected
      // text, so an exact-prefix match picks the right copy; a row with no
      // stored text keeps the legacy latest-match behavior.
      const prefix = typeof run.responseText === 'string' && run.mode !== 'manual'
        ? run.responseText.replace(/\n…\[truncated\]$/, '')
        : ''
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!
        if (event.type !== 'user/message' || event.data.source.kind !== 'plugin' || event.data.source.plugin !== 'dsh-escalation-advisor') continue
        const text = textContent(event.data.content)
        const child = text.match(/\[Strong advisor — (?:manual|escalation|continuous); severity=(?:none|nit|concern|blocker); child=([^\]\n]+)\]/)?.[1]
        if (child !== run.childSessionId) continue
        if (prefix === '' || text.startsWith(prefix)) return JSON.stringify({ text, source: 'context', question: run.question })
      }
    }
    return JSON.stringify({ text: run.responseText ?? '', source: run.responseText ? run.mode === 'manual' ? 'tool-result' : 'report' : 'missing', question: run.question })
  }

  @Remote
  async selectModel(sessionId: string, selection: string): Promise<string> {
    const root = this.root(sessionId)
    if (selection.length > 2048) throw new Error('Advisor model selection is too large')
    const value: unknown = JSON.parse(selection)
    const selected = value === null ? null : await this.validatedModel(value)
    if (this.root(sessionId) !== root) throw new Error('Advisor root session changed while selecting a model')
    updateModelSelection(root.session, selected)
    return this.snapshot(sessionId)
  }

  private async validatedModel(value: unknown) {
    const selected = parseModelSelection(value)
    await this.ctx.llm.resolveCallConfig({ ...selected,
      reasoningEffort: selected.reasoningEffort ? ReasoningEffortId(selected.reasoningEffort) : undefined,
    }, AbortSignal.timeout(15000))
    return selected
  }

  @Remote
  async validateModel(selection: string): Promise<string> {
    if (selection.length > 2048) throw new Error('Advisor model selection is too large')
    return JSON.stringify(await this.validatedModel(JSON.parse(selection)))
  }

  @Remote
  mutate(sessionId: string, action: string, tool: string, value: string): string {
    const root = this.root(sessionId)
    if (action === 'reset') { resetPolicy(root.session); updateModelSelection(root.session, null) }
    else if (action === 'mode') updateModeOverride(root.session, value)
    else if (action === 'timeoutMs') updateTimeoutOverride(root.session, value)
    else if (action === 'tool') {
      if (value !== 'allow' && value !== 'deny' && value !== 'inherit') throw new Error('Invalid tool override')
      const item = catalogFor(this.config.currentConfig(), root).tools.find(item => item.name === tool)
      if (!item) throw new Error('Tool is not visible in this root session')
      if (value === 'allow' && item.reserved) throw new Error('Advisor delegation tools are permanently disabled.')
      updateToolOverride(root.session, tool, value)
    } else if (action === 'escalationWait' || action === 'continuousWait') updateWaitOverride(root.session, action, value)
    else throw new Error('Unknown Advisor policy action')
    return this.snapshot(sessionId)
  }
}
