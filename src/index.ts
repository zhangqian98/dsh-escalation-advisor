import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, routeConfigured, severityRank, type Config as AdvisorConfig } from './config.js'
import { coverageEnabled, type AdvisorAgentRole } from './coverage.js'
import { buildCasePacket, hasNewMaterialConclusion, textContent } from './context.js'
import { advisorToolSurface, callAdvisor, AdvisorUnavailableError, requesterSeq, START_REJECTED, type AdvisorRunResult, type AdvisorContinuation } from './model-runner.js'
import { effectiveAdvisorPolicy, installAdvisorPolicyCommand } from './policy.js'
import { GOAL_ROUND_ADVISOR_ROUTE, toolGuidance } from './prompts.js'
import { EscalationTracker, classifyToolOutcome, mutationKey, type EscalationDecision } from './state.js'
import { MAX_AUTO_REMINDERS_PER_TASK, ObligationStore, opensObligation, type Obligation } from './obligations.js'
import { AdvisorTaskLimiter, AdvisorTaskLimitError } from './task-limiter.js'
import { AdvisorWorkspaceLock } from './workspace-lock.js'
import { AdvisorRegistry } from './registry.js'
import { isCapabilityAmplifier, toolEffect } from './capabilities.js'
import { advisorRunHistory, recordRun, type AdvisorRunRecord, type ConsultationMode } from './telemetry.js'
import { redactSecrets, truncateUtf8 } from './redact.js'
import type { AdvisorVerdict } from './verdict.js'
import { ADVISOR_VERDICT_TOOL, AdvisorVerdictCollector, registerAdvisorVerdictTool } from './verdict-tool.js'
import { AdvisorRemoteService } from './remote.js'
import { installAdvisorEventCompatibility } from './session-events.js'
import { advisorModelConfig } from './model-selection.js'

export const name = 'dsh-escalation-advisor'
export const inject = ['tools', 'settings', 'systemPrompt', 'agents']
export { ConfigSchema as Config }
export type PluginConfig = AdvisorConfig
export const SETTINGS_NAMESPACE = 'escalation-advisor'
export const ADVISOR_TOOL_NAME = 'consult_advisor'
const INTERNAL_TOOLS = new Set(['structured_output', 'run_code', ADVISOR_VERDICT_TOOL])
interface AskAdvisorArgs { question: string; goal?: string; current_hypothesis?: string; decision_needed?: string; evidence?: string[]; failed_attempts?: string[]; attempts?: string; context?: string; consultation_id?: string }
interface ReviewTrigger { turn: number; step?: number; decision?: EscalationDecision }

/**
 * The PUBLIC conversation handle is `<uuid>#<turn>.<attempt>`: the string a
 * consumer receives as `consultation_id` and the string it must be able to send
 * back. The record store is keyed by the bare uuid instead, so the handle stays
 * the SAME string for every turn of one conversation while each turn still gets
 * its own internal channel identity.
 */
