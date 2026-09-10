import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime, { type SubagentRun, type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Advisor from '../src/index.js'
import type { Config } from '../src/config.js'

export type ScriptEntry =
  | StreamChunk[]
  | ((request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)

export interface RecordedRequest {
  readonly sequence: number
  readonly request: GenerateOptions
}

export class ScriptedAdapter extends LlmAdapter {
  readonly requests: RecordedRequest[] = []
  private sequence = 0

  constructor(private readonly scripts: Record<string, ScriptEntry[]>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ sequence: ++this.sequence, request })
    const script = this.scripts[request.model]
    const entry = script?.shift()
    if (!entry) throw new Error(`ScriptedAdapter: script exhausted for model ${request.model}`)
    const chunks = typeof entry === 'function' ? await entry(request) : entry
    for (const chunk of chunks) {
      if (request.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }

  forModel(model: string): RecordedRequest[] {
    return this.requests.filter(({ request }) => request.model === model)
  }
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private stored: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

export const TEST_CONFIG: Config = {
  enabled: true,
  mode: 'manual',
  provider: 'mock',
  model: 'advisor',
  reasoningEffort: '',
  subagentProvider: 'spawn',
  defaultEnabledTools: [],
  readOnlyTools: [],
  mutatingTools: ['edit', 'write', 'bash', 'pwsh'],
  retryDelayMs: 0,
  capabilityAmplifierTools: [],
  manualMainAgent: true,
  manualLocalSubagents: true,
  escalationMainAgent: true,
  escalationLocalSubagents: true,
  continuousMainAgent: true,
  continuousLocalSubagents: false,
  escalationWait: 'block',
  continuousWait: 'background',
  timeoutMs: 5000,
  maxManualConsultsPerSession: 8,
  maxAdvisorConsultsPerTask: 12,
  maxConcurrentAdvisorRuns: 2,
  scoreThreshold: 4,
  toolErrorWeight: 2,
  repeatedFailureWeight: 3,
  nonZeroExitWeight: 1,
  repeatedMutationWeight: 2,
  repeatedMutationCount: 3,
  maxAutoConsultsPerTurn: 1,
  maxAutoConsultsPerProblem: 1,
  cooldownTurns: 0,
  continuousMinSeverity: 'concern',
  injectNits: true,
}

export interface CreatedAgentRecord {
  readonly agent: Agent
  disposedEvents?: readonly SessionEvent[]
}

export interface IntegrationHarness {
  readonly ctx: Context
  readonly root: Agent
  readonly adapter: ScriptedAdapter
  readonly created: CreatedAgentRecord[]
  runRoot(prompt: string): Promise<void>
  spawnWorker(options?: {
    model?: string
    label?: string
    prompt?: string
    toolFilter?: SubagentStartRequest['toolFilter']
  }): Promise<SubagentRun>
}

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

export async function createIntegrationHarness(
  scripts: Record<string, ScriptEntry[]>,
  config: Partial<Config> = {},
  rootOptions: Partial<AgentOptions> = {},
): Promise<IntegrationHarness> {
  const ctx = new Context()
  const adapter = new ScriptedAdapter(scripts)
  const created: CreatedAgentRecord[] = []

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await mountInvariants(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Advisor, { ...TEST_CONFIG, ...config })

  ctx.on('agent/created', ({ agent }) => {
    created.push({ agent })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const record = created.find(candidate => candidate.agent === agent)
    if (record) record.disposedEvents = agent.session.snapshotEvents()
  })

  const root = await ctx.agentLoop.create(SessionId('integration-root'), {
    provider: 'mock',
    model: 'weak',
    ...rootOptions,
  })

  return {
    ctx,
    root,
    adapter,
    created,
    async runRoot(prompt: string): Promise<void> {
      root.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await root.whenIdle()
    },
    spawnWorker(options = {}): Promise<SubagentRun> {
      return ctx.subagents.start('spawn', {
        parent: root,
        signal: new AbortController().signal,
        label: options.label ?? 'Worker A',
        prompt: [{ type: 'text', text: options.prompt ?? 'Complete the delegated task.' }],
        agentOptions: { provider: 'mock', model: options.model ?? 'worker' },
        ...(options.toolFilter === undefined ? {} : { toolFilter: options.toolFilter }),
      })
    },
  }
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(callId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export function advisorVerdictResponse(overrides: Record<string, unknown> = {}): StreamChunk[] {
  return toolCallResponse('advisor-verdict', 'structured_output', {
    severity: 'concern',
    disposition: 'revise',
    summary: 'Independent review found a concrete issue.',
    diagnosis: 'The repeated attempt preserves the failing assumption.',
    next_actions: ['Change the assumption and rerun the focused check.'],
    evidence_used: [],
    assumptions: [],
    recommended_next_action: 'Change the assumption and rerun the focused check.',
    validation_plan: ['Rerun the focused check.'],
    needs_more_evidence: false,
    confidence: 0.9,
    changes_made: [],
    ...overrides,
  })
}

export function descriptorOf(agent: Agent): Record<string, unknown> | undefined {
  return agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data as Record<string, unknown> | undefined
}

export function advisorChildren(harness: IntegrationHarness): CreatedAgentRecord[] {
  return harness.created.filter(({ agent }) => descriptorOf(agent)?.label?.toString().startsWith('Advisor ·') === true)
}

export function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

export function systemPromptOf(request: GenerateOptions): string {
  const first = request.messages[0]
  return first?.role === 'system'
    ? first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    : ''
}

export function deferred<T = void>(): {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
