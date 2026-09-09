import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, routeConfigured, severityRank, type AdvisorSeverity, type Config as AdvisorConfig } from './config.js'
import { recentSessionContext, textContent } from './context.js'
import { callAdvisor, AdvisorUnavailableError } from './model-runner.js'
import { continuousPrompt, escalationPrompt, manualPrompt, toolGuidance } from './prompts.js'
import { EscalationTracker } from './state.js'
import type { AdvisorVerdict } from './verdict.js'

export const name = 'dsh-escalation-advisor'
export const inject = ['tools', 'llm', 'settings', 'systemPrompt']
export { ConfigSchema as Config }
export type PluginConfig = AdvisorConfig
export const SETTINGS_NAMESPACE = 'escalation-advisor'
export const ADVISOR_TOOL_NAME = 'consult_advisor'

interface AskAdvisorArgs { goal: string; question: string; attempts?: string; context?: string }
interface AdvisorToolResult { status: 'ok' | 'unavailable' | 'error'; severity: AdvisorSeverity; summary: string; diagnosis: string; next_actions: string[]; confidence: number }
function advisorToolResult(verdict: AdvisorVerdict): AdvisorToolResult { return { status: 'ok', severity: verdict.severity, summary: verdict.summary, diagnosis: verdict.diagnosis, next_actions: verdict.nextActions, confidence: verdict.confidence ?? 0 } }
function unavailable(message: string): AdvisorToolResult { return { status: 'unavailable', severity: 'none', summary: 'Advisor unavailable', diagnosis: message, next_actions: [], confidence: 0 } }
function adviceMessage(verdict: AdvisorVerdict, origin: 'automatic escalation' | 'continuous review'): string {
  const actions = verdict.nextActions.length ? `\nRecommended next actions:\n${verdict.nextActions.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : ''
  return `[Strong advisor — ${origin}; severity=${verdict.severity}]\n${verdict.summary}\n\n${verdict.diagnosis}${actions}\n\nTreat this as an independent review, not ground truth. Verify it against repository evidence and tool results before making irreversible changes.`
}
function isRootAgent(agent: { session: { header: { parentSession?: unknown } } }): boolean { return agent.session.header.parentSession === undefined }

export function apply(ctx: Context, entryConfig: AdvisorConfig): void {
  const logger = ctx.logger(name)
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, ConfigSchema, { base: entryConfig })
  const currentConfig = (): AdvisorConfig => settings.get()
  const tracker = new EscalationTracker()
  const manualCalls = new Map<string, number>()

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
    description: 'Ask a stronger configured DSH model for an independent engineering second opinion. Use for genuine uncertainty, conflicting evidence, repeated failures, or high-impact decisions; not routine work.',
    parameters: { goal: { type: 'string', required: true }, question: { type: 'string', required: true }, attempts: { type: 'string' }, context: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true, enum: ['ok', 'unavailable', 'error'] }, severity: { type: 'string', required: true, enum: ['none', 'nit', 'concern', 'blocker'] }, summary: { type: 'string', required: true }, diagnosis: { type: 'string', required: true }, next_actions: { type: 'array', required: true, items: { type: 'string' } }, confidence: { type: 'number', required: true } } },
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
        return advisorToolResult(await callAdvisor(ctx, config, manualPrompt({ goal: args.goal, question: args.question, attempts: args.attempts ?? '', context: args.context ?? '', transcript }), exec.signal))
      } catch (error) { const message = error instanceof Error ? error.message : String(error); logger.warn(`manual advisor call failed: ${message}`); return unavailable(message) }
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
    if (config.mode === 'continuous') {
      if (!tracker.markContinuousReview(agent.session.id, turn)) return
      try {
        const verdict = await callAdvisor(ctx, config, continuousPrompt(recentSessionContext(agent, config.maxInputBytes)), signal)
        if (verdict.severity === 'none') return
        if (severityRank(verdict.severity) < severityRank(config.continuousMinSeverity)) {
          if (config.injectNits) agent.inject(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review') }], source: { kind: 'plugin', plugin: name } }))
          return
        }
        agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review') }], source: { kind: 'plugin', plugin: name } }))
      } catch (error) { logger.warn(`continuous advisor review failed: ${error instanceof Error ? error.message : String(error)}`) }
      return
    }

    const decision = tracker.decision(agent.session.id, turn, config)
    if (!decision.shouldConsult) return
    // Claim before sending. If the transport fails after request dispatch, automatically
    // retrying the same fingerprint could duplicate strong-model cost with ambiguous delivery.
    tracker.markAutoConsult(agent.session.id, turn, decision.problemFingerprint)
    try {
      const verdict = await callAdvisor(ctx, config, escalationPrompt(decision.score, decision.signals, recentSessionContext(agent, config.maxInputBytes)), signal)
      tracker.noteProgress(agent.session.id)
      if (verdict.severity !== 'none') agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'automatic escalation') }], source: { kind: 'plugin', plugin: name } }))
    } catch (error) { const message = error instanceof AdvisorUnavailableError ? error.message : error instanceof Error ? error.message : String(error); logger.warn(`automatic advisor escalation failed: ${message}`) }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    tracker.clear(agent.session.id)
    manualCalls.delete(agent.session.id)
  })
}
