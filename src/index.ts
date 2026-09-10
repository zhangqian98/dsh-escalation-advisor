import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, routeConfigured, severityRank, type Config as AdvisorConfig } from './config.js'
import { coverageEnabled, type AdvisorAgentRole } from './coverage.js'
import { buildCasePacket, textContent } from './context.js'
import { advisorToolSurface, callAdvisor, AdvisorUnavailableError, type AdvisorRunResult } from './model-runner.js'
import { effectiveAdvisorPolicy, installAdvisorPolicyCommand } from './policy.js'
import { toolGuidance } from './prompts.js'
import { EscalationTracker, classifyToolOutcome, mutationKey, type EscalationDecision } from './state.js'
import { MAX_AUTO_REMINDERS_PER_TASK, ObligationStore, opensObligation, type Obligation } from './obligations.js'
import { AdvisorTaskLimiter, AdvisorTaskLimitError } from './task-limiter.js'
import { AdvisorWorkspaceLock } from './workspace-lock.js'
import { AdvisorRegistry } from './registry.js'
import { isCapabilityAmplifier, toolEffect } from './capabilities.js'
import { recordRun, type AdvisorRunRecord, type ConsultationMode } from './telemetry.js'
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
interface AskAdvisorArgs { question: string; goal?: string; current_hypothesis?: string; decision_needed?: string; evidence?: string[]; failed_attempts?: string[]; attempts?: string; context?: string }
interface ReviewTrigger { turn: number; step?: number; decision?: EscalationDecision }

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

