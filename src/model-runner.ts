import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Config } from './config.js'
import type { EffectiveAdvisorPolicy } from './policy.js'
import { ADVISOR_SYSTEM_PROMPT } from './prompts.js'
import { redactSecrets } from './redact.js'
import { type AdvisorVerdict } from './verdict.js'
import { ADVISOR_VERDICT_TOOL, type AdvisorVerdictCollector } from './verdict-tool.js'
import { isCapabilityAmplifier } from './capabilities.js'
import type { AdvisorRegistry } from './registry.js'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export class AdvisorUnavailableError extends Error {
  constructor(message: string, readonly code = 'advisor_unavailable', readonly transient = false) { super(redactSecrets(message)); this.name = 'AdvisorUnavailableError' }
}

export interface AdvisorRunResult {
  verdict: AdvisorVerdict
  childSessionId: string
  usage?: { inputTokens: number; outputTokens: number }
}

export function advisorToolSurface(ctx: Context, parent: Agent, policy: EffectiveAdvisorPolicy, amplifierTools: readonly string[] = []) {
  const visible = new Set(ctx.tools.schemas(parent).map(tool => tool.name))
  const global = new Set(ctx.tools.schemas().map(tool => tool.name))
  const requested = policy.allowedTools.filter(name => !isCapabilityAmplifier(ctx, name, amplifierTools))
  return { allowedTools: requested.filter(name => visible.has(name) && global.has(name)), unavailableTools: requested.filter(name => !visible.has(name) || !global.has(name)) }
}

export function advisorPolicyNote(allowedTools: string[], unavailableTools: string[]): string {
  return 'ADVISOR TOOL POLICY:\nExposed: ' + (allowedTools.join(', ') || '(none)') + '\nUnavailable: ' + (unavailableTools.join(', ') || '(none)') + '. Never claim to use unavailable tools. Never delegate or create execution scopes.\n\n'
}

