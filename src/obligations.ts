import { createHash } from 'node:crypto'

/**
 * Verification obligations.
 *
 * A failure that is not explainable by the task itself leaves an open item that
 * survives budget exhaustion, score clearing and cooldown, and can only be
 * resolved by a witness that is later than the LATEST failure, in the same
 * scope, with no related mutation after it.
 *
 * v1 scope (approved): runtime-only storage, two states, narrow trigger. The
 * store keeps no history and deliberately reports an empty list after a
 * restart, which callers must surface verbatim rather than as "all clear".
 */

export type ObligationKind = 'validation-failure' | 'claim-contradicted'
export type ObligationState = 'open' | 'resolved'

/** Fixed per-task cap on auto-appended turns. Independent of obligation version. */
export const MAX_AUTO_REMINDERS_PER_TASK = 3

/**
 * v1 trigger is deliberately narrow: only a definite validation failure opens an
 * obligation. An unknown failure keeps its existing diagnosis, and the excluded
 * classes are never read as "the published conclusion was overturned".
 */
export function opensObligation(outcomeClass: string): boolean {
  return outcomeClass === 'validation-failure'
}

/** A failed or cancelled mutation may still have written; only success is trusted. */
export interface MutationEvent {
  sessionId: string
  taskStartSeq: number
  scope: string
  seq: number
  applied: boolean
}

export interface ValidationRun {
  sessionId: string
  taskStartSeq: number
  scope: string
  validationKey: string
  callId: string
  /** Dispatch seq, or undefined when dispatch metadata was lost: then nothing may close. */
  startedSeq?: number
  completedSeq: number
  succeeded: boolean
}

export interface Disposition {
  kind: 'not-applicable' | 'accept-risk'
  basis: string
  at: number
  seq: number
}

export interface Correction {
  claimId: string
  document: string
  change: string
  evidence: string
  at: number
  seq: number
}

export interface Resolution {
  kind: 'reverified' | 'reverified-and-corrected'
  at: number
  seq: number
  witnessCallId?: string
}

export interface Obligation {
  version: 1
  id: string
  kind: ObligationKind
  state: ObligationState
  sessionId: string
  taskStartSeq: number
  scope: string
  validationKey?: string
  claimId?: string
  summary: string
  createdAt: number
  createdAtSeq: number
  /** Closure must be later than this, not later than the first failure. */
  latestFailureSeq: number
  repeatCount: number
  /** Bumped on every material change; drives bounded injection and reminders. */
  revision: number
  injectedRevision: number
  remindedRevision: number
  disposition?: Disposition
  correction?: Correction
  resolution?: Resolution
}

export interface FailureInput {
  sessionId: string
  taskStartSeq: number
  scope: string
  seq: number
  at: number
  callId?: string
  validationKey?: string
  summary: string
}

export interface ClaimInput {
  sessionId: string
  taskStartSeq: number
  scope: string
  seq: number
  at: number
  claimId: string
  summary: string
  validationKey?: string
}

const KEYLESS = '\u0000keyless'

function taskKey(sessionId: string, taskStartSeq: number): string {
  return `${sessionId}|${taskStartSeq}`
}

function identity(input: { kind: ObligationKind; validationKey?: string; claimId?: string }): string {
  if (input.kind === 'claim-contradicted') return `claim|${input.claimId ?? KEYLESS}`
  return `validation|${input.validationKey ?? KEYLESS}`
}

function shortId(seed: string): string {
  return 'R' + createHash('sha256').update(seed).digest('hex').slice(0, 6)
}

/**
 * Both halves of the claim-contradicted requirement must hold: a usable
 * verification witness AND a correction record. A correction alone never
 * closes, and an obligation without a validation key stays open by design.
 */