function adviceMessage(verdict: AdvisorVerdict, origin: ConsultationMode, child: string): UserMessage {
  const blocker = verdict.severity === 'blocker' ? '\nDo not continue the original approach until this finding has been checked and resolved.' : ''
  const actions = verdict.nextActions.map((item, index) => (index + 1) + '. ' + item).join('\n')
  const evidence = verdict.evidenceUsed?.map(item => item.kind + ': ' + item.reference).join('\n') ?? ''
  const validation = verdict.validationPlan?.join('\n') ?? ''
  const changes = verdict.changesMade?.map(item => item.paths.join(', ') + ': ' + item.reason + '\nValidation: ' + (item.validation.join('; ') || 'not reported')).join('\n') ?? ''
  return createUserMessage({
    content: [{ type: 'text', text: '[Strong advisor — ' + origin + '; severity=' + verdict.severity + '; child=' + child + ']\n' + verdict.summary + '\n\n' + verdict.diagnosis + '\n' + actions + blocker + '\nEvidence used:\n' + (evidence || 'not reported') + '\nValidation plan:\n' + (validation || 'not reported') + '\nChanges made by Advisor:\n' + (changes || 'none reported') + '\n\nVerify this independent review against repository evidence and validation results.' }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Advisor · ' + verdict.summary },
  })
}

/** Open obligations, stated as a reminder rather than as a block. */
function obligationMessage(items: readonly Obligation[]): UserMessage {
  const lines = items.map(item => {
    const closure = item.validationKey
      ? 'a later pass of the same command in this scope with no related change since'
      : 'this failure carries no validation identity, so it cannot be closed automatically'
    const options = item.kind === 'claim-contradicted'
      ? 'A) ask the Advisor with the claim and the counterexample; B) back it with a verification witness; C) record a correction naming document, claim and change.'
      : 'A) ask the Advisor with the evidence; B) fix it and re-run the same command; C) record not-applicable or accept-risk with a checkable basis.'
    return '- ' + item.id + ' [' + item.kind + ', seen ' + item.repeatCount + 'x' + (item.disposition ? ', disposition=' + item.disposition.kind : '') + '] ' + item.summary + '\n  Closes only through: ' + closure + '.\n  ' + options
  })
  return createUserMessage({
    content: [{ type: 'text', text: '[Advisor obligations - open verification items. No score reset, cooldown or consultation budget clears these.]\n' + lines.join('\n') + '\n\nThis is a reminder, not a block. An explanation of why a failure happened is not a verification witness and does not close an item.' }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'Advisor - ' + items.length + ' open obligation(s)' },
  })
}
function unavailable(message: string) { return { status: 'unavailable' as const, severity: 'none' as const, summary: 'Advisor unavailable', diagnosis: redactSecrets(message), next_actions: [], confidence: 0, child_session_id: '', disposition: 'unavailable', evidence_used: [], assumptions: [], recommended_next_action: '', validation_plan: [], needs_more_evidence: true, changes_made: [] } }
function toolAnswer(answer: AdvisorRunResult) {
  const verdict = answer.verdict
  return { status: 'ok' as const, severity: verdict.severity, summary: verdict.summary, diagnosis: verdict.diagnosis, next_actions: verdict.nextActions, confidence: verdict.confidence ?? 0, child_session_id: answer.childSessionId,
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
  const dispatchSeq = new Map<string, { seq: number; taskStartSeq: number }>()
  const limiter = new AdvisorTaskLimiter()
  const workspace = new AdvisorWorkspaceLock()
  const registry = new AdvisorRegistry(ctx)
  const manualCalls = new Map<string, number>()
  const manualReserved = new Map<string, number>()
  const revisions = new Map<string, number>()
  const hiddenTools = new Map<Agent, () => void>()
  const inFlight = new Set<string>()
  const suppressed = new Set<string>()
  const retryableStarts = new Map<string, { failures: number; after: number }>()
  const taskStarts = new Map<string, number>()
  const reviewed = new Map<string, { turn: number; seq: number }>()
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
  const revisionOf = (agent: Agent): string => {
    const root = taskRootAgent(ctx, agent)
    const latestUser = (subject: Agent) => subject.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')?.seq ?? 0
    return [String(root.id), revisions.get(String(root.id)) ?? 0, latestUser(root), revisions.get(String(agent.id)) ?? 0, latestUser(agent)].join(':')
  }
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
    return assembly
  })

  const consult = async (agent: Agent, mode: ConsultationMode, trigger: ReviewTrigger, args: AskAdvisorArgs, signal: AbortSignal, revision: string, onStarted?: () => void) => {
    const root = taskRootAgent(ctx, agent), id = randomUUID()
    const config = configFor(agent)
    const sinceSeq = mode === 'continuous' ? reviewed.get(String(agent.id))?.seq : undefined
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
      const runRecord: AdvisorRunRecord = {
        version: 1, id, requesterId: String(agent.id), mode, turn: trigger.turn, ...(trigger.step === undefined ? {} : { step: trigger.step }),
        taskRevision: revision, ...(trigger.decision ? { fingerprint: trigger.decision.problemFingerprint, score: trigger.decision.score } : {}),
        attempt, status: 'reserved', timestamp: new Date().toISOString(), question: redactSecrets(args.question),
      }
      const record = (patch: Partial<AdvisorRunRecord>) => { Object.assign(runRecord, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), { timestamp: new Date().toISOString() }); recordRun(agent, root, runRecord) }
      record({})
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
              requester: agent, root, mode, question: args.question, consultationId: id,
              currentHypothesis: args.current_hypothesis, decisionNeeded: args.decision_needed,
              evidence: [...args.evidence ?? [], ...args.context ? [args.context] : []],
              failedAttempts: [...args.failed_attempts ?? [], ...args.attempts ? [args.attempts] : []],
              ...(trigger.decision ? { trigger: { ...trigger.decision, turn: trigger.turn, ...(trigger.step === undefined ? {} : { step: trigger.step }) } } : {}),
              ...surface, mutationPolicy: exclusive ? 'may-edit' : 'propose-only', sinceSeq,
              observedEvidence: tracker.evidence(String(agent.id)),
              taskStartSeq: taskStarts.get(String(agent.id)),
            })
            if (mode === 'continuous' && !packet.meaningful) return undefined
            const answer = await callAdvisor(ctx, config, agent, packet.prompt, attemptSignal, policy, 'Advisor · ' + mode + ' · turn ' + trigger.turn, {
              registry, root, collector: verdicts, consultationId: id, onStarted: () => { markStarted(); onStarted?.(); record({ status: 'started' }) },
              onPublished: childSessionId => record({ childSessionId }),
            })
            return { answer, lastSeq: packet.lastSeq }
          })
        })
        if (!result) { record({ status: 'skipped' }); return undefined }
        if (!fresh(agent, revision)) { record({ status: 'stale', childSessionId: result.answer.childSessionId, usage: result.answer.usage, summary: result.answer.verdict.summary, severity: result.answer.verdict.severity }); return undefined }
        record({ status: 'delivered', childSessionId: result.answer.childSessionId, summary: result.answer.verdict.summary, severity: result.answer.verdict.severity, usage: result.answer.usage, verdictTool: ADVISOR_VERDICT_TOOL,
          responseText: mode === 'manual' ? JSON.stringify(toolAnswer(result.answer), null, 2) : textContent(adviceMessage(result.answer.verdict, mode, result.answer.childSessionId).content) })
        if (mode === 'continuous') reviewed.set(String(agent.id), { turn: trigger.turn, seq: result.lastSeq })
        return result.answer
      } catch (error) {
        const message = truncateUtf8(redactSecrets(error instanceof Error ? error.message : String(error)), 1500)
        const cancelled = signal.aborted || error instanceof AdvisorUnavailableError && error.code === 'cancelled'
        const stale = !fresh(agent, revision) || error instanceof AdvisorUnavailableError && error.code === 'stale'
        const retryableStart = runRecord.status !== 'started' && (error instanceof AdvisorUnavailableError && ['child_start_failed', 'child_failed', 'retryable_start'].includes(error.code) || error instanceof AdvisorTaskLimitError && error.code === 'task_budget_reserved')
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
    description: 'Ask a stronger model for an independent engineering review in a visible child session. Supply the question, hypothesis, evidence and failed attempts; the harness supplies the task.',
    parameters: {
      question: { type: 'string', required: true }, goal: { type: 'string' }, current_hypothesis: { type: 'string' }, decision_needed: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } }, failed_attempts: { type: 'array', items: { type: 'string' } }, attempts: { type: 'string' }, context: { type: 'string' },
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
        confidence: { type: 'number', required: true }, child_session_id: { type: 'string', required: true },
      } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContext) {
      if (!exec.agent || !manualEnabled(exec.agent)) return unavailable('Advisor is not configured or enabled for this agent.')
      const agent = exec.agent, key = String(agent.id), config = currentConfig()
      if ((manualCalls.get(key) ?? 0) + (manualReserved.get(key) ?? 0) >= config.maxManualConsultsPerSession) return unavailable('Manual Advisor consultation budget reached.')
      manualReserved.set(key, (manualReserved.get(key) ?? 0) + 1)
      let started = false
      try {
        const ending = agent.session.snapshotEvents().findLast(event => event.type === 'step/start')
        const answer = await consult(agent, 'manual', { turn: ending?.type === 'step/start' ? ending.data.turn : 0 }, raw as AskAdvisorArgs, AbortSignal.any([exec.signal, disposed.signal]), revisionOf(agent), () => {
          if (!started) { started = true; manualCalls.set(key, (manualCalls.get(key) ?? 0) + 1) }
        })
        return answer ? toolAnswer(answer) : unavailable('Advisor result expired after the task changed.')
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
        const claimId = text('claim_id'), summary = text('summary')
        if (!claimId || !summary) return { action, message: 'register requires claim_id and summary.', obligations: listed() }
        const item = obligations.recordClaimContradiction({ sessionId: key, taskStartSeq, scope, seq, at: Date.now(), claimId, summary: redactSecrets(summary).slice(0, 300) })
        return { action, message: 'Registered ' + item.id + '. It stays open until a verification witness and a correction record both exist.', obligations: listed() }
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
        const item = obligations.recordCorrection(key, taskStartSeq, id, { claimId, document: redactSecrets(document).slice(0, 200), change: redactSecrets(change).slice(0, 300), evidence: redactSecrets(evidence).slice(0, 300), at: Date.now(), seq })
        return { action, message: item ? 'Recorded the correction on ' + item.id + '. A correction alone does not close it; a verification witness must still follow the failure.' : 'No such obligation, or the claim id does not match.', obligations: listed() }
      }
      return { action, message: 'Unknown action. Use list, register, disposition or correct.', obligations: listed() }
    },
  }))

  for (const agent of ctx.agents.list()) refreshTool(agent)
  ctx.on('agent/created', ({ agent }) => refreshTool(agent))
  ctx.on('settings/updated', namespace => { if (namespace === SETTINGS_NAMESPACE) { suppressed.clear(); retryableStarts.clear(); for (const agent of ctx.agents.list()) refreshTool(agent) } })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user' || registry.identity(agent)) return
    const key = String(agent.id)
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
    tracker.clear(key)
    taskStarts.set(key, agent.session.seq)
    for (const pending of retryableStarts.keys()) if (pending.startsWith(key + '|')) retryableStarts.delete(pending)
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent) {
      const agentKey = String(exec.agent.id)
      dispatchSeq.set(String(exec.callId), { seq: exec.agent.session.seq, taskStartSeq: taskStarts.get(agentKey) ?? 0 })
      // Expire by sequence distance so in-flight calls keep their start boundary.
      const oldest = exec.agent.session.seq - 512
      for (const [id, entry] of dispatchSeq) if (entry.seq < oldest) dispatchSeq.delete(id)
    }
    return await next()
  })

  ctx.on('tools/result', (exec, result: Readonly<ToolExecutionResult>) => {
    if (!exec.agent || exec.name === ADVISOR_TOOL_NAME || roleOf(exec.agent) === 'advisor') return
    const config = configFor(exec.agent)
    if (!routeConfigured(config)) return
    const agentKey = String(exec.agent.id), callId = String(exec.callId)
    // Task identity is captured at dispatch so a task change mid-call cannot
    // re-attribute the run.
    const dispatched = dispatchSeq.get(callId)
    dispatchSeq.delete(callId)
    const taskStartSeq = dispatched?.taskStartSeq ?? taskStarts.get(agentKey) ?? 0
    const scope = 'task:' + agentKey + ':' + taskStartSeq
    const observed = {
      callId, name: exec.name, arguments: exec.arguments, isError: result.isError, scope,
      ...(result.isError ? { errorMessage: result.error.message, errorCode: result.error.info?.code } : { value: result.value }), contentText: textContent(result.content),
    }
    const startedSeq = dispatched?.seq
    const completedSeq = exec.agent.session.seq
    tracker.observe(agentKey, observed, config)
    if (mutationKey(exec.name, exec.arguments)) obligations.recordMutation({ sessionId: agentKey, taskStartSeq, scope, seq: completedSeq, applied: !result.isError })
    if (roleOf(exec.agent) !== 'root') return
    const outcome = classifyToolOutcome(observed)
    if (opensObligation(outcome.class)) {
      obligations.recordFailure({
        sessionId: agentKey, taskStartSeq, scope, seq: completedSeq, at: Date.now(), callId,
        ...(outcome.validationKey ? { validationKey: outcome.validationKey } : {}),
        summary: redactSecrets((result.isError ? result.error.message : observed.contentText) || exec.name).slice(0, 300),
      })
    } else if (outcome.class === 'success' && outcome.validationKey && outcome.exitCode === 0) {
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
        const message = adviceMessage(verdict, mode, answer.childSessionId)
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
    if (!identity && request.messages.some(message => message.source.kind === 'user')) {
      tracker.clear(String(request.agent.id))
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
    const obligationNote = due.length ? obligationMessage(due) : undefined
    return advice || notes.length || obligationNote ? { ...nextStep, messages: [...nextStep.messages, ...notes, ...(obligationNote ? [obligationNote] : []), ...(advice ? [advice] : [])] } : nextStep
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
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
    agent.steer(obligationMessage(open))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    tracker.clear(key); manualCalls.delete(key); manualReserved.delete(key); revisions.delete(key); reviewed.delete(key); futureNotes.delete(key); taskStarts.delete(key); obligations.clear(key)
    for (const pending of retryableStarts.keys()) if (pending.startsWith(key + '|')) retryableStarts.delete(pending)
    hiddenTools.get(agent)?.(); hiddenTools.delete(agent)
    for (const controller of controllers.get(key) ?? []) controller.abort()
    controllers.delete(key)
    if (agent.session.header.parentSession === undefined) { limiter.clear(key); registry.clearRoot(key) }
  })
}
