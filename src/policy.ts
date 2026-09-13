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
export const TRI_STATE = ['inherit', 'on', 'off'] as const
export type TriState = (typeof TRI_STATE)[number]
export const TRIGGER_KINDS = ['manual', 'escalation', 'completion', 'continuous'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]
export type TriggerOverrides = Partial<Record<TriggerKind, TriState>>
export interface AdvisorCoverageOverride {
  root?: TriggerOverrides
  localSubagents?: TriggerOverrides
  maxDepth?: number
  includeLabels?: string[]
  excludeLabels?: string[]
}
export interface AdvisorSessionPolicyOverride {
  version: 2 | 3
  /** Omitted in earlier records; follows the global mode preset. */
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
  /** v3: completion wait override. Omitted follows global completionWait. */
  completionWait?: InheritableWaitMode
  /** v3: independent trigger overrides (ANDed with mode preset and coverage). */
  triggers?: TriggerOverrides
  /** v3: per-session root/subagent tri-state coverage override. */
  coverage?: AdvisorCoverageOverride
  /** v3: default profile for new consultations (null clears). */
  defaultProfileId?: string | null
  /** v3: allowed profile ids for new consultations. */
  allowedProfileIds?: string[]
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
  completionWait: AdvisorWaitMode
  triggers: Record<TriggerKind, TriState>
  coverage: AdvisorCoverageOverride
  defaultProfileId: string | null
  allowedProfileIds: string[]
  overridden: boolean
  policyVersion: 2 | 3
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
  completionWaitDefault: AdvisorWaitMode
  allowedTools: string[]
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  completionWait: AdvisorWaitMode
  escalationWaitOverride: InheritableWaitMode
  continuousWaitOverride: InheritableWaitMode
  completionWaitOverride: InheritableWaitMode
  triggers: Record<TriggerKind, TriState>
  coverage: AdvisorCoverageOverride
  defaultProfileId: string | null
  allowedProfileIds: string[]
  policyVersion: 2 | 3
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
  if (data.version !== undefined && data.version !== 2 && data.version !== 3) return DEFAULT_SESSION_OVERRIDE
  const wait = (value: unknown): InheritableWaitMode => typeof value === 'string' && isWaitMode(value) ? value : INHERIT
  const waits = { escalationWait: wait(data.escalationWait), continuousWait: wait(data.continuousWait) }
  const completionWait = data.completionWait === undefined ? {} : { completionWait: wait(data.completionWait) }
  const mode = typeof data.mode === 'string' && (ADVISOR_MODES as readonly string[]).includes(data.mode) ? { mode: data.mode as AdvisorMode } : {}
  const timeout = isAdvisorTimeout(data.timeoutMs) ? { timeoutMs: data.timeoutMs } : {}
  const triggers = parseTriggerOverrides(data.triggers)
  const coverage = parseCoverageOverride(data.coverage)
  const profiles = parseSessionProfiles(data)
  const version = (data.version === 3 || triggers !== undefined || coverage !== undefined || profiles !== undefined || data.completionWait !== undefined ? 3 : 2) as 2 | 3
  const extras = {
    ...(triggers ? { triggers } : {}),
    ...(coverage ? { coverage } : {}),
    ...(profiles ? { ...profiles } : {}),
    ...completionWait,
    version,
  }
  if (Array.isArray(data.allowTools) && Array.isArray(data.denyTools)) {
    const { version: _v, ...rest } = extras
    return { version, allowTools: normalizeToolList(data.allowTools), denyTools: normalizeToolList(data.denyTools), ...(data.inheritDefaultTools === false ? { inheritDefaultTools: false } : {}), ...waits, ...mode, ...timeout, ...rest }
  }
  if (data.version === undefined && typeof data.toolPreset === 'string') {
    if (data.toolPreset === INHERIT) { const { version: _v2, ...rest2 } = extras; return { ...DEFAULT_SESSION_OVERRIDE, ...waits, ...rest2, version } }
    const tools = data.toolPreset === 'custom' && Array.isArray(data.tools) ? normalizeToolList(data.tools) : Object.hasOwn(LEGACY_PRESETS, data.toolPreset) ? LEGACY_PRESETS[data.toolPreset] : undefined
    if (tools) { const { version: _v3, ...rest3 } = extras; return { version, inheritDefaultTools: false, allowTools: [...tools], denyTools: [], ...waits, ...rest3 } }
  }
  return DEFAULT_SESSION_OVERRIDE
}

