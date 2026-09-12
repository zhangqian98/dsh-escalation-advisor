import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type { AdvisorMode, AdvisorWaitMode, Config } from './config.js'
import { ADVISOR_MODES, WAIT_MODES, isAdvisorTimeout } from './config.js'
import { isCapabilityAmplifier, isReservedTool, toolEffect, type ToolEffect } from './capabilities.js'

export const INHERIT = 'inherit' as const
export type InheritableWaitMode = AdvisorWaitMode | typeof INHERIT
export type AdvisorToolOverride = 'allow' | 'deny' | 'inherit'
export type InheritableAdvisorMode = AdvisorMode | typeof INHERIT

export interface AdvisorSessionPolicyOverride {
  version: 2
  /** Omitted in earlier records; follows the global mode. */
  mode?: AdvisorMode
  /** Omitted follows the global per-attempt timeout. */
  timeoutMs?: number
  /** False preserves an old absolute preset/allowlist across global-default changes. */
  inheritDefaultTools?: boolean
  /** Tools explicitly switched on for this parent session. */
  allowTools: string[]
  /** Tools explicitly switched off for this parent session. */
  denyTools: string[]
  escalationWait: InheritableWaitMode
  continuousWait: InheritableWaitMode
}

export interface EffectiveAdvisorPolicy {
  mode: AdvisorMode
  timeoutMs: number
  allowedTools: string[]
  defaultEnabledTools: string[]
  allowTools: string[]
  denyTools: string[]
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  overridden: boolean
}

export interface AdvisorToolCatalogItem {
  name: string
  description: string
  enabled: boolean
  defaultEnabled: boolean
  override: AdvisorToolOverride
  reserved: boolean
  effect: ToolEffect
}

export interface AdvisorPolicyCatalog {
  mode: AdvisorMode
  modeDefault: AdvisorMode
  modeOverride: InheritableAdvisorMode
  timeoutMs: number
  timeoutDefaultMs: number
  timeoutOverride: number | typeof INHERIT
  escalationWaitDefault: AdvisorWaitMode
  continuousWaitDefault: AdvisorWaitMode
  allowedTools: string[]
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  escalationWaitOverride: InheritableWaitMode
  continuousWaitOverride: InheritableWaitMode
  tools: AdvisorToolCatalogItem[]
}

export const DEFAULT_SESSION_OVERRIDE: AdvisorSessionPolicyOverride = Object.freeze({
  version: 2,
  allowTools: Object.freeze([]) as unknown as string[],
  denyTools: Object.freeze([]) as unknown as string[],
  escalationWait: INHERIT,
  continuousWait: INHERIT,
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Latest-wins per-parent-session Advisor tool/wait override. Log-only. */
    'advisor/policy': AdvisorSessionPolicyOverride
  }
}

function cleanToolName(value: string): string { return value.trim().slice(0, 160) }
export function normalizeToolList(values: unknown): string[] {
  const out: string[] = [], seen = new Set<string>()
  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== 'string') continue
    const name = cleanToolName(raw)
    if (!name || seen.has(name)) continue
    seen.add(name); out.push(name)
    if (out.length >= 128) break
  }
  return out
}

const LEGACY_PRESETS: Record<string, string[]> = {
  none: [], inspect: ['read', 'read_image', 'glob', 'grep'],
  research: ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'],
  edit: ['read', 'read_image', 'glob', 'grep', 'edit', 'write'],
}

/** Durable session data is untrusted input, including data written by older versions. */
export function parsePolicy(value: unknown): AdvisorSessionPolicyOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_SESSION_OVERRIDE
  const data = value as Record<string, unknown>
  if (data.version !== undefined && data.version !== 2) return DEFAULT_SESSION_OVERRIDE
  const wait = (value: unknown): InheritableWaitMode => typeof value === 'string' && isWaitMode(value) ? value : INHERIT
  const waits = { escalationWait: wait(data.escalationWait), continuousWait: wait(data.continuousWait) }
  const mode = typeof data.mode === 'string' && (ADVISOR_MODES as readonly string[]).includes(data.mode) ? { mode: data.mode as AdvisorMode } : {}
  const timeout = isAdvisorTimeout(data.timeoutMs) ? { timeoutMs: data.timeoutMs } : {}
  if (Array.isArray(data.allowTools) && Array.isArray(data.denyTools)) {
    return { version: 2, allowTools: normalizeToolList(data.allowTools), denyTools: normalizeToolList(data.denyTools), ...(data.inheritDefaultTools === false ? { inheritDefaultTools: false } : {}), ...waits, ...mode, ...timeout }
  }
  if (data.version === undefined && typeof data.toolPreset === 'string') {
    if (data.toolPreset === INHERIT) return { ...DEFAULT_SESSION_OVERRIDE, ...waits }
    const tools = data.toolPreset === 'custom' && Array.isArray(data.tools) ? normalizeToolList(data.tools) : Object.hasOwn(LEGACY_PRESETS, data.toolPreset) ? LEGACY_PRESETS[data.toolPreset] : undefined
    if (tools) return { version: 2, inheritDefaultTools: false, allowTools: [...tools], denyTools: [], ...waits }
  }
  return DEFAULT_SESSION_OVERRIDE
}

