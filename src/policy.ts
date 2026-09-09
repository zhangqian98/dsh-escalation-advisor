import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type { AdvisorWaitMode, Config } from './config.js'
import { WAIT_MODES } from './config.js'

export const INHERIT = 'inherit' as const
export type InheritableWaitMode = AdvisorWaitMode | typeof INHERIT
export type AdvisorToolOverride = 'allow' | 'deny' | 'inherit'

export interface AdvisorSessionPolicyOverride {
  /** Tools explicitly switched on for this parent session. */
  allowTools: string[]
  /** Tools explicitly switched off for this parent session. */
  denyTools: string[]
  escalationWait: InheritableWaitMode
  continuousWait: InheritableWaitMode
}

export interface EffectiveAdvisorPolicy {
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
}

export interface AdvisorPolicyCatalog {
  allowedTools: string[]
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  escalationWaitOverride: InheritableWaitMode
  continuousWaitOverride: InheritableWaitMode
  tools: AdvisorToolCatalogItem[]
}

export const DEFAULT_SESSION_OVERRIDE: AdvisorSessionPolicyOverride = Object.freeze({
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
export function normalizeToolList(values: readonly string[]): string[] {
  const out: string[] = [], seen = new Set<string>()
  for (const raw of values) {
    const name = cleanToolName(raw)
    if (!name || seen.has(name)) continue
    seen.add(name); out.push(name)
    if (out.length >= 128) break
  }
  return out
}

export function sessionPolicyOverride(session: Session): AdvisorSessionPolicyOverride {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'advisor/policy') return event.data
  }
  return DEFAULT_SESSION_OVERRIDE
}

export function effectiveAdvisorPolicy(config: Config, session: Session): EffectiveAdvisorPolicy {
  const override = sessionPolicyOverride(session)
  const defaults = normalizeToolList(config.defaultEnabledTools)
  const allowed = new Set(defaults)
  for (const name of normalizeToolList(override.allowTools)) allowed.add(name)
  for (const name of normalizeToolList(override.denyTools)) allowed.delete(name)
  return {
    allowedTools: [...allowed],
    defaultEnabledTools: defaults,
    allowTools: normalizeToolList(override.allowTools),
    denyTools: normalizeToolList(override.denyTools),
    escalationWait: override.escalationWait === INHERIT ? config.escalationWait : override.escalationWait,
    continuousWait: override.continuousWait === INHERIT ? config.continuousWait : override.continuousWait,
    overridden: override !== DEFAULT_SESSION_OVERRIDE,
  }
}

function isWaitMode(value: string): value is InheritableWaitMode { return value === INHERIT || (WAIT_MODES as readonly string[]).includes(value) }
function append(session: Session, next: AdvisorSessionPolicyOverride): void { session.append('advisor/policy', next) }
function toolOverrideOf(policy: EffectiveAdvisorPolicy, name: string): AdvisorToolOverride {
  if (policy.allowTools.includes(name)) return 'allow'
  if (policy.denyTools.includes(name)) return 'deny'
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

function catalogFor(config: Config, agent: Agent): AdvisorPolicyCatalog {
  const policy = effectiveAdvisorPolicy(config, agent.session)
  const tools = agent.ctx.get('tools')
  const schemas = tools?.schemas(agent) ?? []
  const hidden = new Set(['consult_advisor', 'structured_output', 'run_code'])
  return {
    allowedTools: policy.allowedTools,
    escalationWait: policy.escalationWait,
    continuousWait: policy.continuousWait,
    escalationWaitOverride: sessionPolicyOverride(agent.session).escalationWait,
    continuousWaitOverride: sessionPolicyOverride(agent.session).continuousWait,
    tools: schemas
      .filter(schema => !hidden.has(schema.name))
      .map(schema => ({
        name: schema.name,
        description: (schema.description ?? '').slice(0, 360),
        enabled: policy.allowedTools.includes(schema.name),
        defaultEnabled: policy.defaultEnabledTools.includes(schema.name),
        override: toolOverrideOf(policy, schema.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function updateToolOverride(session: Session, name: string, value: AdvisorToolOverride): void {
  const tool = cleanToolName(name)
  if (!tool) throw new Error('tool name is required')
  const current = sessionPolicyOverride(session)
  const allow = new Set(normalizeToolList(current.allowTools))
  const deny = new Set(normalizeToolList(current.denyTools))
  allow.delete(tool); deny.delete(tool)
  if (value === 'allow') allow.add(tool)
  else if (value === 'deny') deny.add(tool)
  append(session, { ...current, allowTools: [...allow], denyTools: [...deny] })
}

function registerPolicyCommands(commandCtx: Context, currentConfig: () => Config): void {
  commandCtx.commands.register({
    name: 'advisor', description: 'Show or reset effective Advisor permissions and wait behavior for this session', input: { hint: '[catalog|reset]' },
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      const input = rawInput.trim()
      if (input === 'reset') {
        append(agent.session, { allowTools: [], denyTools: [], escalationWait: INHERIT, continuousWait: INHERIT })
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
