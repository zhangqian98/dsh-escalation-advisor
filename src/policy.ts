import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type { AdvisorToolPreset, AdvisorWaitMode, Config } from './config.js'
import { TOOL_PRESETS, WAIT_MODES } from './config.js'

export const ADVISOR_TOOL_PRESETS: Readonly<Record<Exclude<AdvisorToolPreset, 'custom'>, readonly string[]>> = Object.freeze({
  none: Object.freeze([]),
  inspect: Object.freeze(['read', 'read_image', 'glob', 'grep']),
  research: Object.freeze(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']),
  edit: Object.freeze(['read', 'read_image', 'glob', 'grep', 'edit', 'write']),
})

export const INHERIT = 'inherit' as const
export type InheritableToolPreset = AdvisorToolPreset | typeof INHERIT
export type InheritableWaitMode = AdvisorWaitMode | typeof INHERIT

export interface AdvisorSessionPolicyOverride {
  toolPreset: InheritableToolPreset
  tools: string[]
  escalationWait: InheritableWaitMode
  continuousWait: InheritableWaitMode
}

export interface EffectiveAdvisorPolicy {
  toolPreset: AdvisorToolPreset
  allowedTools: string[]
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  overridden: boolean
}

export const DEFAULT_SESSION_OVERRIDE: AdvisorSessionPolicyOverride = Object.freeze({
  toolPreset: INHERIT,
  tools: Object.freeze([]) as unknown as string[],
  escalationWait: INHERIT,
  continuousWait: INHERIT,
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Latest-wins per-parent-session Advisor policy override. Log-only. */
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
    if (out.length >= 64) break
  }
  return out
}
export function sessionPolicyOverride(session: Session): AdvisorSessionPolicyOverride {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) { const event = events[index]!; if (event.type === 'advisor/policy') return event.data }
  return DEFAULT_SESSION_OVERRIDE
}
function toolsFor(config: Config, preset: AdvisorToolPreset, override: AdvisorSessionPolicyOverride): string[] {
  if (preset !== 'custom') return [...ADVISOR_TOOL_PRESETS[preset]]
  if (override.toolPreset === 'custom') return normalizeToolList(override.tools)
  return normalizeToolList(config.defaultCustomTools)
}
export function effectiveAdvisorPolicy(config: Config, session: Session): EffectiveAdvisorPolicy {
  const override = sessionPolicyOverride(session)
  const toolPreset = override.toolPreset === INHERIT ? config.defaultToolPreset : override.toolPreset
  return {
    toolPreset,
    allowedTools: toolsFor(config, toolPreset, override),
    escalationWait: override.escalationWait === INHERIT ? config.escalationWait : override.escalationWait,
    continuousWait: override.continuousWait === INHERIT ? config.continuousWait : override.continuousWait,
    overridden: override !== DEFAULT_SESSION_OVERRIDE,
  }
}
function isToolPreset(value: string): value is InheritableToolPreset { return value === INHERIT || (TOOL_PRESETS as readonly string[]).includes(value) }
function isWaitMode(value: string): value is InheritableWaitMode { return value === INHERIT || (WAIT_MODES as readonly string[]).includes(value) }
function append(session: Session, next: AdvisorSessionPolicyOverride): void { session.append('advisor/policy', next) }
function statusText(config: Config, session: Session): string {
  const override = sessionPolicyOverride(session), effective = effectiveAdvisorPolicy(config, session)
  const tools = effective.allowedTools.length ? effective.allowedTools.join(', ') : '(none)'
  return [`Advisor permissions: ${effective.toolPreset} [${tools}]`, `Escalation: ${effective.escalationWait}`, `Continuous: ${effective.continuousWait}`, `Overrides: preset=${override.toolPreset}, escalation=${override.escalationWait}, continuous=${override.continuousWait}`].join('\n')
}
function requireRoot(agent: Agent): { kind: 'error'; text: string } | undefined {
  return agent.session.header.parentSession === undefined ? undefined : { kind: 'error', text: 'Advisor policy is configured on the root parent session, not inside a child session.' }
}

function registerPolicyCommands(commandCtx: Context, currentConfig: () => Config): void {
  commandCtx.commands.register({
    name: 'advisor', description: 'Show effective Advisor permissions and wait behavior for this session',
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      if (rawInput.trim() === 'reset') append(agent.session, { toolPreset: INHERIT, tools: [], escalationWait: INHERIT, continuousWait: INHERIT })
      else if (rawInput.trim()) return { kind: 'error' as const, text: 'Use /advisor-permission, /advisor-tools, /advisor-escalation-wait, /advisor-continuous-wait, or /advisor reset.' }
      return { kind: 'success' as const, text: statusText(currentConfig(), agent.session) }
    },
  })
  commandCtx.commands.register({
    name: 'advisor-permission', description: 'Set the Advisor tool preset for this session', input: { hint: '<inherit|none|inspect|research|edit|custom>' },
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      const value = rawInput.trim()
      if (!isToolPreset(value)) return { kind: 'error' as const, text: 'Expected inherit, none, inspect, research, edit, or custom.' }
      const current = sessionPolicyOverride(agent.session)
      append(agent.session, { ...current, toolPreset: value, ...(value === 'custom' ? {} : { tools: [] }) })
      return { kind: 'success' as const, text: statusText(currentConfig(), agent.session) }
    },
  })
  commandCtx.commands.register({
    name: 'advisor-tools', description: 'Set an exact custom Advisor tool allowlist for this session', input: { hint: '<tool1,tool2,...>' },
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      const tools = normalizeToolList(rawInput.trim().split(/[\s,]+/))
      append(agent.session, { ...sessionPolicyOverride(agent.session), toolPreset: 'custom', tools })
      return { kind: 'success' as const, text: statusText(currentConfig(), agent.session) }
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
        return { kind: 'success' as const, text: statusText(currentConfig(), agent.session) }
      },
    })
  }
  waitCommand('advisor-escalation-wait', 'escalationWait', 'Choose whether automatic escalation pauses this session for Advisor review')
  waitCommand('advisor-continuous-wait', 'continuousWait', 'Choose whether continuous review pauses this session for Advisor review')
}

/**
 * Human-only per-session policy commands. Root/global registration covers TUI-like
 * compositions; each Web/root Agent also receives an agent-scoped registration
 * because Web composes `commands` inside the session preset rather than on the
 * host root. Command input/results never enter model history.
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