export function sessionPolicyOverride(session: Session): AdvisorSessionPolicyOverride {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'advisor/policy') return parsePolicy(event.data)
  }
  return DEFAULT_SESSION_OVERRIDE
}

export function effectiveAdvisorPolicy(config: Config, session: Session): EffectiveAdvisorPolicy {
  const override = sessionPolicyOverride(session)
  const defaults = normalizeToolList(config.defaultEnabledTools)
  const allowed = new Set(override.inheritDefaultTools === false ? [] : defaults)
  for (const name of normalizeToolList(override.allowTools)) allowed.add(name)
  for (const name of normalizeToolList(override.denyTools)) allowed.delete(name)
  return {
    mode: override.mode ?? config.mode,
    timeoutMs: override.timeoutMs ?? config.timeoutMs,
    allowedTools: [...allowed].filter(name => !isReservedTool(name, config.capabilityAmplifierTools)),
    defaultEnabledTools: defaults,
    allowTools: normalizeToolList(override.allowTools),
    denyTools: normalizeToolList(override.denyTools),
    escalationWait: override.escalationWait === INHERIT ? config.escalationWait : override.escalationWait,
    continuousWait: override.continuousWait === INHERIT ? config.continuousWait : override.continuousWait,
    overridden: override !== DEFAULT_SESSION_OVERRIDE,
  }
}

function isWaitMode(value: string): value is InheritableWaitMode { return value === INHERIT || (WAIT_MODES as readonly string[]).includes(value) }
function append(session: Session, next: AdvisorSessionPolicyOverride): void { session.append('advisor/policy', parsePolicy(next)) }
function toolOverrideOf(policy: EffectiveAdvisorPolicy, name: string): AdvisorToolOverride {
  if (policy.denyTools.includes(name)) return 'deny'
  if (policy.allowTools.includes(name)) return 'allow'
  return 'inherit'
}
function statusText(config: Config, session: Session): string {
  const effective = effectiveAdvisorPolicy(config, session)
  const tools = effective.allowedTools.length ? effective.allowedTools.join(', ') : '(none)'
  return [`Advisor enabled tools: ${tools}`, `Escalation: ${effective.escalationWait}`, `Continuous: ${effective.continuousWait}`, 'Use the Advisor header control to toggle individual tools, or /advisor catalog for JSON.'].join('\n')
}

function requireRoot(agent: Agent): { kind: 'error'; text: string } | undefined {
  return agent.session.header.parentSession === undefined ? undefined : { kind: 'error', text: 'Advisor policy is configured on the root parent session, not inside a child session.' }
}

