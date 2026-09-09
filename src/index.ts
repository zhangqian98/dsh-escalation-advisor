import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config as ConfigSchema, routeConfigured, severityRank, type AdvisorSeverity, type Config as AdvisorConfig } from './config.js'
import { recentSessionContext, textContent } from './context.js'
import { callAdvisor, AdvisorUnavailableError } from './model-runner.js'
import { continuousPrompt, escalationPrompt, manualPrompt, toolGuidance } from './prompts.js'
import { EscalationTracker } from './state.js'
import type { AdvisorVerdict } from './verdict.js'

export const name = 'dsh-escalation-advisor'
export const inject = ['tools', 'llm', 'systemPrompt']
export { ConfigSchema as Config }
export type PluginConfig = AdvisorConfig

interface AskAdvisorArgs { goal: string; question: string; attempts?: string; context?: string }
interface AdvisorToolResult { status: 'ok' | 'unavailable' | 'error'; severity: AdvisorSeverity; summary: string; diagnosis: string; next_actions: string[]; confidence: number }
function advisorToolResult(verdict: AdvisorVerdict): AdvisorToolResult { return { status: 'ok', severity: verdict.severity, summary: verdict.summary, diagnosis: verdict.diagnosis, next_actions: verdict.nextActions, confidence: verdict.confidence ?? 0 } }
function unavailable(message: string): AdvisorToolResult { return { status: 'unavailable', severity: 'none', summary: 'Advisor unavailable', diagnosis: message, next_actions: [], confidence: 0 } }
function adviceMessage(verdict: AdvisorVerdict, origin: 'automatic escalation' | 'continuous review'): string {
  const actions = verdict.nextActions.length ? `\nRecommended next actions:\n${verdict.nextActions.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : ''
  return `[Strong advisor — ${origin}; severity=${verdict.severity}]\n${verdict.summary}\n\n${verdict.diagnosis}${actions}\n\nTreat this as an independent review, not ground truth. Verify it against repository evidence and tool results before making irreversible changes.`
}
function isRootAgent(agent: { session: { header: { parentSession?: unknown } } }): boolean { return agent.session.header.parentSession === undefined }

export function apply(ctx: Context, config: AdvisorConfig): void {
  if (!config.enabled) return
  const logger = ctx.logger(name), tracker = new EscalationTracker()
  ctx.systemPrompt.section({ name: 'escalation-advisor-guidance', order: 2860, text: () => routeConfigured(config) ? toolGuidance(config.mode) : '## Strong advisor\nThe advisor plugin is installed but no advisor provider/model is configured. Do not call `ask_advisor` until the user configures an existing DSH model for the plugin.' })
  ctx.tools.register(defineTool({
    name: 'ask_advisor',
    description: 'Ask a stronger configured DSH model for an independent engineering second opinion. Use for genuine uncertainty, conflicting evidence, repeated failures, or high-impact decisions; not routine work.',
    parameters: { goal: { type: 'string', required: true }, question: { type: 'string', required: true }, attempts: { type: 'string' }, context: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true, enum: ['ok', 'unavailable', 'error'] }, severity: { type: 'string', required: true, enum: ['none', 'nit', 'concern', 'blocker'] }, summary: { type: 'string', required: true }, diagnosis: { type: 'string', required: true }, next_actions: { type: 'array', required: true, items: { type: 'string' } }, confidence: { type: 'number', required: true } } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContext) {
      const args = raw as AskAdvisorArgs
      if (!exec.agent) return unavailable('ask_advisor requires an active DSH agent session.')
      if (!routeConfigured(config)) return unavailable('Configure provider and model for dsh-escalation-advisor. The plugin reuses DSH model authentication; it does not store a separate API key.')
      try {
        const transcript = recentSessionContext(exec.agent, Math.floor(config.maxInputBytes * 0.65))
        return advisorToolResult(await callAdvisor(ctx, config, manualPrompt({ goal: args.goal, question: args.question, attempts: args.attempts ?? '', context: args.context ?? '', transcript }), exec.signal))
      } catch (error) { const message = error instanceof Error ? error.message : String(error); logger.warn(`manual advisor call failed: ${message}`); return unavailable(message) }
    },
  }))
  if (config.mode === 'escalate') {
    ctx.on('tools/result', (exec, result: Readonly<ToolExecutionResult>) => {
      if (!exec.agent || !isRootAgent(exec.agent) || exec.name === 'ask_advisor') return
      tracker.observe(exec.agent.session.id, { name: exec.name, arguments: exec.arguments, isError: result.isError, ...(result.isError ? { errorMessage: result.error.message, errorCode: result.error.info?.code } : { value: result.value }), contentText: textContent(result.content) }, config)
    })
  }
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    if (!isRootAgent(agent) || !routeConfigured(config) || config.mode === 'manual') return
    if (config.mode === 'continuous') {
      if (!tracker.markContinuousReview(agent.session.id, turn)) return
      try {
        const verdict = await callAdvisor(ctx, config, continuousPrompt(recentSessionContext(agent, config.maxInputBytes)), signal)
        if (verdict.severity === 'none') return
        if (severityRank(verdict.severity) < severityRank(config.continuousMinSeverity) && config.injectNits) {
          agent.inject(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review') }], source: { kind: 'plugin', plugin: name } }))
          return
        }
        if (severityRank(verdict.severity) >= severityRank(config.continuousMinSeverity)) agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'continuous review') }], source: { kind: 'plugin', plugin: name } }))
      } catch (error) { logger.warn(`continuous advisor review failed: ${error instanceof Error ? error.message : String(error)}`) }
      return
    }
    const decision = tracker.decision(agent.session.id, turn, config)
    if (!decision.shouldConsult) return
    tracker.markAutoConsult(agent.session.id, turn, decision.problemFingerprint)
    try {
      const verdict = await callAdvisor(ctx, config, escalationPrompt(decision.score, decision.signals, recentSessionContext(agent, config.maxInputBytes)), signal)
      if (verdict.severity !== 'none') agent.steer(createUserMessage({ content: [{ type: 'text', text: adviceMessage(verdict, 'automatic escalation') }], source: { kind: 'plugin', plugin: name } }))
    } catch (error) { const message = error instanceof AdvisorUnavailableError ? error.message : error instanceof Error ? error.message : String(error); logger.warn(`automatic advisor escalation failed: ${message}`) }
  })
}