function isTriState(value: unknown): value is TriState {
  return value === 'inherit' || value === 'on' || value === 'off'
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim().slice(0, 120)
  if (!name) return undefined
  return name
}

function cleanProfileId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim().slice(0, 64)
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return undefined
  return id
}

export function parseTriggerOverrides(value: unknown): TriggerOverrides | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  const out: TriggerOverrides = {}
  let found = false
  for (const key of TRIGGER_KINDS) {
    if (data[key] === undefined) continue
    if (!isTriState(data[key])) return undefined
    if ((data[key] as TriState) !== INHERIT) { (out as Record<string, TriState>)[key] = data[key] as TriState; found = true }
    else { (out as Record<string, TriState>)[key] = INHERIT; found = true }
  }
  if (!found) return undefined
  return out
}

export function parseCoverageOverride(value: unknown): AdvisorCoverageOverride | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  const out: AdvisorCoverageOverride = {}
  let found = false
  for (const scope of ['root', 'localSubagents'] as const) {
    const entry = (data as Record<string, unknown>)[scope]
    if (entry === undefined) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const scopeOut: TriggerOverrides = {}
    let scopeFound = false
    for (const key of TRIGGER_KINDS) {
      const raw = (entry as Record<string, unknown>)[key]
      if (raw === undefined) continue
      if (!isTriState(raw)) return undefined
      ;(scopeOut as Record<string, TriState>)[key] = raw as TriState
      scopeFound = true
    }
    if (scopeFound) { (out as Record<string, unknown>)[scope] = scopeOut; found = true }
  }
  if (data.maxDepth !== undefined) {
    if (typeof data.maxDepth !== 'number' || !Number.isSafeInteger(data.maxDepth) || data.maxDepth < -1 || data.maxDepth > 32) return undefined
    out.maxDepth = data.maxDepth; found = true
  }
  for (const key of ['includeLabels', 'excludeLabels'] as const) {
    const raw = (data as Record<string, unknown>)[key]
    if (raw === undefined) continue
    if (!Array.isArray(raw)) return undefined
    const labels: string[] = []
    for (const item of raw.slice(0, 32)) {
      const label = cleanLabel(item)
      if (label && !labels.includes(label)) labels.push(label)
    }
    ;(out as Record<string, unknown>)[key] = labels; found = true
  }
  if (!found) return undefined
  return out
}

