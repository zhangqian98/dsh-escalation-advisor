import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import { ADVISOR_SYSTEM_PROMPT } from './prompts.js'
import { redactSecrets, truncateUtf8 } from './redact.js'
import { parseVerdict, type AdvisorVerdict } from './verdict.js'

export class AdvisorUnavailableError extends Error {
  constructor(message: string, readonly code = 'advisor_unavailable') { super(message); this.name = 'AdvisorUnavailableError' }
}
async function prepare(ctx: Context, config: Config, signal: AbortSignal): Promise<PreparedLlmCall> {
  if (!config.provider.trim() || !config.model.trim()) throw new AdvisorUnavailableError('Advisor provider/model is not configured. Configure a model already available in DSH.')
  try { return await ctx.llm.prepareCall({ provider: config.provider.trim(), model: config.model.trim(), maxTokens: config.maxOutputTokens }, signal) }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'UNKNOWN_MODEL') throw new AdvisorUnavailableError('The selected advisor model is not available through DSH. Configure it under DSH Models first.', 'unknown_model')
    throw error
  }
}
export async function callAdvisor(ctx: Context, config: Config, prompt: string, signal: AbortSignal): Promise<AdvisorVerdict> {
  const prepared = await prepare(ctx, config, signal)
  const boundedPrompt = truncateUtf8(redactSecrets(prompt), config.maxInputBytes)
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
  const request: GenerateOptions = Object.freeze({ ...prepared.config, system: ADVISOR_SYSTEM_PROMPT, messages: [createUserMessage({ content: [{ type: 'text', text: boundedPrompt }], source: { kind: 'user' } })], signal: callSignal })
  const chunks: string[] = []
  for await (const chunk of prepared.stream(request)) { callSignal.throwIfAborted(); if (chunk.type === 'text-delta' && chunk.text) chunks.push(chunk.text) }
  const raw = chunks.join('').trim()
  if (!raw) throw new AdvisorUnavailableError('Advisor returned no text.', 'empty_response')
  return parseVerdict(raw)
}
