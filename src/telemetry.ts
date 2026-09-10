import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AdvisorSeverity } from './config.js'

export type ConsultationMode = 'manual' | 'escalation' | 'continuous'
export interface AdvisorRunRecord {
  version: 1
  id: string
  requesterId: string
  mode: ConsultationMode
  turn: number
  step?: number
  taskRevision: string
  fingerprint?: string
  score?: number
  attempt: number
  status: 'reserved' | 'started' | 'delivered' | 'stale' | 'failed-transient' | 'failed-permanent' | 'cancelled' | 'skipped'
  timestamp: string
  childSessionId?: string
  severity?: AdvisorSeverity
  summary?: string
  question?: string
  responseText?: string
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
  verdictTool?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'advisor/run': AdvisorRunRecord }
}

export function recordRun(requester: Agent, root: Agent, record: AdvisorRunRecord): void {
  requester.session.append('advisor/run', { ...record })
  if (root !== requester) root.session.append('advisor/run', { ...record })
}

export function advisorRunHistory(root: Agent): AdvisorRunRecord[] {
  const runs = new Map<string, AdvisorRunRecord>()
  for (const event of root.session.snapshotEvents()) if (event.type === 'advisor/run' && event.data?.version === 1) runs.set(event.data.id + ':' + event.data.attempt, event.data)
  return [...runs.values()].slice(-100)
}