function parseSessionProfiles(data: Record<string, unknown>): { defaultProfileId?: string | null; allowedProfileIds?: string[] } | undefined {
  let found = false
  const out: { defaultProfileId?: string | null; allowedProfileIds?: string[] } = {}
  if (data.defaultProfileId !== undefined) {
    if (data.defaultProfileId === null) { out.defaultProfileId = null; found = true }
    else {
      const id = cleanProfileId(data.defaultProfileId)
      if (data.defaultProfileId !== '' && !id) return undefined
      if (id) { out.defaultProfileId = id; found = true }
      else if (data.defaultProfileId === '') { out.defaultProfileId = null; found = true }
    }
  }
  if (data.allowedProfileIds !== undefined) {
    if (!Array.isArray(data.allowedProfileIds)) return undefined
    const ids: string[] = []
    for (const raw of data.allowedProfileIds.slice(0, 32)) {
      const id = cleanProfileId(raw)
      if (!id) return undefined
      if (!ids.includes(id)) ids.push(id)
    }
    out.allowedProfileIds = ids; found = true
  }
  return found ? out : undefined
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
  const triggers: Record<TriggerKind, TriState> = {
    manual: override.triggers?.manual ?? INHERIT,
    escalation: override.triggers?.escalation ?? INHERIT,
    completion: override.triggers?.completion ?? INHERIT,
    continuous: override.triggers?.continuous ?? INHERIT,
  }
  const coverage: AdvisorCoverageOverride = {
    ...(override.coverage?.root ? { root: { ...override.coverage.root } } : {}),
    ...(override.coverage?.localSubagents ? { localSubagents: { ...override.coverage.localSubagents } } : {}),
    ...(override.coverage?.maxDepth !== undefined ? { maxDepth: override.coverage.maxDepth } : {}),
    ...(override.coverage?.includeLabels ? { includeLabels: [...override.coverage.includeLabels] } : {}),
    ...(override.coverage?.excludeLabels ? { excludeLabels: [...override.coverage.excludeLabels] } : {}),
  }
  return {
    mode: override.mode ?? config.mode,
    timeoutMs: override.timeoutMs ?? config.timeoutMs,
    allowedTools: [...allowed].filter(name => !isReservedTool(name, config.capabilityAmplifierTools)),
    defaultEnabledTools: defaults,
    allowTools: normalizeToolList(override.allowTools),
    denyTools: normalizeToolList(override.denyTools),
    escalationWait: override.escalationWait === INHERIT ? config.escalationWait : override.escalationWait,
    continuousWait: override.continuousWait === INHERIT ? config.continuousWait : override.continuousWait,
    completionWait: (override.completionWait ?? INHERIT) === INHERIT ? (config as unknown as Record<string, unknown>).completionWait === 'background' ? 'background' as AdvisorWaitMode : 'block' as AdvisorWaitMode : (override.completionWait as AdvisorWaitMode),
    triggers,
    coverage,
    defaultProfileId: override.defaultProfileId ?? null,
    allowedProfileIds: override.allowedProfileIds ? [...override.allowedProfileIds] : [],
    overridden: override !== DEFAULT_SESSION_OVERRIDE,
    policyVersion: override.version ?? 2,
  }
}

/** Mode preset as trigger defaults: manual is on in every preset; escalation/continuous follow the mode. Completion is orthogonal (global coverage gates it). */
export function modeTriggerPreset(mode: AdvisorMode): Record<TriggerKind, boolean> {
  return { manual: true, escalation: mode === 'escalate', completion: true, continuous: mode === 'continuous' }
}

/** Resolve whether a trigger may run for a role, combining mode preset, session trigger override, global coverage and session coverage override. */
export function triggerEnabledForRole(config: Config, override: AdvisorSessionPolicyOverride, trigger: TriggerKind, role: 'root' | 'local-subagent'): boolean {
  const preset = modeTriggerPreset(override.mode ?? config.mode)[trigger]
  if (!preset) return false
  const sessionTrigger = override.triggers?.[trigger]
  if (sessionTrigger === 'off') return false
  if (sessionTrigger === 'on') {
    // Explicit session trigger-on still respects an explicit coverage off below.
  } else if (sessionTrigger === undefined || sessionTrigger === INHERIT) {
    // fall through to coverage checks
  }
  const global = globalTriggerCoverage(config, trigger, role)
  const sessionCoverage = (role === 'root' ? override.coverage?.root?.[trigger] : override.coverage?.localSubagents?.[trigger]) ?? INHERIT
  if (sessionTrigger === 'on' && sessionCoverage === 'off') return false
  if (sessionCoverage !== INHERIT) return sessionCoverage === 'on'
  if (sessionTrigger === 'on') return true
  return global
}