export function catalogFor(config: Config, agent: Agent): AdvisorPolicyCatalog {
  const policy = effectiveAdvisorPolicy(config, agent.session)
  const allowedTools = policy.allowedTools.filter(name => !isCapabilityAmplifier(agent.ctx, name, config.capabilityAmplifierTools))
  const tools = agent.ctx.get('tools')
  const schemas = tools?.schemas(agent) ?? []
  const hidden = new Set(['consult_advisor', 'advisor_verdict', 'structured_output', 'run_code'])
  return {
    mode: policy.mode,
    modeDefault: config.mode,
    modeOverride: sessionPolicyOverride(agent.session).mode ?? INHERIT,
    timeoutMs: policy.timeoutMs,
    timeoutDefaultMs: config.timeoutMs,
    timeoutOverride: sessionPolicyOverride(agent.session).timeoutMs ?? INHERIT,
    escalationWaitDefault: config.escalationWait,
    continuousWaitDefault: config.continuousWait,
    allowedTools,
    escalationWait: policy.escalationWait,
    continuousWait: policy.continuousWait,
    escalationWaitOverride: sessionPolicyOverride(agent.session).escalationWait,
    continuousWaitOverride: sessionPolicyOverride(agent.session).continuousWait,
    tools: schemas
      .filter(schema => !hidden.has(schema.name))
      .map(schema => ({
        name: schema.name,
        description: (schema.description ?? '').slice(0, 360),
        enabled: allowedTools.includes(schema.name),
        defaultEnabled: policy.defaultEnabledTools.includes(schema.name),
        override: toolOverrideOf(policy, schema.name),
        reserved: isCapabilityAmplifier(agent.ctx, schema.name, config.capabilityAmplifierTools),
        effect: toolEffect(schema.name, config.readOnlyTools, config.mutatingTools),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function updateToolOverride(session: Session, name: string, value: AdvisorToolOverride): void {
  const tool = cleanToolName(name)
  if (!tool) throw new Error('tool name is required')
  if (tool === 'advisor_verdict') throw new Error('The Advisor verdict channel is not a configurable tool.')
  if (value === 'allow' && isReservedTool(tool)) throw new Error('Advisor delegation tools are permanently disabled.')
  const current = sessionPolicyOverride(session)
  const allow = new Set(normalizeToolList(current.allowTools))
  const deny = new Set(normalizeToolList(current.denyTools))
  allow.delete(tool); deny.delete(tool)
  if (value === 'allow') allow.add(tool)
  else if (value === 'deny') deny.add(tool)
  append(session, { ...current, allowTools: [...allow], denyTools: [...deny] })
}

export function resetPolicy(session: Session): void { append(session, { ...DEFAULT_SESSION_OVERRIDE }) }
export function updateTimeoutOverride(session: Session, value: string): void {
  const { timeoutMs: _timeout, ...current } = sessionPolicyOverride(session)
  if (value === INHERIT) { append(session, current); return }
  const timeoutMs = Number(value)
  if (!/^\d+$/.test(value) || !isAdvisorTimeout(timeoutMs)) throw new Error('Timeout must be 1000–3600000 milliseconds, or inherit.')
  append(session, { ...current, timeoutMs })
}
export function updateModeOverride(session: Session, value: string): void {
  if (value !== INHERIT && !(ADVISOR_MODES as readonly string[]).includes(value)) throw new Error('Expected inherit, manual, escalate, or continuous.')
  const { mode: _mode, ...current } = sessionPolicyOverride(session)
  append(session, value === INHERIT ? current : { ...current, mode: value as AdvisorMode })
}
export function updateWaitOverride(session: Session, field: 'escalationWait' | 'continuousWait', value: string): void {
  if (!isWaitMode(value)) throw new Error('Expected inherit, block, or background.')
  append(session, { ...sessionPolicyOverride(session), [field]: value })
}

function registerPolicyCommands(commandCtx: Context, currentConfig: () => Config): void {
  commandCtx.commands.register({
    name: 'advisor', description: 'Show or reset effective Advisor permissions and wait behavior for this session', input: { hint: '[catalog|reset]' },
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      const input = rawInput.trim()
      if (input === 'reset') {
        append(agent.session, { ...DEFAULT_SESSION_OVERRIDE })
        return { kind: 'success' as const, text: JSON.stringify(catalogFor(currentConfig(), agent)) }
      }
      if (input === 'catalog') return { kind: 'success' as const, text: JSON.stringify(catalogFor(currentConfig(), agent)) }
      if (input) return { kind: 'error' as const, text: 'Expected /advisor, /advisor catalog, or /advisor reset.' }
      return { kind: 'success' as const, text: statusText(currentConfig(), agent.session) }
    },
  })
  commandCtx.commands.register({
    name: 'advisor-tool', description: 'Override one Advisor tool for this session', input: { hint: '<tool-name> <on|off|inherit>' },
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      const match = rawInput.trim().match(/^(\S+)\s+(on|off|inherit)$/)
      if (!match) return { kind: 'error' as const, text: 'Expected: /advisor-tool <tool-name> <on|off|inherit>' }
      const [, tool, state] = match
      if (state === 'on' && isCapabilityAmplifier(commandCtx, tool!, currentConfig().capabilityAmplifierTools)) return { kind: 'error' as const, text: 'Advisor delegation tools are permanently disabled.' }
      updateToolOverride(agent.session, tool!, state === 'on' ? 'allow' : state === 'off' ? 'deny' : 'inherit')
      return { kind: 'success' as const, text: JSON.stringify(catalogFor(currentConfig(), agent)) }
    },
  })
  const waitCommand = (name: 'advisor-escalation-wait' | 'advisor-continuous-wait', field: 'escalationWait' | 'continuousWait', description: string): void => {
    commandCtx.commands.register({
      name, description, input: { hint: '<inherit|block|background>' },
      handler: ({ agent, rawInput }) => {
        const rejected = requireRoot(agent); if (rejected) return rejected
        const value = rawInput.trim()
        if (!isWaitMode(value)) return { kind: 'error' as const, text: 'Expected inherit, block, or background.' }
        append(agent.session, { ...sessionPolicyOverride(agent.session), [field]: value })
        return { kind: 'success' as const, text: JSON.stringify(catalogFor(currentConfig(), agent)) }
      },
    })
  }
  waitCommand('advisor-escalation-wait', 'escalationWait', 'Choose whether automatic escalation pauses this session for Advisor review')
  waitCommand('advisor-continuous-wait', 'continuousWait', 'Choose whether continuous review pauses this session for Advisor review')
}

/**
 * Human-only per-session policy commands. Root/global registration covers TUI-like
 * compositions; each Web/root Agent also receives an agent-scoped registration.
 * Command input/results never enter model history.
 */
export function installAdvisorPolicyCommand(ctx: Context, currentConfig: () => Config): void {
  ctx.inject(['commands'], commandCtx => { registerPolicyCommands(commandCtx, currentConfig) })

  const installed = new WeakSet<Agent>()
  const mountAgent = (agent: Agent): void => {
    if (agent.session.header.parentSession !== undefined || installed.has(agent)) return
    installed.add(agent)
    agent.ctx.inject(['commands'], commandCtx => { registerPolicyCommands(commandCtx, currentConfig) })
  }
  for (const agent of ctx.agents.list()) mountAgent(agent)
  ctx.on('agent/created', ({ agent }) => { mountAgent(agent) })
}
