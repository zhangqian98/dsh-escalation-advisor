import type { Config } from './config.js'
import type { AdvisorSessionPolicyOverride } from './policy.js'
import { triggerEnabledForRole } from './policy.js'

export type AdvisorAgentRole = 'root' | 'local-subagent' | 'advisor'
export type AdvisorCoverageKind = 'manual' | 'escalation' | 'continuous' | 'completion'

export function coverageEnabled(config: Config, kind: AdvisorCoverageKind, role: AdvisorAgentRole): boolean {
  if (role === 'advisor') return false
  if (kind === 'manual') return role === 'root' ? config.manualMainAgent : config.manualLocalSubagents
  if (kind === 'escalation') return role === 'root' ? config.escalationMainAgent : config.escalationLocalSubagents
  if (kind === 'completion') {
    const cfg = config as unknown as Record<string, unknown>
    return role === 'root' ? cfg.completionMainAgent === true : cfg.completionLocalSubagents === true
  }
  return role === 'root' ? config.continuousMainAgent : config.continuousLocalSubagents
}

/** Session-aware coverage: global switch ANDed with v3 session trigger/coverage overrides. Advisor role is always excluded. */
export function coverageEnabledForSession(args: {
  config: Config
  override: AdvisorSessionPolicyOverride
  kind: Exclude<AdvisorCoverageKind, 'completion'> | 'completion'
  role: AdvisorAgentRole
}): boolean {
  if (args.role === 'advisor') return false
  const role = args.role === 'root' ? 'root' as const : 'local-subagent' as const
  const trigger = args.kind === 'manual' ? 'manual' as const : args.kind === 'escalation' ? 'escalation' as const : args.kind === 'completion' ? 'completion' as const : 'continuous' as const
  return triggerEnabledForRole(args.config, args.override, trigger, role)
}

/** Subagent depth/label scope: global maxDepth + include/exclude lists, narrowed by session coverage override. */
export function subagentInScope(args: {
  config: Config
  override: AdvisorSessionPolicyOverride
  depth: number
  label?: string
}): boolean {
  const cfg = args.config as unknown as { localSubagentMaxDepth?: number; includeSubagentLabels?: string[]; excludeSubagentLabels?: string[] }
  const maxDepth = args.override.coverage?.maxDepth ?? cfg.localSubagentMaxDepth ?? -1
  if (maxDepth >= 0 && args.depth > maxDepth) return false
  const include = args.override.coverage?.includeLabels ?? cfg.includeSubagentLabels ?? []
  const exclude = args.override.coverage?.excludeLabels ?? cfg.excludeSubagentLabels ?? []
  const label = (args.label ?? '').trim()
  if (exclude.some(entry => entry === label || (label !== '' && label.includes(entry)))) return false
  if (include.length > 0) {
    if (!label) return false
    if (!include.some(entry => entry === label || label.includes(entry))) return false
  }
  return true
}
