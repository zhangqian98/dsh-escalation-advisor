import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AdvisorSeverity } from './config.js'

export type ConsultationMode = 'manual' | 'escalation' | 'continuous' | 'completion'
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
  /** This attempt's verdict-channel identity (unique per consultation turn). */
  collectorId?: string
  /** Consultation turn index this attempt belongs to (1-based); lets a restore continue counting. */
  turns?: number
  /** The task root's latest user-message seq at dispatch: the durable task anchor a restored continuation is checked against. */
  /** The task root's latest user-message seq at dispatch: the durable task anchor a restored continuation is checked against. */
  taskAnchor?: number
  /** Pinned consultation snapshot: first-turn model route, profile and tool ceiling. */
  provider?: string
  model?: string
  reasoningEffort?: string
  advisorProfile?: string
  /** Sorted pinned tool ceiling (first-turn allowedTools). */
  toolCeiling?: string[]
  /** Hash of the pinned tool ceiling for UI/audit comparison. */
  toolSnapshotHash?: string
  /** Why this profile/route was chosen (explicit, trigger route, default, legacy). */
  routingReason?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'advisor/run': AdvisorRunRecord }
}

export function recordRun(requester: Agent, root: Agent, record: AdvisorRunRecord): void {
  requester.session.append('advisor/run', { ...record })
  if (root !== requester) root.session.append('advisor/run', { ...record })
}

export function advisorRunHistory(root: Agent): AdvisorRunRecord[] {
  // Attempts restart at 1 for every consultation turn on the same id, so a
  // later failed attempt must never erase an earlier delivery of the same
  // consultation (consultation restore and the UI both key off delivered runs).
  const runs = new Map<string, AdvisorRunRecord>()
  for (const event of root.session.snapshotEvents()) {
    if (event.type !== 'advisor/run' || event.data?.version !== 1) continue
    // Keyed by consultation turn (attempt numbers restart on every follow-up call),
    // so successive turns never collapse into one row. Within a turn, status
    // progression still replaces, but a delivery is never erased by a later miss.
    const key = event.data.id + ':' + (event.data.collectorId ?? event.data.attempt)
    const current = runs.get(key)
    // Status progression replaces (reserved -> started -> terminal), but a later
    // failed attempt on the same consultation must never erase its delivery.
    if (current === undefined || current.status !== 'delivered') runs.set(key, event.data)
  }
  return [...runs.values()].slice(-100)
}

/**
 * The stable identity of ONE consultation-turn row for snapshots, review
 * lookups, and UI keys: the per-attempt collector identity when the record
 * carries one, else a best-effort key for history written before collector
 * ids existed. `id` alone names the whole conversation and `attempt` restarts
 * on every follow-up call, so neither can name a row on its own.
 */
export function advisorRunKey(run: AdvisorRunRecord): string {
  return run.collectorId ?? `${run.id}:${run.turn}:${run.attempt}:${run.timestamp}`
}