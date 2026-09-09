import type { Config } from './config.js'

export type AdvisorAgentRole = 'root' | 'local-subagent' | 'advisor'
export type AdvisorCoverageKind = 'manual' | 'escalation' | 'continuous'

export function coverageEnabled(config: Config, kind: AdvisorCoverageKind, role: AdvisorAgentRole): boolean {
  if (role === 'advisor') return false
  if (kind === 'manual') return role === 'root' ? config.manualMainAgent : config.manualLocalSubagents
  if (kind === 'escalation') return role === 'root' ? config.escalationMainAgent : config.escalationLocalSubagents
  return role === 'root' ? config.continuousMainAgent : config.continuousLocalSubagents
}