const handleBase = (handle: string): string => handle.replace(/#.*$/, '')
const handleOf = (base: string, turn: number): string => base + '#' + turn + '.1'
// Spares a caller from carrying the uuid across a compacted context. It is a
// convenience for addressing ONE conversation, not a relatedness detector: it
// never guesses, and it resolves to nothing rather than to some older record.
const LATEST_ALIAS = 'last'
function taskRootAgent(ctx: Context, agent: Agent): Agent {
  let current = agent
  const seen = new Set<string>()
  while (current.session.header.parentSession !== undefined && !seen.has(String(current.id))) {
    seen.add(String(current.id))
    const parent = ctx.agents.get(current.session.header.parentSession)
    if (!parent) break
    current = parent
  }
  return current
}

function adviceMessage(verdict: AdvisorVerdict, origin: ConsultationMode, child: string, consultationId?: string): UserMessage {
  const blocker = verdict.severity === 'blocker' ? '\nDo not continue the original approach until this finding has been checked and resolved.' : ''
  const actions = verdict.nextActions.map((item, index) => (index + 1) + '. ' + item).join('\n')
  const evidence = verdict.evidenceUsed?.map(item => item.kind + ': ' + item.reference).join('\n') ?? ''
  const validation = verdict.validationPlan?.join('\n') ?? ''
  const changes = verdict.changesMade?.map(item => item.paths.join(', ') + ': ' + item.reason + '\nValidation: ' + (item.validation.join('; ') || 'not reported')).join('\n') ?? ''
  // The consultation id is the only way to continue this same Advisor
  // conversation. It is durable identity, not a label, so it travels with the
  // advice the requesting agent sees.
  const follow = consultationId === undefined ? '' : '\n\nConsultation id: ' + consultationId + '\nTo continue this SAME Advisor conversation with its earlier context, call consult_advisor again with consultation_id="' + consultationId + '".'
  return createUserMessage({
    content: [{ type: 'text', text: '[Strong advisor — ' + origin + '; severity=' + verdict.severity + '; child=' + child + ']\n' + verdict.summary + '\n\n' + verdict.diagnosis + '\n' + actions + blocker + '\nEvidence used:\n' + (evidence || 'not reported') + '\nValidation plan:\n' + (validation || 'not reported') + '\nChanges made by Advisor:\n' + (changes || 'none reported') + follow + '\n\nVerify this independent review against repository evidence and validation results.' }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Advisor · ' + verdict.summary },
  })
}

/** Open obligations, stated as a reminder rather than as a block. */
function obligationMessage(detail: readonly Obligation[], unchanged: readonly Obligation[], final: boolean): UserMessage {
  const lines = detail.map(item => {
    const closure = item.validationKey
      ? 'a later pass of the same command in this scope with no related change since'
      : 'this failure carries no validation identity, so it cannot be closed automatically'
    const options = item.kind === 'claim-contradicted'
      ? 'A) ask the Advisor with the claim and the counterexample; B) back it with a verification witness; C) record a correction naming document, claim and change.'
      : 'A) ask the Advisor with the evidence; B) fix it and re-run the same command; C) record not-applicable or accept-risk with a checkable basis.'
    return '- ' + item.id + ' [' + item.kind + ', seen ' + item.repeatCount + 'x' + dispositionNote(item) + '] ' + item.summary + '\n  Closes only through: ' + closure + '.\n  ' + options
  })
  // Everything already stated in full collapses to one line: repeating the block
  // would add nothing the earlier statement did not already carry.
  const brief = unchanged.map(item =>
    '- ' + item.id + ' [' + item.kind + ', still open' + dispositionNote(item) + '] ' + item.summary)
  const tail = final
    ? '\n\nThis is the LAST automatic reminder for this task. Report every item above as STILL UNRESOLVED in your final answer: none has been verified, and a recorded disposition is a record, not verification.'
    : '\n\nThis is a reminder, not a block. An explanation of why a failure happened is not a verification witness and does not close an item.'
  return createUserMessage({
    content: [{ type: 'text', text: '[Advisor obligations - open verification items. No score reset, cooldown or consultation budget clears these.]\n' + lines.concat(brief).join('\n') + tail }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Advisor - ' + (detail.length + unchanged.length) + ' open obligation(s)' },
  })
}

/**
 * A disposition is a record of a DECISION, never verification. It also stops
 * covering the item the moment later evidence moves the revision past it, and
 * saying so is the whole point of tracking which revision it was written against.
 */
function dispositionNote(item: Obligation): string {
  if (item.disposition === undefined) return ''
  const recorded = ', disposition=' + item.disposition.kind
  return item.dispositionRevision === item.revision
    ? recorded + ', not verified'
    : recorded + ' (outrun by later evidence), not verified'
}
function unavailable(message: string) { return { status: 'unavailable' as const, severity: 'none' as const, summary: 'Advisor unavailable', diagnosis: redactSecrets(message), next_actions: [], confidence: 0, child_session_id: '', consultation_id: '', disposition: 'unavailable', evidence_used: [], assumptions: [], recommended_next_action: '', validation_plan: [], needs_more_evidence: true, changes_made: [] } }
function toolAnswer(answer: AdvisorRunResult, consultationId: string) {
  const verdict = answer.verdict
  return { status: 'ok' as const, severity: verdict.severity, summary: verdict.summary, diagnosis: verdict.diagnosis, next_actions: verdict.nextActions, confidence: verdict.confidence ?? 0, child_session_id: answer.childSessionId,
    // The durable handle for delivering a follow-up turn in the SAME Advisor conversation.
    consultation_id: consultationId,
    disposition: verdict.disposition ?? 'review', evidence_used: verdict.evidenceUsed ?? [], assumptions: verdict.assumptions ?? [], recommended_next_action: verdict.recommendedNextAction ?? '', validation_plan: verdict.validationPlan ?? [], needs_more_evidence: verdict.needsMoreEvidence ?? false, changes_made: verdict.changesMade ?? [] }
}

export async function apply(ctx: Context, entryConfig: AdvisorConfig): Promise<void> {
  installAdvisorEventCompatibility(ctx)
  const verdicts = new AdvisorVerdictCollector()
  const logger = ctx.logger(name)
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, { base: entryConfig })
  const currentConfig = (): AdvisorConfig => settings.get()
  const configFor = (agent: Agent): AdvisorConfig => {
    const root = taskRootAgent(ctx, agent).session
    const config = advisorModelConfig(currentConfig(), root)
    const policy = effectiveAdvisorPolicy(config, root)
    return { ...config, mode: policy.mode, timeoutMs: policy.timeoutMs }
  }
  const tracker = new EscalationTracker()
  const obligations = new ObligationStore()
  /** Dispatch seq per tool call: the only trustworthy bound on a validation window. */
  const dispatchSeq = new Map<string, { seq: number; taskStartSeq: number; tick: number; agentKey: string }>()
  /** Global dispatch counter. Session seqs are not comparable across agents, so
   * eviction uses this shared tick instead of any one session's numbering. */
  let dispatchTick = 0
  const limiter = new AdvisorTaskLimiter()
  const workspace = new AdvisorWorkspaceLock()
  const registry = new AdvisorRegistry(ctx)
  const manualCalls = new Map<string, number>()
  const manualReserved = new Map<string, number>()
  const revisions = new Map<string, number>()
  const hiddenTools = new Map<Agent, () => void>()
  /** True while the current root turn originated from an admitted goal round. */
  const goalRoundActive = new Set<string>()
  const inFlight = new Set<string>()
  const suppressed = new Set<string>()
  const retryableStarts = new Map<string, { failures: number; after: number }>()
  const taskStarts = new Map<string, number>()
  const reviewed = new Map<string, { turn: number; seq: number }>()
  /** Workspace mutation epoch per task tree: bumped on any potential mutation tool result. */
  const workspaceEpoch = new Map<string, number>()
  /** Structural mutation epoch per task tree: bumped only on path-carrying
   * edit/write-family tools (including worker mirrors below). Unlike the
   * conservative epoch above, a repeat shell failure does not move it, so the
   * review watermark can tell 'same problem again' from 'workspace changed'. */
  const structuralEpoch = new Map<string, number>()
  const bumpStructural = (agent: Agent): number => {
    try {
      const rootId = String(taskRootAgent(ctx, agent).id)
      const next = (structuralEpoch.get(rootId) ?? 0) + 1
      structuralEpoch.set(rootId, next)
      return next
    } catch { return 0 }
  }
  const structuralOf = (agent: Agent): number => {
    try { return structuralEpoch.get(String(taskRootAgent(ctx, agent).id)) ?? 0 } catch { return 0 }
  }
  /** Evidence watermark: problems a delivered consultation already covered, plus the
   * evidence revision, structural epoch and requester seq it covered them at.
   * Escalation re-arms on an uncovered fingerprint or a structural workspace change;
   * continuous review (fingerprint-less) re-arms on new evidence or conclusions. */
  const reviewWatermark = new Map<string, { evidenceVersion: number; fingerprints: Set<string>; seq: number; epoch: number }>()
  const futureNotes = new Map<string, UserMessage[]>()
  const controllers = new Map<string, Set<AbortController>>()
  const disposed = new AbortController()
  ctx.effect(() => () => {
    disposed.abort()
    for (const dispose of hiddenTools.values()) dispose()
    hiddenTools.clear()
  }, 'advisor: abort work and remove tool masks')
  installAdvisorPolicyCommand(ctx, currentConfig)

  const roleOf = (agent: Agent): AdvisorAgentRole => registry.identity(agent) ? 'advisor' : agent.session.header.parentSession === undefined ? 'root' : 'local-subagent'
  const manualEnabled = (agent: Agent): boolean => {
    const config = configFor(agent)
    return routeConfigured(config) && coverageEnabled(config, 'manual', roleOf(agent))
  }
  const refreshTool = (agent: Agent): void => {
    if (manualEnabled(agent)) { hiddenTools.get(agent)?.(); hiddenTools.delete(agent) }
    else if (!hiddenTools.has(agent)) hiddenTools.set(agent, agent.ctx.tools.restrict({ deny: [ADVISOR_TOOL_NAME] }))
  }
  const guidanceFor = (agent: Agent) => {
    const config = configFor(agent)
    refreshTool(agent)
    if (!config.enabled) return { available: false, reason: 'Advisor 已关闭', text: '' }
    if (!routeConfigured(config)) return { available: false, reason: '尚未配置顾问模型', text: '' }
    if (!coverageEnabled(config, 'manual', roleOf(agent))) return { available: false, reason: '当前角色未启用主动咨询', text: '' }
    if (ctx.tools.get(ADVISOR_TOOL_NAME, agent) === undefined) return { available: false, reason: '当前 agent 无权使用咨询工具', text: '' }
    return { available: true, reason: '使用指导已启用', text: toolGuidance(config.mode) }
  }
  await ctx.plugin(AdvisorRemoteService, { currentConfig, limiter, guidanceFor, obligations: { store: obligations, taskStartSeq: (agent: Agent) => taskStarts.get(String(agent.id)) ?? 0 } })
  const latestUserSeq = (agent: Agent): number => agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')?.seq ?? 0
  const revisionOf = (agent: Agent): string => {
    const root = taskRootAgent(ctx, agent)
    return [String(root.id), revisions.get(String(root.id)) ?? 0, latestUserSeq(root), revisions.get(String(agent.id)) ?? 0, latestUserSeq(agent)].join(':')
  }
  /**
   * The task a consultation belongs to, durable across a restart: the seq of
   * the task ROOT's latest user message. `taskStarts` is in-memory and resets
   * on reload; this anchor is read from persisted events, so a restored record
   * is usable exactly while the task it was opened under is still current — a
   * new user message moves the anchor and old consultations stop resolving.
   */
  const taskAnchorOf = (agent: Agent): number => latestUserSeq(taskRootAgent(ctx, agent))
  const fresh = (agent: Agent, revision: string): boolean => ctx.agents.get(agent.id) === agent && revisionOf(agent) === revision
  const hasMutation = (agent: Agent): boolean => {
    const config = currentConfig(), root = taskRootAgent(ctx, agent)
    return advisorToolSurface(ctx, agent, effectiveAdvisorPolicy(config, root.session), config.capabilityAmplifierTools).allowedTools.some(tool => toolEffect(tool, config.readOnlyTools, config.mutatingTools) !== 'read-only')
  }

  // This monotonic guard cannot be overridden by another pre-execute listener.
  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    if (exec.name === ADVISOR_TOOL_NAME && !manualEnabled(exec.agent)) return 'Advisor consultation is disabled for this agent.'
    const identity = registry.identity(exec.agent)
    if (!identity) return undefined
    if (INTERNAL_TOOLS.has(exec.name)) return undefined
    if (isCapabilityAmplifier(ctx, exec.name, currentConfig().capabilityAmplifierTools)) return 'Advisor delegation tools are permanently disabled.'
    const parent = registry.requester(exec.agent)
    if (!parent) return 'Advisor requester is no longer live; external tools are disabled.'
    const policy = effectiveAdvisorPolicy(currentConfig(), taskRootAgent(ctx, parent).session)
    if (identity.allowedTools.includes(exec.name) && policy.allowedTools.includes(exec.name) && ctx.tools.get(exec.name, parent) !== undefined) return undefined
    return 'Advisor tool "' + exec.name + '" exceeds the original requester and current root policy.'
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || registry.identity(exec.agent) || isCapabilityAmplifier(ctx, exec.name, currentConfig().capabilityAmplifierTools) || INTERNAL_TOOLS.has(exec.name)) return next()
    const config = currentConfig()
    if (toolEffect(exec.name, config.readOnlyTools, config.mutatingTools) === 'read-only') return next()
    return workspace.run(String(taskRootAgent(ctx, exec.agent).id), false, exec.signal, next, String(exec.agent.id))
  })

  ctx.systemPrompt.section({
    name: 'escalation-advisor-guidance', order: 2860,
    text: ({ agent }) => agent ? guidanceFor(agent).text : '',
  })
  ctx.systemPrompt.context({
    name: 'advisor:guidance', order: 2860,
    text: ({ agent }) => {
      if (!agent || !guidanceFor(agent).available) return ''
      return 'Advisor is available through consult_advisor. Actively consult before choosing among uncertain consequential designs, after the first substantive failed validation before a speculative fix, and before completion with unresolved correctness concerns. Do not wait for automatic escalation or repeated tool errors. Supply a focused question, hypothesis, evidence and competing options; verify the advice before acting.'
    },
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent) refreshTool(context.agent)
    const assembly = await next()
    if (!context.agent || !manualEnabled(context.agent) || ctx.tools.get(ADVISOR_TOOL_NAME, context.agent) === undefined) {
      return { ...assembly, tools: assembly.tools.filter(tool => tool.name !== ADVISOR_TOOL_NAME), sections: assembly.sections.filter(section => section.name !== 'escalation-advisor-guidance'), contexts: assembly.contexts.filter(context => context.name !== 'advisor:guidance') }
    }
    if (!goalRoundActive.has(String(context.agent.id))) return assembly
    return {
      ...assembly,
      contexts: assembly.contexts.map(context => context.name === 'advisor:guidance' ? { ...context, text: context.text + '\n\n' + GOAL_ROUND_ADVISOR_ROUTE } : context),
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (registry.identity(agent)) return
    const key = String(agent.id)
    if (message.source.kind === 'goal') goalRoundActive.add(key)
    else if (message.source.kind === 'user') goalRoundActive.delete(key)
  })

  /**
   * Continuable Advisor conversations, by the durable consultation id the
   * requesting agent sends back to continue one. Only ids issued by THIS live
   * root task are honored: an unknown or foreign id is refused, never silently
   * started as a fresh consultation.
   */
  type ConsultationRecord = { consultationId: string; childSessionId: string; requesterId: string; rootId: string; turns: number; mode: ConsultationMode; taskAnchor: number; invocationId?: string; deliveredSeq: number }
  const consultations = new Map<string, ConsultationRecord>()
  // A delivery counter, not wall-clock time and not map insertion order: "latest" has
  // to be deterministic, and a follow-up delivered into an OLDER conversation must
  // become the latest one. Only a delivered consultation is ever recorded, so failed
  // and in-flight attempts cannot move it.
  let delivered = 0
  const evictConsultations = (): void => {
    while (consultations.size > 64) {
      let oldest: string | undefined
      let oldestSeq = Number.POSITIVE_INFINITY
      for (const [key, record] of consultations) {
        if (record.deliveredSeq < oldestSeq) { oldestSeq = record.deliveredSeq; oldest = key }
      }
      if (oldest === undefined) break
      const evicted = consultations.get(oldest)
      consultations.delete(oldest)
      // Dropping the route must not drop a live turn: revoke only an activation
      // still owned by the EVICTED record's invocation — a newer turn on the same
      // child (or a restored record that carries no invocation) is never touched.
      try {
        if (evicted?.invocationId !== undefined) registry.revokeTurn(evicted.childSessionId, evicted.invocationId)
      } catch {}
    }
  }
  const rememberConsultation = (value: Omit<ConsultationRecord, 'deliveredSeq'>, deliveredNow = true): void => {
    // Keyed by the BARE uuid: the handle a caller holds is `<uuid>#<turn>.<attempt>`,
    // but one conversation is ONE record whatever handle form addresses it — the id
    // the FIRST turn minted, or that same uuid on its own.
    // Map.set on an existing key does NOT move it to the end, so delete first:
    // otherwise a just-continued consultation stays eviction-oldest by creation order.
    const mapKey = handleBase(value.consultationId)
    const existing = consultations.get(mapKey)
    if (existing !== undefined) consultations.delete(mapKey)
    // A stale run keeps its restore address but must not move the delivered
    // ordering: "last" still means the most recently DELIVERED consultation.
    // A consultation that never delivered keeps sequence 0 — never the alias
    // target, and evicted before any delivered one.
    const deliveredSeq = deliveredNow ? ++delivered : (existing?.deliveredSeq ?? 0)
    consultations.set(mapKey, { ...value, deliveredSeq })
    evictConsultations()
  }

  // P0-durable: rebuild delivered MANUAL continuations from the persisted
  // advisor/run log so a restart / plugin-reload can continue the same child.
  // Only manual consultations are restored (automatic ones are re-triggered by
  // fresh evidence). The child does NOT have to be live: the record is only a
  // route, and `sendMessage` cold-resumes a missing direct child — its own
  // direct-parent authorization stays the final check. Without this, a restart
  // silently makes every earlier consultation unavailable.
  const restoreConsultations = (root: Agent): void => {
    try {
      const rootId = String(root.id)
      for (const run of advisorRunHistory(root)) {
        if (run.mode !== 'manual' || run.status !== 'delivered' || !run.childSessionId) continue
        if (run.requesterId === undefined) continue
        const mapKey = handleBase(run.id)
        // Keep the LATEST delivered turn: an older row would resume counting from
        // a stale turn index and collide with the newer turn's channel identity.
        const kept = consultations.get(mapKey)
        if (kept !== undefined && (kept.turns ?? 0) >= (run.turns ?? 1)) continue
        consultations.set(mapKey, {
          consultationId: run.id,
          childSessionId: run.childSessionId,
          requesterId: run.requesterId,
          rootId,
          turns: run.turns ?? 1,
          mode: 'manual',
          // Records written before task scoping adopt the CURRENT task's anchor;
          // records that carry one are refused at lookup once the task moves on.
          taskAnchor: run.taskAnchor ?? latestUserSeq(root),
          deliveredSeq: ++delivered,
        })
      }
      evictConsultations()
    } catch (error) {
      logger.warn('Advisor consultation restore failed: ' + redactSecrets(error instanceof Error ? error.message : String(error)))
    }
  }
  // The `last` alias resolves only inside the calling agent's own scope: its own
  // delivered MANUAL consultations on this exact root task. Automatic consultations
  // never move it, a sibling agent can never reach another agent's conversation
  // through it, and a record from an earlier task — or one that never delivered —
  // is ineligible.
  const latestManualConsultation = (requesterId: string, rootId: string, taskAnchor: number): ConsultationRecord | undefined => {
    let latest: ConsultationRecord | undefined
    for (const record of consultations.values()) {
      if (record.mode !== 'manual' || record.deliveredSeq === 0 || record.requesterId !== requesterId || record.rootId !== rootId || record.taskAnchor !== taskAnchor) continue
      if (latest === undefined || record.deliveredSeq > latest.deliveredSeq) latest = record
    }
    return latest
  }
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    const rootId = String(agent.id)
    for (const [requested, value] of consultations) if (value.rootId === rootId) consultations.delete(requested)
  })
  ctx.effect(() => () => consultations.clear(), 'advisor: drop continuation records')

  const epochOf = (agent: Agent): number => workspaceEpoch.get(String(taskRootAgent(ctx, agent).id)) ?? 0
  const consult = async (agent: Agent, mode: ConsultationMode, trigger: ReviewTrigger, args: AskAdvisorArgs, signal: AbortSignal, revision: string, options: { onStarted?: () => void; continuation?: { consultationId: string; publicId: string; childSessionId: string; turns: number } } = {}) => {
    // Unique per consult() call: attempts restart at 1 on every follow-up call,
    // so the turn identity must not recycle across calls sharing one consultation.
    const attemptNonce = randomUUID()
    const root = taskRootAgent(ctx, agent), id = options.continuation?.consultationId ?? randomUUID()
    // The handle the FIRST turn minted, reused verbatim by every later turn: a caller
    // that continues with the id it was handed gets that same id back.
    const publicId = options.continuation?.publicId ?? handleOf(id, 0)
    const config = configFor(agent)
    const sinceSeq = mode === 'continuous' ? reviewed.get(String(agent.id))?.seq : undefined
    const turns = options.continuation?.turns ?? 0
    const epochAtDispatch = epochOf(agent)
    let continuation: AdvisorContinuation = options.continuation === undefined
      ? { kind: 'start', prompt: '' }
      : { kind: 'continue', childSessionId: options.continuation.childSessionId, prompt: '' }
    // One retry per consultation: a second full attempt recovers a transient failure
    // or an authentication repair, and a consultation that still cannot be delivered
    // leaves eligibility to the next consultation instead of exhausting this one.
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The collector record is single-use per turn: one record with one candidate
      // slot cannot hold turn 2 without refusing a legitimate second verdict as
      // 'duplicate' or 'conflicting'.
      const collectorId = id + '#' + turns + '.' + attempt + '.' + attemptNonce
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
      const runRecord: AdvisorRunRecord = {
        version: 1, id, requesterId: String(agent.id), mode, turn: trigger.turn, ...(trigger.step === undefined ? {} : { step: trigger.step }), collectorId, turns: turns + 1,
        taskRevision: revision, taskAnchor: taskAnchorOf(agent), ...(trigger.decision ? { fingerprint: trigger.decision.problemFingerprint, score: trigger.decision.score } : {}),
        attempt, status: 'reserved', timestamp: new Date().toISOString(), question: redactSecrets(args.question),
      }
      const record = (patch: Partial<AdvisorRunRecord>) => { Object.assign(runRecord, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), { timestamp: new Date().toISOString() }); recordRun(agent, root, runRecord) }
      // Every attempt is tracked from `reserved`: an attempt that never reached the
      // model must not leave `started` behind for the next one to inherit.
      record({ status: 'reserved' })
      try {
        const result = await limiter.run(String(root.id), { maxTotal: config.maxAdvisorConsultsPerTask, maxConcurrent: config.maxConcurrentAdvisorRuns, trackStart: true }, attemptSignal, async markStarted => {
          if (!fresh(agent, revision)) throw new AdvisorUnavailableError('Task changed before Advisor started.', 'stale')
          const policy = effectiveAdvisorPolicy(currentConfig(), root.session)
          const surface = advisorToolSurface(ctx, agent, policy, config.capabilityAmplifierTools)
          const exclusive = surface.allowedTools.some(tool => toolEffect(tool, config.readOnlyTools, config.mutatingTools) !== 'read-only')
          const ancestors: string[] = []
          let current: Agent | undefined = agent
          while (current && !ancestors.includes(String(current.id))) {
            ancestors.push(String(current.id))
            current = current.session.header.parentSession === undefined ? undefined : ctx.agents.get(current.session.header.parentSession)
          }
          if (exclusive && workspace.hasSharedOwner(String(root.id), ancestors)) throw new AdvisorUnavailableError('An ancestor is still inside a potentially mutating tool; an editing Advisor cannot safely acquire the workspace.', 'workspace_busy')
          return workspace.run(String(root.id), exclusive, attemptSignal, async () => {
            if (!fresh(agent, revision)) throw new AdvisorUnavailableError('Task changed before Advisor started.', 'stale')
            const packet = buildCasePacket({
              requester: agent, root, mode, question: args.question, consultationId: publicId,
              currentHypothesis: args.current_hypothesis, decisionNeeded: args.decision_needed,
              evidence: [...args.evidence ?? [], ...args.context ? [args.context] : []],
              failedAttempts: [...args.failed_attempts ?? [], ...args.attempts ? [args.attempts] : []],
              ...(trigger.decision ? { trigger: { ...trigger.decision, turn: trigger.turn, ...(trigger.step === undefined ? {} : { step: trigger.step }) } } : {}),
              ...surface, mutationPolicy: exclusive ? 'may-edit' : 'propose-only', sinceSeq,
              observedEvidence: tracker.evidence(String(agent.id)),
              taskStartSeq: taskStarts.get(String(agent.id)),
            })
            if (mode === 'continuous' && !packet.meaningful) return undefined
            // Every attempt delivers this turn's own packet: a fresh consultation carries
            // it as its first prompt, and a follow-up carries it as the new turn's content.
            if (continuation.kind === 'start') continuation = { kind: 'start', prompt: packet.prompt }
            else continuation = { kind: 'continue', childSessionId: continuation.childSessionId, prompt: packet.prompt }
            const answer = await callAdvisor(ctx, config, agent, continuation, attemptSignal, policy, 'Advisor · ' + mode + ' · turn ' + trigger.turn, {
              registry, root, collector: verdicts, publicId, collectorId, ...(options.continuation === undefined ? {} : { followUp: true }), onStarted: () => { markStarted(); options.onStarted?.(); record({ status: 'started' }) },
              // A retry of a FRESH consultation must start a new conversation, so only
              // a follow-up keeps addressing its child: without this guard the failed
              // first attempt's child would leak into the retry's authorization and
              // stream observation while the retry actually starts a new child.
              onPublished: childSessionId => { if (continuation.kind === 'continue') continuation = { kind: 'continue', childSessionId, prompt: '' }; record({ childSessionId }) },
            })

            return { answer, lastSeq: packet.lastSeq }
          })
        })
        if (!result) { record({ status: 'skipped' }); return undefined }
        if (!fresh(agent, revision)) { record({ status: 'stale', childSessionId: result.answer.childSessionId, usage: result.answer.usage, summary: result.answer.verdict.summary, severity: result.answer.verdict.severity }); return undefined }
        // Workspace-epoch staleness is enforced by the caller comparing the
        // epoch captured at dispatch against the current epoch (see below).
        if (epochOf(agent) !== epochAtDispatch) {
          record({ status: 'stale', childSessionId: result.answer.childSessionId, usage: result.answer.usage, summary: result.answer.verdict.summary, severity: result.answer.verdict.severity, error: 'Workspace changed during the Advisor run; the review is kept for audit but not steered.' })
          // The route survives so the conversation can still be continued by
          // explicit id, but a stale run never DELIVERED: it must not move the
          // "last" pointer or the delivered LRU ordering.
          rememberConsultation({ consultationId: id, childSessionId: result.answer.childSessionId, requesterId: String(agent.id), rootId: String(root.id), turns: turns + 1, mode, taskAnchor: taskAnchorOf(agent), invocationId: result.answer.invocationId }, false)
          return undefined
        }
        // Bound telemetry: the full verdict lives in the Advisor child transcript;
        // the requester/root log keeps a bounded digest, never an unbounded copy.
        {
          const full = mode === 'manual' ? JSON.stringify(toolAnswer(result.answer, publicId)) : textContent(adviceMessage(result.answer.verdict, mode, result.answer.childSessionId, publicId).content)
          const bounded = truncateUtf8(full, 4096)
          record({ status: 'delivered', childSessionId: result.answer.childSessionId, summary: truncateUtf8(result.answer.verdict.summary, 1024), severity: result.answer.verdict.severity, usage: result.answer.usage, verdictTool: ADVISOR_VERDICT_TOOL,
            responseText: bounded })
        }
        // Any delivered consultation — manual or automatic — advances the review
        // watermark so a subsequent automatic trigger on the SAME evidence does
        // not immediately spend a second strong-model call. New failures,
        // validations, mutations or conclusions move the evidence version past it.
        {
          const key = String(agent.id)
          const fp = trigger.decision?.problemFingerprint
          const entry = reviewWatermark.get(key) ?? { evidenceVersion: 0, fingerprints: new Set<string>(), seq: 0, epoch: 0 }
          if (fp) entry.fingerprints.add(fp)
          // A manual review carries no trigger decision, so it covers the live
          // problems instead: without this it would suppress nothing at all.
          for (const live of tracker.currentFingerprints(key)) entry.fingerprints.add(live)
          entry.evidenceVersion = tracker.observationCount(key)
          entry.seq = result.lastSeq
          entry.epoch = structuralOf(agent)
          reviewWatermark.set(key, entry)
          reviewed.set(key, { turn: trigger.turn, seq: result.lastSeq })
        }
        // The id stays stable for the whole conversation so a follow-up turn can
        // address the SAME child session instead of starting a new consultation.
        rememberConsultation({ consultationId: id, childSessionId: result.answer.childSessionId, requesterId: String(agent.id), rootId: String(root.id), turns: turns + 1, mode, taskAnchor: taskAnchorOf(agent), invocationId: result.answer.invocationId })
        return result.answer

      } catch (error) {
        const message = truncateUtf8(redactSecrets(error instanceof Error ? error.message : String(error)), 1500)
        const cancelled = signal.aborted || error instanceof AdvisorUnavailableError && error.code === 'cancelled'
        const stale = !fresh(agent, revision) || error instanceof AdvisorUnavailableError && error.code === 'stale'
        // A start the runtime refused is retryable: the retry either continues the
        // established conversation or falls back to a fresh one.
        const retryableStart = runRecord.status !== 'started' && (error instanceof AdvisorUnavailableError && ['child_start_failed', 'child_failed', 'retryable_start', START_REJECTED].includes(error.code) || error instanceof AdvisorTaskLimitError && error.code === 'task_budget_reserved')
        const transient = retryableStart || error instanceof AdvisorUnavailableError && error.transient || error instanceof Error && error.name === 'TimeoutError'
        record({ status: stale ? 'stale' : cancelled ? 'cancelled' : transient ? 'failed-transient' : 'failed-permanent', error: message })
        if (!transient || cancelled || stale || attempt === 2 || mode === 'manual') {
          if (retryableStart && !cancelled && !stale) throw new AdvisorUnavailableError(message, 'retryable_start', true)
          throw error
        }
        await delay(config.retryDelayMs, undefined, { signal })
      }
    }
    return undefined
  }

  registerAdvisorVerdictTool(ctx, { registry, collector: verdicts })
  ctx.tools.register(defineTool({
    name: ADVISOR_TOOL_NAME,
    description: 'Ask a stronger model for an independent engineering review in a visible child session. Supply the question, hypothesis, evidence and failed attempts; the harness supplies the task. By default this starts a NEW Advisor conversation; pass consultation_id to continue an earlier one.',
    parameters: {
      question: { type: 'string', required: true }, goal: { type: 'string' }, current_hypothesis: { type: 'string' }, decision_needed: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } }, failed_attempts: { type: 'array', items: { type: 'string' } }, attempts: { type: 'string' }, context: { type: 'string' },
      // Continue an EXISTING consultation as a new turn of the SAME Advisor
      // conversation: earlier context, persona and tool policy stay intact.
      consultation_id: { type: 'string', description: 'Continue an earlier Advisor conversation instead of starting a new one: pass the consultation_id that earlier result returned. Reuse it when this question builds on that review — supplying the evidence it asked for, challenging its verdict, or refining the same decision — because the advisor keeps its earlier context, persona and tool policy. Omit it for an unrelated problem, and also when you want a deliberately independent reassessment of a related one: a fresh consultation does not inherit the earlier framing. An unknown or foreign id is refused rather than silently restarted as a new consultation. The literal value "last" means the most recent DELIVERED manual consultation YOU opened on this task — not simply whatever was discussed most recently, and automatic consultations and failed or still-running calls do not count. The reply reports the concrete consultation_id it resolved to, so you always learn which conversation you actually continued.' },

    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        disposition: { type: 'string', required: true },
        evidence_used: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, reference: { type: 'string', required: true } } } },
        assumptions: { type: 'array', required: true, items: { type: 'string' } },
        recommended_next_action: { type: 'string', required: true }, validation_plan: { type: 'array', required: true, items: { type: 'string' } },
        needs_more_evidence: { type: 'boolean', required: true },
        changes_made: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } }, reason: { type: 'string', required: true }, validation: { type: 'array', required: true, items: { type: 'string' } },
        } } },
        status: { type: 'string', required: true, enum: ['ok', 'unavailable', 'error'] }, severity: { type: 'string', required: true, enum: ['none', 'nit', 'concern', 'blocker'] },
        summary: { type: 'string', required: true }, diagnosis: { type: 'string', required: true }, next_actions: { type: 'array', required: true, items: { type: 'string' } },
        confidence: { type: 'number', required: true }, child_session_id: { type: 'string', required: true }, consultation_id: { type: 'string', required: true },
      } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContext) {
      if (!exec.agent || !manualEnabled(exec.agent)) return unavailable('Advisor is not configured or enabled for this agent.')
      const agent = exec.agent, key = String(agent.id), config = currentConfig()
      if (config.maxManualConsultsPerSession >= 0 && (manualCalls.get(key) ?? 0) + (manualReserved.get(key) ?? 0) >= config.maxManualConsultsPerSession) return unavailable('Manual Advisor consultation budget reached.')
      manualReserved.set(key, (manualReserved.get(key) ?? 0) + 1)
      let started = false
      const args = raw as AskAdvisorArgs
      // A follow-up must address a consultation THIS exact live requester opened
      // on the same root task: an unknown or foreign id is refused outright and
      // never silently restarted as a fresh consultation. The id is RESOLVED to its
      // bare uuid — the store's key — while the id the caller supplied is echoed
      // back verbatim: the handle a caller was handed always continues its own
      // conversation, and always comes back to it unchanged.
      const refundReservation = (): void => { manualReserved.set(key, Math.max(0, (manualReserved.get(key) ?? 1) - 1)) }
      let continuation: { consultationId: string; publicId: string; childSessionId: string; turns: number } | undefined
      if (typeof args.consultation_id === 'string' && args.consultation_id.trim()) {
        const requested = args.consultation_id.trim()
        const rootId = String(taskRootAgent(ctx, agent).id)
        // Task scope is part of the binding, not just ownership: a consultation
        // opened under an earlier task is refused by id AND by the alias, so a
        // stale or restored route can never leak across a task boundary.
        const taskAnchor = taskAnchorOf(agent)
        // The alias is resolved HERE, once, into a concrete record, and the resolved
        // binding is what the whole call carries — a retry cannot retarget it. When it
        // resolves to nothing the call is refused outright: silently starting a fresh
        // consultation would let a caller believe it continued one when it did not.
        if (requested.toLowerCase() === LATEST_ALIAS) {
          const latest = latestManualConsultation(key, rootId, taskAnchor)
          if (!latest) { refundReservation(); return unavailable('There is no earlier manual consultation to continue: "last" means the most recent DELIVERED manual consultation by this agent on this task, and there is none. A failed or still-running consultation does not count. Start a new consultation by omitting consultation_id.') }
          continuation = { consultationId: latest.consultationId, publicId: handleOf(latest.consultationId, 0), childSessionId: latest.childSessionId, turns: latest.turns }
        } else {
          const found = consultations.get(handleBase(requested))
          if (!found) { refundReservation(); return unavailable('Unknown consultation id: this agent has no open consultation with that id. Start a new consultation by omitting consultation_id.') }
          if (found.requesterId !== key || found.rootId !== rootId || found.taskAnchor !== taskAnchor) { refundReservation(); return unavailable('Consultation id belongs to another agent or task; it cannot be continued from here.') }
          continuation = { consultationId: found.consultationId, publicId: requested, childSessionId: found.childSessionId, turns: found.turns }
        }
      }
      try {
        const ending = agent.session.snapshotEvents().findLast(event => event.type === 'step/start')
        const answer = await consult(agent, 'manual', { turn: ending?.type === 'step/start' ? ending.data.turn : 0 }, args, AbortSignal.any([exec.signal, disposed.signal]), revisionOf(agent), {
          onStarted: () => { if (!started) { started = true; manualCalls.set(key, (manualCalls.get(key) ?? 0) + 1) } },
          ...(continuation === undefined ? {} : { continuation }),
        })
        // The id is returned for a FRESH consultation too: it is the handle a later
        // follow-up turn addresses, and it stays stable for the whole conversation.
        // It is the PUBLIC id — never this turn's internal collector identity, which
        // no map accepts as a continuation id.
        return answer ? toolAnswer(answer, answer.consultationId) : unavailable('Advisor result expired after the task changed.')
      } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)) }
      finally { manualReserved.set(key, Math.max(0, (manualReserved.get(key) ?? 1) - 1)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'advisor_obligation',
    description: 'Inspect and disposition open Advisor verification obligations. A disposition or a correction never closes an obligation: only a verification witness later than the latest failure, in the same scope and with no related change since, closes one. Use this to register a counterexample against a published claim, which no automatic classification can detect.',
    parameters: {
      action: { type: 'string', required: true },
      id: { type: 'string' }, claim_id: { type: 'string' }, summary: { type: 'string' },
      validation_call_id: { type: 'string' },
      disposition: { type: 'string' }, basis: { type: 'string' },
      document: { type: 'string' }, change: { type: 'string' }, evidence: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', required: true },
        message: { type: 'string', required: true },
        obligations: { type: 'array', required: true, items: { type: 'string' } },
      } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContext) {
      const args = (raw ?? {}) as Record<string, unknown>
      const text = (name: string) => typeof args[name] === 'string' ? String(args[name]).trim() : ''
      const action = text('action') || 'list'
      if (!exec.agent || roleOf(exec.agent) !== 'root') return { action, message: 'Advisor obligations are tracked for root tasks only.', obligations: [] }
      const key = String(exec.agent.id), taskStartSeq = taskStarts.get(key) ?? 0
      const scope = 'task:' + key + ':' + taskStartSeq
      const describe = (item: Obligation) => item.id + ' [' + item.kind + '/' + item.state + ', seen ' + item.repeatCount + 'x' + (item.disposition ? ', disposition=' + item.disposition.kind : '') + (item.resolution ? ', resolved=' + item.resolution.kind : '') + '] ' + item.summary
      const listed = () => obligations.list(key, taskStartSeq).map(describe)
      const id = text('id'), seq = exec.agent.session.seq
      if (action === 'list') return { action, message: listed().length ? 'Current-run obligations (runtime only: a restart keeps no record).' : 'No current-run obligation record.', obligations: listed() }
      if (action === 'register') {
        const claimId = text('claim_id'), summary = text('summary'), validationCallId = text('validation_call_id')
        if (!claimId || !summary) return { action, message: 'register requires claim_id and summary.', obligations: listed() }
        if (!validationCallId) return { action, message: 'register requires validation_call_id: the tool call id of an observed validation command in this task whose pass/fail identity this claim can be re-verified against. Run the check first, then register with its call id.', obligations: listed() }
        const evidence = tracker.evidence(key).find(item => item.callId === validationCallId)
        if (!evidence) return { action, message: 'Unknown validation_call_id for this task: no observed tool evidence carries that call id. Run the verification command first, then register with its call id.', obligations: listed() }
        if (!evidence.validationKey) return { action, message: 'That call carries no validation identity (it is not a recognized test/typecheck/lint/build invocation), so it cannot be closed automatically. Re-run a recognized validation command and register with its call id.', obligations: listed() }
        // A claim keeps the FIRST verified identity it was bound to: silently
        // swapping it would let a later pass of validation A close a contradiction
        // the caller just attributed to validation B.
        const clash = obligations.list(key, taskStartSeq).find(item => item.kind === 'claim-contradicted' && item.claimId === claimId && item.validationKey !== undefined && item.validationKey !== evidence.validationKey)
        if (clash?.validationKey) return { action, message: 'Claim ' + claimId + ' is already bound to validation ' + clash.validationKey.slice(0, 12) + ' on ' + clash.id + '; it cannot be re-registered against ' + evidence.validationKey.slice(0, 12) + '. Use a new claim_id for a different check, or disposition the existing item.', obligations: listed() }
        const item = obligations.recordClaimContradiction({ sessionId: key, taskStartSeq, scope, seq, at: Date.now(), claimId, summary: redactSecrets(summary).slice(0, 300), validationKey: evidence.validationKey })
        return { action, message: 'Registered ' + item.id + ' against validation ' + (item.validationKey ?? evidence.validationKey).slice(0, 12) + '. It stays open until a correction record AND a later pass of the same validation (no related change since) both exist.', obligations: listed() }
      }
      if (action === 'disposition') {
        const kind = text('disposition'), basis = text('basis')
        if (kind !== 'not-applicable' && kind !== 'accept-risk') return { action, message: 'disposition must be not-applicable or accept-risk.', obligations: listed() }
        if (!basis) return { action, message: 'A disposition requires a checkable basis.', obligations: listed() }
        const item = obligations.recordDisposition(key, taskStartSeq, id, { kind, basis: redactSecrets(basis).slice(0, 300), at: Date.now(), seq })
        return { action, message: item ? 'Recorded ' + kind + ' on ' + item.id + '. It remains open and is listed at the end of the turn.' : 'No such obligation.', obligations: listed() }
      }
      if (action === 'correct') {
        const claimId = text('claim_id'), document = text('document'), change = text('change'), evidence = text('evidence')
        if (!claimId || !document || !change || !evidence) return { action, message: 'correct requires claim_id, document, change and evidence.', obligations: listed() }
        const correction = { claimId, document: redactSecrets(document).slice(0, 200), change: redactSecrets(change).slice(0, 300), evidence: redactSecrets(evidence).slice(0, 300), at: Date.now(), seq }
        let item = id ? obligations.recordCorrection(key, taskStartSeq, id, correction) : undefined
        // Models fumble ids the way callers fumble consultation handles: when no
        // id is given but the claim id names exactly one open item, use it rather
        // than refusing. An explicit id keeps the strict behavior above.
        if (!item && !id) {
          const candidates = obligations.list(key, taskStartSeq).filter(candidate => candidate.kind === 'claim-contradicted' && candidate.state === 'open' && candidate.claimId === claimId)
          if (candidates.length > 1) return { action, message: 'Several open obligations share claim_id ' + claimId + '; pass the id shown by list.', obligations: listed() }
          if (candidates.length === 1) item = obligations.recordCorrection(key, taskStartSeq, candidates[0]!.id, correction)
        }
        return { action, message: item ? 'Recorded the correction on ' + item.id + '. A correction alone does not close it; a verification witness must still follow the failure.' : 'No such obligation, or the claim id does not match.', obligations: listed() }
      }
      return { action, message: 'Unknown action. Use list, register, disposition or correct.', obligations: listed() }
    },
  }))

  for (const agent of ctx.agents.list()) {
    refreshTool(agent)
    if (agent.session.header.parentSession === undefined) restoreConsultations(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    refreshTool(agent)
    if (agent.session.header.parentSession === undefined) restoreConsultations(agent)
  })
  ctx.on('settings/updated', namespace => { if (namespace === SETTINGS_NAMESPACE) { suppressed.clear(); retryableStarts.clear(); for (const agent of ctx.agents.list()) refreshTool(agent) } })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (registry.identity(agent)) return
    const key = String(agent.id)
    // An autonomous goal round is NOT a new task. It must not clear the failure
    // score or move the task boundary: open obligations, their closure scope and
    // the per-task reminder budget all stay with the task. It also has no human
    // turn to restate the open items, so injection alone is re-armed, once per
    // round, for the task the goal is running inside.
    if (message.source.kind === 'goal') {
      obligations.rearmInjection(key, taskStarts.get(key) ?? 0)
      return
    }
    if (message.source.kind !== 'user') return
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
    tracker.clear(key)
    reviewWatermark.delete(key)
    taskStarts.set(key, agent.session.seq)
    for (const pending of retryableStarts.keys()) if (pending.startsWith(key + '|')) retryableStarts.delete(pending)
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent) {
      const agentKey = String(exec.agent.id)
      dispatchTick += 1
      dispatchSeq.set(String(exec.callId), { seq: exec.agent.session.seq, taskStartSeq: taskStarts.get(agentKey) ?? 0, tick: dispatchTick, agentKey })
      // Expire by shared tick distance so in-flight calls keep their start
      // boundary no matter which session dispatched around them.
      for (const [id, entry] of dispatchSeq) if (dispatchTick - entry.tick > 512) dispatchSeq.delete(id)
    }
    return await next()
  })

  ctx.on('tools/result', (exec, result: Readonly<ToolExecutionResult>) => {
    if (!exec.agent || exec.name === ADVISOR_TOOL_NAME) return
    const config = configFor(exec.agent)
    if (!routeConfigured(config)) return
    // Advisor edits still change the shared workspace (epoch + obligation
    // freshness), but an Advisor's own tool calls never feed its escalation
    // tracker: they are review work, not requester evidence.
    const advisorResult = roleOf(exec.agent) === 'advisor'
    if (advisorResult && toolEffect(exec.name, config.readOnlyTools, config.mutatingTools) === 'read-only') return
    const agentKey = String(exec.agent.id), callId = String(exec.callId)
    // Task identity is captured at dispatch so a task change mid-call cannot
    // re-attribute the run. When the dispatch entry is gone (evicted as a lost
    // orphan long ago), the result is quarantined: attributing it to the CURRENT
    // task would score stale evidence and open obligations in the wrong task.
    // The tool result itself still reaches the model; only plugin bookkeeping
    // abstains. A missing entry is never backfilled from current state.
    const dispatched = dispatchSeq.get(callId)
    // A result whose dispatch identity was lost keeps its observable workspace
    // effects (epoch, structural and obligation mutations below use live session
    // state, not the lost window) but contributes nothing task-specific: scoring
    // it, opening failures, or closing proofs against the CURRENT task would
    // misattribute ancient evidence. startedSeq stays undefined, so witnesses
    // still close nothing on its behalf either.
    const attributionLost = dispatched === undefined
    if (dispatched !== undefined) dispatchSeq.delete(callId)
    const currentTaskStart = taskStarts.get(agentKey) ?? 0
    // A result recorded under a task the agent has since left must not score,
    // open, or close anything in the new task: its evidence belongs to a dead
    // scope. Workspace freshness below still observes that something ran.
    const staleTask = dispatched !== undefined && dispatched.taskStartSeq !== currentTaskStart
    const taskStartSeq = dispatched?.taskStartSeq ?? currentTaskStart
    const scope = 'task:' + agentKey + ':' + taskStartSeq
    const observed = {
      callId, name: exec.name, arguments: exec.arguments, isError: result.isError, scope,
      ...(result.isError ? { errorMessage: result.error.message, errorCode: result.error.info?.code } : { value: result.value }), contentText: textContent(result.content),
    }
    const startedSeq = dispatched?.seq
    const completedSeq = exec.agent.session.seq
    if (!advisorResult && !attributionLost && !staleTask) tracker.observe(agentKey, observed, config)
    const outcome = classifyToolOutcome(observed)
    // Freshness distinguishes execution from mutation. Review traffic (the verdict
    // channel, inspection reads, the obligation tool itself) stays fully invisible.
    // A validation execution is evidence, not interference: it moves neither the
    // structural clock (its own writes are the check) nor — by call id in the
    // witness — its own proof. Everything genuinely mutating (shells, configured
    // or path-carrying custom tools, worker and Advisor edits) counts, mirrored
    // into the root scope when it originates off-root. The epoch only ever marks
    // reviews stale, never proofs.
    const effect = toolEffect(exec.name, config.readOnlyTools, config.mutatingTools)
    const structural = mutationKey(exec.name, exec.arguments) !== undefined
    const reviewTraffic = advisorResult && effect !== 'mutating' && !structural
    const countsAsMutation = !reviewTraffic && (effect === 'mutating' || structural)
    if (countsAsMutation) {
      // An editing Advisor's own effects must not stale its own review (the verdict
      // reports them), and no concurrent read-only review can exist beside it:
      // the exclusive workspace lease serializes editors against every reader.
      // Its edits still invalidate older proofs via the mirror below.
      if (!advisorResult) {
        try {
          const rootId = String(taskRootAgent(ctx, exec.agent).id)
          workspaceEpoch.set(rootId, (workspaceEpoch.get(rootId) ?? 0) + 1)
        } catch {}
      }
      if (outcome.validationKey === undefined) bumpStructural(exec.agent)
      const mutation = { sessionId: agentKey, taskStartSeq, scope, seq: completedSeq, applied: !result.isError, callId }
      obligations.recordMutation(mutation)
      // A worker or Advisor shares the root's workspace: mirror the mutation into
      // the root scope with the root's current seq (session seqs are not
      // comparable across agents), so it invalidates a root witness that it
      // genuinely outdates.
      if (roleOf(exec.agent) !== 'root') {
        try {
          const rootAgent = taskRootAgent(ctx, exec.agent), rootKey = String(rootAgent.id)
          const rootStart = taskStarts.get(rootKey) ?? 0
          obligations.recordMutation({ sessionId: rootKey, taskStartSeq: rootStart, scope: 'task:' + rootKey + ':' + rootStart, seq: rootAgent.session.seq, applied: !result.isError, callId })
        } catch {}
      }
    }
    if (attributionLost || staleTask) return
    if (roleOf(exec.agent) !== 'root') return
    if (opensObligation(outcome.class)) {
      obligations.recordFailure({
        sessionId: agentKey, taskStartSeq, scope, seq: completedSeq, at: Date.now(), callId,
        ...(outcome.validationKey ? { validationKey: outcome.validationKey } : {}),
        summary: redactSecrets((result.isError ? result.error.message : observed.contentText) || exec.name).slice(0, 300),
      })
    } else if (outcome.class === 'success' && outcome.validationKey && outcome.exitCode === 0 && !outcome.compound && !staleTask) {
      obligations.recordValidation({ sessionId: agentKey, taskStartSeq, scope, validationKey: outcome.validationKey, callId, ...(startedSeq === undefined ? {} : { startedSeq }), completedSeq, succeeded: true })
    }
  })

  const automatic = async (agent: Agent, turn: number, step: number | undefined, signal: AbortSignal, preStep: boolean): Promise<UserMessage | undefined> => {
    const config = configFor(agent), role = roleOf(agent), key = String(agent.id)
    if (!routeConfigured(config) || config.mode === 'manual' || inFlight.has(key)) return
    const mode: ConsultationMode = config.mode === 'continuous' ? 'continuous' : 'escalation'
    if (mode === 'continuous' && preStep || !coverageEnabled(config, mode, role)) return
    if (mode === 'continuous' && reviewed.get(key)?.turn === turn) return
    const decision = mode === 'escalation' ? tracker.decision(key, turn, config) : undefined
    if (decision && !decision.shouldConsult) return
    // A delivered consultation (manual OR automatic) suppresses a repeat
    // automatic consultation on the same evidence: only NEW failures,
    // validations, mutations or conclusions re-arm it.
    {
      const mark = reviewWatermark.get(key)
      if (mark !== undefined) {
        const fp = decision?.problemFingerprint
        if (fp !== undefined) {
          // Escalation re-arms on a new (uncovered) problem or a structural
          // workspace change since the review — never on a bare repeat of a
          // covered problem, no matter how many times the bounded evidence
          // array shifted under it. (The conservative shell-inclusive epoch is
          // deliberately NOT consulted here: a repeat failure through bash would
          // otherwise re-arm every time.)
          if (mark.fingerprints.has(fp) && structuralOf(agent) === mark.epoch) return
        } else if (tracker.observationCount(key) <= mark.evidenceVersion) {
          // Continuous review has no fingerprint: new tool evidence or a material
          // assistant conclusion re-arms it.
          if (!hasNewMaterialConclusion(agent.session.snapshotEvents(), mark.seq)) return
        }
      }
    }
    const revision = revisionOf(agent)
    const suppressionKey = [key, revision, mode, decision?.problemFingerprint ?? turn].join('|')
    if (suppressed.has(suppressionKey)) return
    if ((retryableStarts.get(suppressionKey)?.after ?? 0) > Date.now()) return
    const root = taskRootAgent(ctx, agent), policy = effectiveAdvisorPolicy(config, root.session)
    const wait = role !== 'root' || hasMutation(agent) ? 'block' : mode === 'continuous' ? policy.continuousWait : policy.escalationWait
    inFlight.add(key)
    const review = async (runSignal: AbortSignal): Promise<UserMessage | undefined> => {
      try {
        const answer = await consult(agent, mode, { turn, ...(step === undefined ? {} : { step }), ...(decision ? { decision } : {}) },
          { question: mode === 'escalation' ? 'Diagnose the repeated failures and recommend a verifiable next action.' : 'Review new changes, failures, validation and conclusions since the previous review.' }, runSignal, revision)
        if (!answer || !fresh(agent, revision)) return
        retryableStarts.delete(suppressionKey)
        if (decision) tracker.markAutoConsult(key, turn, decision.problemFingerprint)
        const verdict = answer.verdict
        const changed = (verdict.changesMade?.length ?? 0) > 0
        if (verdict.severity === 'none' && !changed) return
        const message = adviceMessage(verdict, mode, answer.childSessionId, answer.consultationId)
        const threshold = mode === 'continuous' ? Math.max(severityRank('concern'), severityRank(config.continuousMinSeverity)) : severityRank('concern')
        if (!changed && severityRank(verdict.severity) < threshold) {
          if (config.injectNits && role === 'root') futureNotes.set(key, [...futureNotes.get(key) ?? [], message].slice(-4))
        } else if (preStep && wait === 'block') return message
        else agent.steer(message)
      } catch (error) {
        if (error instanceof AdvisorUnavailableError && error.code === 'retryable_start') {
          const failures = (retryableStarts.get(suppressionKey)?.failures ?? 0) + 1
          retryableStarts.set(suppressionKey, { failures, after: Date.now() + Math.min(60000, config.retryDelayMs * 2 ** Math.min(6, failures - 1)) })
        } else suppressed.add(suppressionKey)
        logger.warn('Advisor unavailable: ' + redactSecrets(error instanceof Error ? error.message : String(error)))
      } finally { inFlight.delete(key) }
    }
    if (wait === 'block') return review(AbortSignal.any([signal, disposed.signal]))
    const controller = new AbortController()
    let active = controllers.get(key)
    if (!active) { active = new Set(); controllers.set(key, active) }
    active.add(controller)
    void review(AbortSignal.any([controller.signal, disposed.signal])).finally(() => { active!.delete(controller); if (!active!.size) controllers.delete(key) })
    return undefined
  }

  ctx.on('agent/pre-step', async (request, next) => {
    const identity = registry.identity(request.agent)
    if (identity && identity.advisorId !== String(request.agent.id)) return { kind: 'reject' }
    if (identity && identity.advisorId === String(request.agent.id)) {
      // The Advisor child is a visible audit session, not an open model endpoint:
      // every turn must correspond to a plugin-authorized activation created by
      // startContinuable/sendMessage for THIS invocation (bound, or pending in
      // the pre-bind window of a fresh start). Direct user prompts,
      // generic send_message, or stale turns without a live activation are refused
      // before they can reach budgets, locks, or the strong model.
      const turn = typeof request.turn === 'number' ? request.turn : undefined
      // Message ids are stable across representations, so the entering batch is
      // checked against the authorized delivery once it is bound: a step carrying
      // any other message — including a foreign message batched into our own turn —
      // is refused before the model sees it.
      const enteringIds = request.messages.map(message => String(message.id))
      if (!registry.isTurnAuthorized(String(request.agent.id), identity.invocationId, turn, enteringIds)) {
        return { kind: 'reject' }
      }
    }
    if (!identity && request.messages.some(message => message.source.kind === 'user')) {
      tracker.clear(String(request.agent.id))
      reviewWatermark.delete(String(request.agent.id))
      taskStarts.set(String(request.agent.id), request.agent.session.seq)
    }
    const nextStep = await next()
    if (nextStep.kind !== 'enter') return nextStep
    const key = String(request.agent.id)
    const notes = (futureNotes.get(key) ?? []).map(note => createUserMessage({
      source: note.source,
      content: [{ type: 'text', text: 'Historical optional Advisor note, accepted during a previous turn. This is context, not a request to resume that task. The current user request takes precedence; ignore this note if unrelated.\n\n' + textContent(note.content) }],
    }))
    futureNotes.delete(key)
    const advice = await automatic(request.agent, request.turn, request.step, request.signal, true)
    const taskStartSeq = taskStarts.get(key) ?? 0
    const due = roleOf(request.agent) === 'root' ? obligations.pendingInjection(key, taskStartSeq) : []
    const obligationNote = due.length ? obligationMessage(due, [], false) : undefined
    return advice || notes.length || obligationNote ? { ...nextStep, messages: [...nextStep.messages, ...notes, ...(obligationNote ? [obligationNote] : []), ...(advice ? [advice] : [])] } : nextStep
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    goalRoundActive.delete(String(agent.id))
    await automatic(agent, turn, undefined, signal, false)
    if (roleOf(agent) !== 'root') return
    const key = String(agent.id), taskStartSeq = taskStarts.get(key) ?? 0
    const open = obligations.open(key, taskStartSeq)
    if (!open.length) return
    // One reminder per obligation revision, under a fixed per-task budget that
    // neither repeats nor the reminder itself can extend.
    const due = obligations.pendingReminder(key, taskStartSeq)
    if (!due.length || !obligations.consumeReminder(key, taskStartSeq)) return
    for (const item of due) obligations.markReminded(item)
    // The last reminder the fixed budget allows is the handoff checklist, so an
    // unresolved item is disclosed once at the end rather than re-read every turn.
    const final = obligations.remindersUsed(key, taskStartSeq) >= MAX_AUTO_REMINDERS_PER_TASK
    agent.steer(obligationMessage(due, open.filter(item => !due.includes(item)), final))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    try { registry.revokeTurn(key) } catch {}
    try { registry.pruneConsumed() } catch {}
    tracker.clear(key); manualCalls.delete(key); manualReserved.delete(key); revisions.delete(key); reviewed.delete(key); futureNotes.delete(key); taskStarts.delete(key); obligations.clear(key); goalRoundActive.delete(key); reviewWatermark.delete(key)
    for (const [id, entry] of dispatchSeq) if (entry.agentKey === key) dispatchSeq.delete(id)
    for (const pending of retryableStarts.keys()) if (pending.startsWith(key + '|')) retryableStarts.delete(pending)
    hiddenTools.get(agent)?.(); hiddenTools.delete(agent)
    for (const controller of controllers.get(key) ?? []) controller.abort()
    controllers.delete(key)
    if (agent.session.header.parentSession === undefined) { limiter.clear(key); registry.clearRoot(key); workspaceEpoch.delete(key); structuralEpoch.delete(key) }
  })
}