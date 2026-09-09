import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, routeConfigured, severityRank, type AdvisorSeverity, type Config as AdvisorConfig } from './config.js'
import { recentSessionContext, textContent } from './context.js'
import { callAdvisor, AdvisorUnavailableError } from './model-runner.js'
import { effectiveAdvisorPolicy, installAdvisorPolicyCommand } from './policy.js'
import { continuousPrompt, escalationPrompt, manualPrompt, toolGuidance } from './prompts.js'
import { EscalationTracker } from './state.js'
import type { AdvisorVerdict } from './verdict.js'

export const name = 'dsh-escalation-advisor'
export const inject = ['tools', 'settings', 'systemPrompt', 'agents']
export { ConfigSchema as Config }
export type PluginConfig = AdvisorConfig
export const SETTINGS_NAMESPACE = 'escalation-advisor'
export const ADVISOR_TOOL_NAME = 'consult_advisor'

interface AskAdvisorArgs { goal: string; question: string; attempts?: string; context?: string }
interface AdvisorToolResult { status: 'ok' | 'unavailable' | 'error'; severity: AdvisorSeverity; summary: string; diagnosis: string; next_actions: string[]; confidence: number; child_session_id: string }
function advisorToolResult(verdict: AdvisorVerdict, childSessionId: string): AdvisorToolResult { return { status: 'ok', severity: verdict.severity, summary: verdict.summary, diagnosis: verdict.diagnosis, next_actions: verdict.nextActions, confidence: verdict.confidence ?? 0, child_session_id: childSessionId } }
function unavailable(message: string): AdvisorToolResult { return { status: 'unavailable', severity: 'none', summary: 'Advisor unavailable', diagnosis: message, next_actions: [], confidence: 0, child_session_id: '' } }
function adviceMessage(verdict: AdvisorVerdict, origin: 'automatic escalation' | 'continuous review', childSessionId: string): string {
  const actions = verdict.nextActions.length ? `\nRecommended next actions:\n${verdict.nextActions.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : ''
  return `[Strong advisor — ${origin}; severity=${verdict.severity}; child=${childSessionId}]\n${verdict.summary}\n\n${verdict.diagnosis}${actions}\n\nTreat this as an independent review, not ground truth. Verify it against repository evidence and tool results before making irreversible changes.`
}
function isRootAgent(agent: Agent): boolean { return agent.session.header.parentSession === undefined }

export function apply(ctx: Context, entryConfig: AdvisorConfig): void {
  const logger = ctx.logger(name)
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, { base: entryConfig })
  const currentConfig = (): AdvisorConfig => settings.get()
  const tracker = new EscalationTracker()
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
    const release = trackBackground(agent.session.id, controller)
    const signal = AbortSignal.any([controller.signal, disposed.signal])
    void task(signal)
      .catch(error => logger.warn(`background advisor failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(release)
  }

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
    description: 'Ask a stronger configured DSH model for an independent engineering second opinion. The advisor runs in a visible child session and may use only tools allowed by the user for this parent session.',
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
      if (!exec.agent || !isRootAgent(exec.agent)) return unavailable('consult_advisor is limited to the root DSH task in this version.')
      if (!routeConfigured(config)) return unavailable('Configure provider and model for dsh-escalation-advisor. The plugin reuses DSH model authentication; it does not store a separate API key.')
      const sessionId = exec.agent.session.id
      const count = manualCalls.get(sessionId) ?? 0
      if (count >= config.maxManualConsultsPerSession) return unavailable(`Manual advisor budget reached (${config.maxManualConsultsPerSession} calls for this session).`)
      manualCalls.set(sessionId, count + 1)
      try {
        const transcript = recentSessionContext(exec.agent, Math.floor(config.maxInputBytes * 0.65))
        const policy = effectiveAdvisorPolicy(config, exec.agent.session)
        const answer = await callAdvisor(ctx, config, exec.agent, manualPrompt({ goal: args.goal, question: args.question, attempts: args.attempts ?? '', context: args.context ?? '', transcript }), exec.signal, policy, 'Advisor · manual')
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
    if (!config.enabled || config.mode !== 'escalate' || !exec.agent || !isRootAgent(exec.agent) || exec.name === ADVISOR_TOOL_NAME) return
    tracker.observe(exec.agent.session.id, { name: exec.name, arguments: exec.arguments, isError: result.isError, ...(result.isError ? { errorMessage: result.error.message, errorCode: result.error.info?.code } : { value: result.value }), contentText: textContent(result.content) }, config)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const config = currentConfig()
    if (!config.enabled || !isRootAgent(agent) || !routeConfigured(config) || config.mode === 'manual') return
    const policy = effectiveAdvisorPolicy(config, agent.session)

    if (config.mode === 'continuous') {
      if (!tracker.markContinuousReview(agent.session.id, turn)) return
      const review = async (runSignal: AbortSignal): Promise<void> => {
        const answer = await callAdvisor(ctx, config, agent, continuousPrompt(recentSessionContext(agent, config.maxInputBytes)), runSignal, policy, `Advisor · continuous · turn ${turn}`)
        const verdict = answer.verdict
        if (verdict.severity === 'none' || ctx.agents.get(agent.id) !== agent) return
        if (severityRank(verdict.severity) < severityRank(config.continuousMinSeverity)) {
          if (config.injectNits) agent.inject(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review', answer.childSessionId) }], source: { kind: 'plugin', plugin: name } }))
          return
        }
        agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review', answer.childSessionId) }], source: { kind: 'plugin', plugin: name } }))
      }
      if (policy.continuousWait === 'background') launchBackground(agent, review)
      else {
        try { await review(signal) }
        catch (error) { logger.warn(`continuous advisor review failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
      return
    }

    const decision = tracker.decision(agent.session.id, turn, config)
    if (!decision.shouldConsult) return
    tracker.markAutoConsult(agent.session.id, turn, decision.problemFingerprint)
    const review = async (runSignal: AbortSignal): Promise<void> => {
      const answer = await callAdvisor(ctx, config, agent, escalationPrompt(decision.score, decision.signals, recentSessionContext(agent, config.maxInputBytes)), runSignal, policy, `Advisor · escalation · turn ${turn}`)
      tracker.noteProgress(agent.session.id)
      if (answer.verdict.severity !== 'none' && ctx.agents.get(agent.id) === agent) agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(answer.verdict, 'automatic escalation', answer.childSessionId) }], source: { kind: 'plugin', plugin: name } }))
    }
    if (policy.escalationWait === 'background') launchBackground(agent, review)
    else {
      try { await review(signal) }
      catch (error) {
        const message = error instanceof AdvisorUnavailableError ? error.message : error instanceof Error ? error.message : String(error)
        logger.warn(`automatic advisor escalation failed: ${message}`)
      }
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    tracker.clear(agent.session.id)
    manualCalls.delete(agent.session.id)
    const controllers = backgroundControllers.get(agent.session.id)
    if (controllers) for (const controller of controllers) controller.abort(new Error('parent agent disposed'))
    backgroundControllers.delete(agent.session.id)
  })
}