/** Run a visible child, with identity attached before its first model request. */
export async function callAdvisor(
  ctx: Context, config: Config, parent: Agent, prompt: string, signal: AbortSignal,
  policy: EffectiveAdvisorPolicy, label: string,
  lifecycle: { registry: AdvisorRegistry; root: Agent; collector: AdvisorVerdictCollector; consultationId: string; onStarted: () => void; onPublished: (id: string) => void },
): Promise<AdvisorRunResult> {
  if (!config.provider.trim() || !config.model.trim()) throw new AdvisorUnavailableError('Advisor provider/model is not configured.', 'configuration')
  const subagents = parent.ctx.get('subagents') ?? ctx.get('subagents')
  if (!subagents) throw new AdvisorUnavailableError('DSH subagent runtime is unavailable.', 'configuration')
  const { allowedTools, unavailableTools } = advisorToolSurface(ctx, parent, policy, config.capabilityAmplifierTools)
  // The verdict channel is host-owned and is always exposed to the Advisor; it is
  // not part of the configurable tool policy.
  const advisorTools = [...allowedTools, ADVISOR_VERDICT_TOOL]
  const prefix = advisorPolicyNote(advisorTools, unavailableTools)
  const timeoutMessage = 'Advisor consultation timed out (configured per-attempt limit: ' + config.timeoutMs / 1000 + ' seconds).'
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
  const identity = lifecycle.registry.reserve(parent, lifecycle.root, advisorTools)
  lifecycle.collector.open({ id: lifecycle.consultationId, invocationId: identity.invocationId, requesterId: String(parent.id), rootId: String(lifecycle.root.id) })
  let started = false
  // The loop prepares authentication before entering this stream. Unlike
  // agent/assistant-stream, this boundary also exists in DSH 0.1.2-rc.1 and
  // counts failures before the first chunk without charging preparation errors.
  const stopObserve = ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
    const owner = agent === undefined ? undefined : lifecycle.registry.identity(agent)
    if (!started && !options.purpose && owner?.invocationId === identity.invocationId && owner.advisorId === String(agent?.id)) {
      options.signal?.throwIfAborted()
      started = true
      lifecycle.onStarted()
    }
    yield* next()
  })
  let run
  try {
    run = await subagents.start(config.subagentProvider.trim() || 'spawn', {
      label, prompt: [{ type: 'text', text: prefix + prompt }], parent, signal: callSignal,
      // Explicit undefined clears the spawn provider's inherited parent cap;
      // DSH then resolves the selected Advisor model's own output default.
      agentOptions: { provider: config.provider.trim(), model: config.model.trim(), maxTokens: undefined,
        reasoningEffort: config.reasoningEffort.trim() ? ReasoningEffortId(config.reasoningEffort.trim()) : undefined,
        advisorInvocation: identity.invocationId },
      toolFilter: { allow: advisorTools }, persona: ADVISOR_SYSTEM_PROMPT,
    })
    lifecycle.onPublished(String(run.id))
    lifecycle.collector.bind(lifecycle.consultationId, String(run.id))
    const result = await run.result
    const child = ctx.agents.get(run.id)
    const events = child?.session.snapshotEvents() ?? []
    const ending = events.findLast(event => event.type === 'turn/end')
    if (result.stopReason !== 'completed') {
      const detail = result.diagnostic ?? JSON.stringify(ending?.type === 'turn/end' ? ending.data.reason : result.stopReason)
      if (signal.aborted) throw new AdvisorUnavailableError(signal.reason?.name === 'TimeoutError' ? timeoutMessage : 'Advisor request cancelled.', signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', signal.reason?.name === 'TimeoutError')
      if (callSignal.aborted) throw new AdvisorUnavailableError(timeoutMessage, 'timeout', true)
      const transient = /timeout|timed out|rate.limit|overload|unavailable|server|network|econn|concurrenc|429|50[0234]/i.test(detail)
      throw new AdvisorUnavailableError('Advisor child ended with ' + result.stopReason + ': ' + detail, 'child_failed', transient)
    }
    // The verdict channel is the only authoritative source. A run that closes
    // without a reconciled verdict is a failure, not advice.
    const reconciled = lifecycle.collector.reconcile(lifecycle.consultationId, {
      stopReason: result.stopReason,
      ...(ending?.type === 'turn/end' ? { turnEnd: { seq: ending.seq, kind: ending.data.reason.kind } } : {}),
    })
    if (!reconciled.published) throw new AdvisorUnavailableError('Advisor returned no usable verdict: ' + reconciled.reason, 'no_verdict')
    const usage = { inputTokens: 0, outputTokens: 0 }
    let usageKnown = false, usageMissing = false
    for (const event of events) if (event.type === 'assistant/message') {
      if (typeof event.data.usage?.inputTokens !== 'number' || typeof event.data.usage?.outputTokens !== 'number') { usageMissing = true; continue }
      usageKnown = true
      usage.inputTokens += event.data.usage.inputTokens
      usage.outputTokens += event.data.usage.outputTokens
    } else if (event.type === 'assistant/attempt') {
      usageMissing = true
    }
    return { verdict: reconciled.verdict, childSessionId: String(run.id), ...(usageKnown && !usageMissing ? { usage } : {}) }
  } catch (error) {
    if (error instanceof AdvisorUnavailableError) throw error
    if (signal.aborted) throw new AdvisorUnavailableError(signal.reason?.name === 'TimeoutError' ? timeoutMessage : 'Advisor request cancelled.', signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', signal.reason?.name === 'TimeoutError')
    if (callSignal.aborted) throw new AdvisorUnavailableError(timeoutMessage, 'timeout', true)
    const message = error instanceof Error ? error.message : String(error)
    throw new AdvisorUnavailableError('Unable to run Advisor: ' + message, 'child_start_failed', /timeout|timed out|rate.limit|overload|network|econn|concurrenc|429|50[0234]/i.test(message))
  } finally {
    stopObserve()
    identity.release()
    // A run that did not publish leaves a closed, unusable record: a late or
    // late-arriving verdict submission resolves to 'closed' instead of reviving it.
    lifecycle.collector.invalidate(lifecycle.consultationId, 'Advisor run ended without publishing a verdict.')
    await run?.dispose()
  }
}
