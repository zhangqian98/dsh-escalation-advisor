import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'
import type { EffectiveAdvisorPolicy } from './policy.js'
import { ADVISOR_SYSTEM_PROMPT } from './prompts.js'
import { redactSecrets, truncateUtf8 } from './redact.js'
import { parseVerdict, verdictFromStructured, type AdvisorVerdict } from './verdict.js'

export class AdvisorUnavailableError extends Error {
  constructor(message: string, readonly code = 'advisor_unavailable') { super(message); this.name = 'AdvisorUnavailableError' }
}

const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['none', 'nit', 'concern', 'blocker'] },
    summary: { type: 'string' },
    diagnosis: { type: 'string' },
    next_actions: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['severity', 'summary', 'diagnosis', 'next_actions', 'confidence'],
  additionalProperties: false,
}

export interface AdvisorRunResult {
  verdict: AdvisorVerdict
  childSessionId: string
}

/** Run one visible one-shot DSH child. The child owns its transcript and tool calls. */
export async function callAdvisor(
  ctx: Context,
  config: Config,
  parent: Agent,
  prompt: string,
  signal: AbortSignal,
  policy: EffectiveAdvisorPolicy,
  label: string,
): Promise<AdvisorRunResult> {
  if (!config.provider.trim() || !config.model.trim()) throw new AdvisorUnavailableError('Advisor provider/model is not configured. Configure a model already available in DSH.')
  const subagents = parent.ctx.get('subagents') ?? ctx.get('subagents')
  if (!subagents) throw new AdvisorUnavailableError('DSH subagent runtime is unavailable for this session.', 'subagents_unavailable')

  const visible = new Set(ctx.tools.schemas(parent).map(tool => tool.name))
  const requestedTools = policy.allowedTools.filter(name => name !== 'consult_advisor')
  const allowedTools = requestedTools.filter(name => visible.has(name))
  const unavailableTools = requestedTools.filter(name => !visible.has(name))
  const toolPolicyNote = `\n\nADVISOR TOOL POLICY:\nExposed: ${allowedTools.length ? allowedTools.join(', ') : '(none)'}\nRequested but unavailable in the parent DSH tool surface: ${unavailableTools.length ? unavailableTools.join(', ') : '(none)'}. Do not claim to have used unavailable tools.`
  const boundedPrompt = truncateUtf8(redactSecrets(prompt + toolPolicyNote), config.maxInputBytes)
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
  let run
  try {
    run = await subagents.start(config.subagentProvider.trim() || 'spawn', {
      label,
      prompt: [{ type: 'text', text: boundedPrompt }],
      parent,
      signal: callSignal,
      agentOptions: { provider: config.provider.trim(), model: config.model.trim(), maxTokens: config.maxOutputTokens },
      outputSchema: VERDICT_SCHEMA,
      maxDepth: 1,
      toolFilter: { allow: allowedTools },
      persona: ADVISOR_SYSTEM_PROMPT,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AdvisorUnavailableError(`Unable to start Advisor child session: ${message}`, 'child_start_failed')
  }
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') throw new AdvisorUnavailableError(`Advisor child ended with ${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}`, 'child_failed')
    const raw = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const verdict = result.structured === undefined ? parseVerdict(raw) : verdictFromStructured(result.structured, raw)
    return { verdict, childSessionId: String(run.id) }
  } finally {
    await run.dispose()
  }
}
