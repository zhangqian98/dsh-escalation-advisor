import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, routeConfigured, severityRank, type AdvisorSeverity, type Config as AdvisorConfig } from './config.js'
import { coverageEnabled, type AdvisorAgentRole } from './coverage.js'
import { recentSessionContext, textContent } from './context.js'
import { callAdvisor, AdvisorUnavailableError } from './model-runner.js'
import { effectiveAdvisorPolicy, installAdvisorPolicyCommand } from './policy.js'
import { continuousPrompt, escalationPrompt, manualPrompt, toolGuidance } from './prompts.js'
import { EscalationTracker } from './state.js'
import { AdvisorTaskLimiter } from './task-limiter.js'
import type { AdvisorVerdict } from './verdict.js'

export const name = 'dsh-escalation-advisor'
export const inject = ['tools', 'settings', 'systemPrompt', 'agents']
export { ConfigSchema as Config }
export type PluginConfig = AdvisorConfig
export const SETTINGS_NAMESPACE = 'escalation-advisor'
export const ADVISOR_TOOL_NAME = 'consult_advisor'
const ADVISOR_LABEL_PREFIX = 'Advisor · '
const ADVISOR_INTERNAL_TOOLS = new Set(['structured_output', 'run_code'])

interface AskAdvisorArgs { goal: string; question: string; attempts?: string; context?: string }
interface AdvisorToolResult { status: 'ok' | 'unavailable' | 'error'; severity: AdvisorSeverity; summary: string; diagnosis: string; next_actions: string[]; confidence: number; child_session_id: string }
function advisorToolResult(verdict: AdvisorVerdict, childSessionId: string): AdvisorToolResult { return { status: 'ok', severity: verdict.severity, summary: verdict.summary, diagnosis: verdict.diagnosis, next_actions: verdict.nextActions, confidence: verdict.confidence ?? 0, child_session_id: childSessionId } }
function unavailable(message: string): AdvisorToolResult { return { status: 'unavailable', severity: 'none', summary: 'Advisor unavailable', diagnosis: message, next_actions: [], confidence: 0, child_session_id: '' } }
function adviceMessage(verdict: AdvisorVerdict, origin: 'automatic escalation' | 'continuous review', childSessionId: string): string {
  const actions = verdict.nextActions.length ? `\nRecommended next actions:\n${verdict.nextActions.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : ''
  return `[Strong advisor — ${origin}; severity=${verdict.severity}; child=${childSessionId}]\n${verdict.summary}\n\n${verdict.diagnosis}${actions}\n\nTreat this as an independent review, not ground truth. Verify it against repository evidence and tool results before making irreversible changes.`
}

function isAdvisorAgent(agent: Agent): boolean {
  if (agent.session.header.parentSession === undefined) return false
  return agent.session.snapshotEvents().some(event =>
    event.type === 'subagent/descriptor'
    && event.data.mode === 'one-shot'
    && event.data.label?.startsWith(ADVISOR_LABEL_PREFIX) === true)
}

function agentRole(agent: Agent): AdvisorAgentRole {
  if (isAdvisorAgent(agent)) return 'advisor'
  return agent.session.header.parentSession === undefined ? 'root' : 'local-subagent'
}

/** Walk the live DSH parent chain. Active local subagents normally retain their parent. */
function taskRootAgent(ctx: Context, agent: Agent): Agent {
  let current = agent
  const seen = new Set<string>()
  while (current.session.header.parentSession !== undefined) {
    const key = String(current.id)
    if (seen.has(key)) break
    seen.add(key)
    const parent = ctx.agents.get(current.session.header.parentSession)
    if (!parent) break
    current = parent
  }
  return current
}

function advisorChildParent(ctx: Context, agent: Agent): { advisor: false } | { advisor: true; parent?: Agent } {
  if (!isAdvisorAgent(agent)) return { advisor: false }
  const parentId = agent.session.header.parentSession
  if (parentId === undefined) return { advisor: true }
  const parent = ctx.agents.get(parentId)
  return parent === undefined ? { advisor: true } : { advisor: true, parent }
}

export function apply(ctx: Context, entryConfig: AdvisorConfig): void {
  const logger = ctx.logger(name)
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, { base: entryConfig })
  const currentConfig = (): AdvisorConfig => settings.get()
  const tracker = new EscalationTracker()
  const limiter = new AdvisorTaskLimiter()
  const manualCalls = new Map<string, number>()
  const backgroundControllers = new Map<string, Set<AbortController>>()
  const disposed = new AbortController()
  ctx.effect(() => () => disposed.abort(), 'advisor: abort background work on unload')
  installAdvisorPolicyCommand(ctx, currentConfig)

  const trackBackground = (sessionId: string, controller: AbortController): (() => void) => {
    let set = backgroundControllers.get(sessionId)
    if (!set) { set = new Set(); backgroundControllers.set(sessionId, set) }
    set.add(controller)
    return () => { set!.delete(controller); if (set!.size === 0) backgroundControllers.delete(sessionId) }
  }
  const launchBackground = (agent: Agent, task: (signal: AbortSignal) => Promise<void>): void => {
    const controller = new AbortController()
    const release = trackBackground(String(agent.session.id), controller)
    const signal = AbortSignal.any([controller.signal, disposed.signal])
    void task(signal)
      .catch(error => logger.warn(`background advisor failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(release)
  }
  const runAdvisor = async (
    requester: Agent,
    prompt: string,
    signal: AbortSignal,
    label: string,
  ) => {
    const config = currentConfig()
    const root = taskRootAgent(ctx, requester)
    const policy = effectiveAdvisorPolicy(config, root.session)
    return limiter.run(
      String(root.id),
      { maxTotal: config.maxAdvisorConsultsPerTask, maxConcurrent: config.maxConcurrentAdvisorRuns },
      signal,
      () => callAdvisor(ctx, config, requester, prompt, signal, policy, label),
    )
  }

  // ToolRestriction masks inherited/global tools. This guard also closes any
  // child-scoped surface: an Advisor may call only root-policy tools that are
  // actually visible to the agent that requested the consultation, plus DSH's
  // structured result tool and the reserved PTC transport.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next()
    const owner = advisorChildParent(ctx, exec.agent)
    if (!owner.advisor) return next()
    if (ADVISOR_INTERNAL_TOOLS.has(exec.name)) return next()
    if (!owner.parent) return { kind: 'deny', reason: 'Advisor requesting agent is no longer live; external tools are disabled.' }
    const root = taskRootAgent(ctx, owner.parent)
    const allowed = new Set(effectiveAdvisorPolicy(currentConfig(), root.session).allowedTools)
    const requesterVisible = new Set(ctx.tools.schemas(owner.parent).map(tool => tool.name))
    if (allowed.has(exec.name) && requesterVisible.has(exec.name)) return next()
    return { kind: 'deny', reason: `Advisor tool "${exec.name}" is not allowed by the root task policy and requesting agent tool surface.` }
  })

  ctx.systemPrompt.section({
    name: 'escalation-advisor-guidance',
    order: 2860,
    text: () => {
      const config = currentConfig()
      if (!config.enabled) return ''
      return routeConfigured(config)
        ? toolGuidance(config.mode)
        : '## Strong advisor\nThe advisor plugin is enabled but no advisor provider/model is configured. Do not call `consult_advisor` until the user selects an existing DSH model for the plugin.'
    },
  })

  ctx.tools.register(defineTool({
    name: ADVISOR_TOOL_NAME,
    description: 'Ask a stronger configured DSH model for an independent engineering second opinion. Root agents and enabled local DSH subagents can use it; the Advisor runs as a visible child of the exact requester and cannot expand that requester\'s tool authority.',
    parameters: { goal: { type: 'string', required: true }, question: { type: 'string', required: true }, attempts: { type: 'string' }, context: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true, enum: ['ok', 'unavailable', 'error'] }, severity: { type: 'string', required: true, enum: ['none', 'nit', 'concern', 'blocker'] }, summary: { type: 'string', required: true }, diagnosis: { type: 'string', required: true }, next_actions: { type: 'array', required: true, items: { type: 'string' } }, confidence: { type: 'number', required: true }, child_session_id: { type: 'string', required: true } } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContext) {
      const config = currentConfig()
      const args = raw as AskAdvisorArgs
      if (!config.enabled) return unavailable('dsh-escalation-advisor is disabled in DSH settings.')
      if (!exec.agent) return unavailable('consult_advisor requires a live DSH agent.')
      const role = agentRole(exec.agent)
      if (!coverageEnabled(config, 'manual', role)) {
        return unavailable(role === 'advisor' ? 'Advisor agents cannot recursively consult another Advisor.' : 'Manual Advisor consultation is disabled for this agent role.')
      }
      if (!routeConfigured(config)) return unavailable('Configure provider and model for dsh-escalation-advisor. The plugin reuses DSH model authentication; it does not store a separate API key.')
      const sessionId = String(exec.agent.session.id)
      const count = manualCalls.get(sessionId) ?? 0
      if (count >= config.maxManualConsultsPerSession) return unavailable(`Manual advisor budget reached (${config.maxManualConsultsPerSession} calls for this agent).`)
      manualCalls.set(sessionId, count + 1)
      try {
        const transcript = recentSessionContext(exec.agent, Math.floor(config.maxInputBytes * 0.65))
        const answer = await runAdvisor(exec.agent, manualPrompt({ goal: args.goal, question: args.question, attempts: args.attempts ?? '', context: args.context ?? '', transcript }), exec.signal, 'Advisor · manual')
        return advisorToolResult(answer.verdict, answer.childSessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`manual advisor call failed: ${message}`)
        return unavailable(message)
      }
    },
  }))

  ctx.on('tools/result', (exec, result: Readonly<ToolExecutionResult>) => {
    const config = currentConfig()
    if (!config.enabled || config.mode !== 'escalate' || !exec.agent || exec.name === ADVISOR_TOOL_NAME) return
    const role = agentRole(exec.agent)
    if (!coverageEnabled(config, 'escalation', role)) return
    tracker.observe(String(exec.agent.session.id), { name: exec.name, arguments: exec.arguments, isError: result.isError, ...(result.isError ? { errorMessage: result.error.message, errorCode: result.error.info?.code } : { value: result.value }), contentText: textContent(result.content) }, config)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const config = currentConfig()
    if (!config.enabled || !routeConfigured(config) || config.mode === 'manual') return
    const role = agentRole(agent)
    const root = taskRootAgent(ctx, agent)
    const policy = effectiveAdvisorPolicy(config, root.session)

    if (config.mode === 'continuous') {
      if (!coverageEnabled(config, 'continuous', role)) return
      if (!tracker.markContinuousReview(String(agent.session.id), turn)) return
      const review = async (runSignal: AbortSignal): Promise<void> => {
        const answer = await runAdvisor(agent, continuousPrompt(recentSessionContext(agent, config.maxInputBytes)), runSignal, `Advisor · continuous · turn ${turn}`)
        const verdict = answer.verdict
        if (verdict.severity === 'none' || ctx.agents.get(agent.id) !== agent) return
        if (severityRank(verdict.severity) < severityRank(config.continuousMinSeverity)) {
          // A low-severity note is useful as future context for a persistent root,
          // but an ephemeral local child may be about to settle and never read it.
          if (config.injectNits && role === 'root') agent.inject(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review', answer.childSessionId) }], source: { kind: 'plugin', plugin: name } }))
          return
        }
        // Advice returns only to the agent whose turn triggered the review.
        agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review', answer.childSessionId) }], source: { kind: 'plugin', plugin: name } }))
      }
      // Local subagents must wait so they cannot settle before their review does.
      const wait = role === 'root' ? policy.continuousWait : 'block'
      if (wait === 'background') launchBackground(agent, review)
      else {
        try { await review(signal) }
        catch (error) { logger.warn(`continuous advisor review failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
      return
    }

    if (!coverageEnabled(config, 'escalation', role)) return
    const decision = tracker.decision(String(agent.session.id), turn, config)
    if (!decision.shouldConsult) return
    tracker.markAutoConsult(String(agent.session.id), turn, decision.problemFingerprint)
    const review = async (runSignal: AbortSignal): Promise<void> => {
      const answer = await runAdvisor(agent, escalationPrompt(decision.score, decision.signals, recentSessionContext(agent, config.maxInputBytes)), runSignal, `Advisor · escalation · turn ${turn}`)
      tracker.noteProgress(String(agent.session.id))
      // Advice returns only to the stuck requester; it never jumps directly to root.
      if (answer.verdict.severity !== 'none' && ctx.agents.get(agent.id) === agent) agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(answer.verdict, 'automatic escalation', answer.childSessionId) }], source: { kind: 'plugin', plugin: name } }))
    }
    // Local subagents must wait so a one-shot worker cannot return stale work first.
    const wait = role === 'root' ? policy.escalationWait : 'block'
    if (wait === 'background') launchBackground(agent, review)
    else {
      try { await review(signal) }
      catch (error) {
        const message = error instanceof AdvisorUnavailableError ? error.message : error instanceof Error ? error.message : String(error)
        logger.warn(`automatic advisor escalation failed: ${message}`)
      }
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = String(agent.session.id)
    tracker.clear(sessionId)
    manualCalls.delete(sessionId)
    const controllers = backgroundControllers.get(sessionId)
    if (controllers) for (const controller of controllers) controller.abort(new Error('requesting agent disposed'))
    backgroundControllers.delete(sessionId)
    if (agent.session.header.parentSession === undefined) limiter.clear(String(agent.id))
  })
}