function witnessFor(obligation: Obligation, run: ValidationRun, mutations: readonly MutationEvent[]): boolean {
  if (obligation.state !== 'open') return false
  if (!obligation.validationKey) return false
  if (!run.succeeded) return false
  // Without a trustworthy start boundary the execution window is unknown, so a
  // change during the run cannot be excluded.
  if (run.startedSeq === undefined) return false
  // Narrowed once: TypeScript drops the narrowing inside the predicates below.
  const startedSeq: number = run.startedSeq
  if (run.sessionId !== obligation.sessionId) return false
  if (run.taskStartSeq !== obligation.taskStartSeq) return false
  if (run.scope !== obligation.scope) return false
  if (run.validationKey !== obligation.validationKey) return false
  if (run.startedSeq <= obligation.latestFailureSeq) return false
  if (run.completedSeq <= obligation.latestFailureSeq) return false
  // A related change during execution, or after the pass but before closure,
  // makes the witness stale.
  if (mutations.some(m => m.scope === obligation.scope && m.seq >= startedSeq && m.seq <= run.completedSeq)) return false
  if (mutations.some(m => m.scope === obligation.scope && m.seq > run.completedSeq)) return false
  return true
}

export class ObligationStore {
  private readonly items = new Map<string, Obligation>()
  private readonly mutations = new Map<string, MutationEvent[]>()
  private readonly reminders = new Map<string, number>()

  private mutationsFor(sessionId: string, taskStartSeq: number): MutationEvent[] {
    const key = taskKey(sessionId, taskStartSeq)
    let list = this.mutations.get(key)
    if (!list) { list = []; this.mutations.set(key, list) }
    return list
  }

  /** Auto-continuation budget is per task and is never reset by reminder content. */
  remindersUsed(sessionId: string, taskStartSeq: number): number {
    return this.reminders.get(taskKey(sessionId, taskStartSeq)) ?? 0
  }

  consumeReminder(sessionId: string, taskStartSeq: number): boolean {
    const key = taskKey(sessionId, taskStartSeq)
    const used = this.reminders.get(key) ?? 0
    if (used >= MAX_AUTO_REMINDERS_PER_TASK) return false
    this.reminders.set(key, used + 1)
    return true
  }

  list(sessionId: string, taskStartSeq: number): Obligation[] {
    return [...this.items.values()].filter(item => item.sessionId === sessionId && item.taskStartSeq === taskStartSeq)
  }

  open(sessionId: string, taskStartSeq: number): Obligation[] {
    return this.list(sessionId, taskStartSeq).filter(item => item.state === 'open')
  }

  /** Open items whose content changed since the last injection, marked as injected. */
  pendingInjection(sessionId: string, taskStartSeq: number): Obligation[] {
    const due = this.open(sessionId, taskStartSeq).filter(item => item.revision > item.injectedRevision)
    for (const item of due) item.injectedRevision = item.revision
    return due
  }

  /** At most one reminder per obligation revision; the task budget is separate. */
  pendingReminder(sessionId: string, taskStartSeq: number): Obligation[] {
    return this.open(sessionId, taskStartSeq).filter(item => item.revision > item.remindedRevision)
  }

  markReminded(obligation: Obligation): void {
    obligation.remindedRevision = obligation.revision
  }

  /** Only a definite validation failure opens an obligation. */
  recordFailure(input: FailureInput): Obligation {
    return this.upsert({
      kind: 'validation-failure', sessionId: input.sessionId, taskStartSeq: input.taskStartSeq, scope: input.scope,
      validationKey: input.validationKey, summary: input.summary, seq: input.seq, at: input.at,
    })
  }

  /** A published claim contradicted by a counterexample needs an explicit entry point. */
  recordClaimContradiction(input: ClaimInput): Obligation {
    return this.upsert({
      kind: 'claim-contradicted', sessionId: input.sessionId, taskStartSeq: input.taskStartSeq, scope: input.scope,
      validationKey: input.validationKey, claimId: input.claimId, summary: input.summary, seq: input.seq, at: input.at,
    })
  }