function globalTriggerCoverage(config: Config, trigger: TriggerKind, role: 'root' | 'local-subagent'): boolean {
  const root = role === 'root'
  if (trigger === 'manual') return root ? config.manualMainAgent : config.manualLocalSubagents
  if (trigger === 'escalation') return root ? config.escalationMainAgent : config.escalationLocalSubagents
  if (trigger === 'continuous') return root ? config.continuousMainAgent : config.continuousLocalSubagents
  const cfg = config as unknown as Record<string, unknown>
  if (trigger === 'completion') return root ? cfg.completionMainAgent === true : cfg.completionLocalSubagents === true
  return false
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
  return [`Advisor enabled tools: ${tools}`, `Escalation: ${effective.escalationWait}`, `Continuous: ${effective.continuousWait}`, `Completion: ${effective.completionWait}`, 'Use the Advisor header control to toggle individual tools, or /advisor catalog for JSON.'].join('\n')
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
    completionWaitDefault: (config as unknown as Record<string, unknown>).completionWait === 'background' ? 'background' : 'block',
    allowedTools,
    escalationWait: policy.escalationWait,
    continuousWait: policy.continuousWait,
    completionWait: policy.completionWait,
    escalationWaitOverride: sessionPolicyOverride(agent.session).escalationWait,
    continuousWaitOverride: sessionPolicyOverride(agent.session).continuousWait,
    completionWaitOverride: sessionPolicyOverride(agent.session).completionWait ?? INHERIT,
    triggers: { ...policy.triggers },
    coverage: JSON.parse(JSON.stringify(policy.coverage)) as AdvisorCoverageOverride,
    defaultProfileId: policy.defaultProfileId,
    allowedProfileIds: [...policy.allowedProfileIds],
    policyVersion: policy.policyVersion,
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
export function updateWaitOverride(session: Session, field: 'escalationWait' | 'continuousWait' | 'completionWait', value: string): void {
  if (!isWaitMode(value)) throw new Error('Expected inherit, block, or background.')
  append(session, { ...sessionPolicyOverride(session), [field]: value })
}

export function updateTriggerOverride(session: Session, trigger: TriggerKind, value: string): void {
  if (!(TRIGGER_KINDS as readonly string[]).includes(trigger)) throw new Error('Expected manual, escalation, completion, or continuous.')
  if (value !== INHERIT && value !== 'on' && value !== 'off') throw new Error('Expected inherit, on, or off.')
  const current = sessionPolicyOverride(session)
  const triggers = { ...(current.triggers ?? {}) } as TriggerOverrides
  if (value === INHERIT) delete triggers[trigger]
  else triggers[trigger] = value as TriState
  const next = { ...current, version: 3 as const } as AdvisorSessionPolicyOverride
  if (Object.keys(triggers).length > 0) next.triggers = triggers
  else delete (next as unknown as Record<string, unknown>).triggers
  append(session, next)
}

export function updateCoverageOverride(session: Session, coverage: AdvisorCoverageOverride): void {
  const parsed = parseCoverageOverride(coverage)
  const current = sessionPolicyOverride(session)
  const next = { ...current, version: 3 as const } as AdvisorSessionPolicyOverride
  if (parsed) next.coverage = parsed
  else delete (next as unknown as Record<string, unknown>).coverage
  append(session, next)
}

export function updateSessionProfiles(session: Session, selection: { defaultProfileId?: string | null; allowedProfileIds?: string[] }): void {
  const current = sessionPolicyOverride(session)
  const next = { ...current, version: 3 as const } as AdvisorSessionPolicyOverride
  if (selection.defaultProfileId !== undefined) {
    if (selection.defaultProfileId === null) delete (next as unknown as Record<string, unknown>).defaultProfileId
    else next.defaultProfileId = selection.defaultProfileId
  }
  if (selection.allowedProfileIds !== undefined) next.allowedProfileIds = [...selection.allowedProfileIds]
  append(session, next)
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
  const waitCommand = (name: 'advisor-escalation-wait' | 'advisor-continuous-wait' | 'advisor-completion-wait', field: 'escalationWait' | 'continuousWait' | 'completionWait', description: string): void => {
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
  waitCommand('advisor-completion-wait', 'completionWait', 'Choose whether completion review pauses this session for Advisor review')
  commandCtx.commands.register({
    name: 'advisor-trigger', description: 'Override one Advisor trigger for this session', input: { hint: '<manual|escalation|completion|continuous> <on|off|inherit>' },
    handler: ({ agent, rawInput }) => {
      const rejected = requireRoot(agent); if (rejected) return rejected
      const match = rawInput.trim().match(/^(manual|escalation|completion|continuous)\s+(on|off|inherit)$/)
      if (!match) return { kind: 'error' as const, text: 'Expected: /advisor-trigger <manual|escalation|completion|continuous> <on|off|inherit>' }
      try {
        updateTriggerOverride(agent.session, match[1] as TriggerKind, match[2]!)
      } catch (error) { return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) } }
      return { kind: 'success' as const, text: JSON.stringify(catalogFor(currentConfig(), agent)) }
    },
  })
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