  private upsert(input: {
    kind: ObligationKind; sessionId: string; taskStartSeq: number; scope: string
    validationKey?: string; claimId?: string; summary: string; seq: number; at: number
  }): Obligation {
    const key = `${taskKey(input.sessionId, input.taskStartSeq)}|${identity(input)}`
    const existing = this.items.get(key)
    if (existing) {
      // A recurrence reopens the same obligation rather than forking a new one.
      existing.state = 'open'
      existing.resolution = undefined
      existing.latestFailureSeq = Math.max(existing.latestFailureSeq, input.seq)
      existing.repeatCount += 1
      existing.revision += 1
      existing.summary = input.summary
      return existing
    }
    const created: Obligation = {
      version: 1,
      id: shortId(`${key}|${input.seq}`),
      kind: input.kind,
      state: 'open',
      sessionId: input.sessionId,
      taskStartSeq: input.taskStartSeq,
      scope: input.scope,
      ...(input.validationKey ? { validationKey: input.validationKey } : {}),
      ...(input.claimId ? { claimId: input.claimId } : {}),
      summary: input.summary,
      createdAt: input.at,
      createdAtSeq: input.seq,
      latestFailureSeq: input.seq,
      repeatCount: 1,
      revision: 1,
      injectedRevision: 0,
      remindedRevision: 0,
    }
    this.items.set(key, created)
    return created
  }

  recordMutation(event: MutationEvent): void {
    const list = this.mutationsFor(event.sessionId, event.taskStartSeq)
    list.push({ ...event })
    // A related change after a resolution makes that evidence stale.
    for (const item of this.list(event.sessionId, event.taskStartSeq)) {
      if (item.state !== 'resolved') continue
      if (item.scope !== event.scope) continue
      if ((item.resolution?.seq ?? -1) < event.seq) { item.state = 'open'; item.resolution = undefined; item.revision += 1 }
    }
  }

  /** Returns the obligations this run resolved. */
  recordValidation(run: ValidationRun): Obligation[] {
    const resolved: Obligation[] = []
    const mutations = this.mutationsFor(run.sessionId, run.taskStartSeq)
    for (const item of this.list(run.sessionId, run.taskStartSeq)) {
      if (!witnessFor(item, run, mutations)) continue
      // claim-contradicted additionally requires a correction record.
      if (item.kind === 'claim-contradicted' && !item.correction) continue
      item.state = 'resolved'
      item.resolution = {
        kind: item.correction ? 'reverified-and-corrected' : 'reverified',
        at: run.completedSeq, seq: run.completedSeq, witnessCallId: run.callId,
      }
      item.revision += 1
      resolved.push(item)
    }
    return resolved
  }

  /** Records not-applicable or accept-risk. Never resolves anything. */
  recordDisposition(sessionId: string, taskStartSeq: number, id: string, disposition: Disposition): Obligation | undefined {
    const item = this.list(sessionId, taskStartSeq).find(candidate => candidate.id === id)
    if (!item) return undefined
    item.disposition = { ...disposition }
    item.revision += 1
    return item
  }

  /** Records a correction. Never resolves anything on its own. */
  recordCorrection(sessionId: string, taskStartSeq: number, id: string, correction: Correction): Obligation | undefined {
    const item = this.list(sessionId, taskStartSeq).find(candidate => candidate.id === id)
    if (!item) return undefined
    if (item.claimId && correction.claimId !== item.claimId) return undefined
    item.correction = { ...correction }
    item.revision += 1
    return item
  }

  clear(sessionId: string): void {
    for (const [key, item] of [...this.items]) if (item.sessionId === sessionId) this.items.delete(key)
    for (const key of [...this.mutations.keys()]) if (key.startsWith(sessionId + '|')) this.mutations.delete(key)
    for (const key of [...this.reminders.keys()]) if (key.startsWith(sessionId + '|')) this.reminders.delete(key)
  }
}
