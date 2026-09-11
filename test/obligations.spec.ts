import { describe, expect, it } from 'vitest'
import { MAX_AUTO_REMINDERS_PER_TASK, ObligationStore, opensObligation, type ValidationRun } from '../src/obligations.js'

const base = { sessionId: 's1', taskStartSeq: 100, scope: 'task:s1:100' }

function failure(store: ObligationStore, seq: number, validationKey?: string, summary = 'auth test failed') {
  return store.recordFailure({ ...base, seq, at: seq * 1000, ...(validationKey ? { validationKey } : {}), summary })
}

function run(overrides: Partial<ValidationRun> & { completedSeq: number }): ValidationRun {
  return { ...base, validationKey: 'k-auth', callId: 'call-x', succeeded: true, ...overrides }
}

describe('ObligationStore', () => {
  it('opens only for a definite validation failure', () => {
    expect(opensObligation('validation-failure')).toBe(true)
    for (const outcome of ['unknown-failure', 'expected-negative', 'cancelled', 'permission-denial', 'timeout', 'tool-infrastructure-error', 'success']) {
      expect(opensObligation(outcome)).toBe(false)
    }
  })

  it('keeps an obligation open when only a mechanism explanation follows', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    // The incident: an explanation that fully accounts for the observation, with
    // no verification witness, must leave the item open.
    expect(item.state).toBe('open')
    expect(store.open('s1', 100)).toHaveLength(1)
  })

  it('deduplicates a recurrence onto the same obligation', () => {
    const store = new ObligationStore()
    const first = failure(store, 10, 'k-auth')
    const again = failure(store, 40, 'k-auth')
    expect(again.id).toBe(first.id)
    expect(again.repeatCount).toBe(2)
    expect(store.list('s1', 100)).toHaveLength(1)
  })

  it('closes on a later success with the same key and scope', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    const resolved = store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.resolution?.kind).toBe('reverified')
  })

  it('does not let an early success close a later failure', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    failure(store, 60, 'k-auth')
    // A pass that predates the latest failure proves nothing about it.
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))).toHaveLength(0)
    expect(store.open('s1', 100)).toHaveLength(1)
  })

  it('does not close on a different validation key, scope, task or session', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25, validationKey: 'k-other' }))).toHaveLength(0)
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25, scope: 'task:other' }))).toHaveLength(0)
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25, taskStartSeq: 999 }))).toHaveLength(0)
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25, sessionId: 's2' }))).toHaveLength(0)
    expect(store.open('s1', 100)).toHaveLength(1)
  })

  it('does not close on a failing run', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25, succeeded: false }))).toHaveLength(0)
  })

  it('does not close without a dispatch start boundary', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    // Lost dispatch metadata leaves the execution window unknown, so a change
    // during the run cannot be excluded and nothing may close.
    expect(store.recordValidation(run({ completedSeq: 25 }))).toHaveLength(0)
    expect(item.state).toBe('open')
  })

  it('does not close when a related change happened during execution', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    store.recordMutation({ ...base, seq: 22, applied: true })
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))).toHaveLength(0)
  })

  it('does not close when an uncertain mutation may have written', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    store.recordMutation({ ...base, seq: 22, applied: false })
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))).toHaveLength(0)
  })

  it('does not close when a change lands after the pass but before closure', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    store.recordMutation({ ...base, seq: 30, applied: true })
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))).toHaveLength(0)
  })

  it('reopens a resolved obligation when a related change follows', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))
    expect(item.state).toBe('resolved')
    store.recordMutation({ ...base, seq: 40, applied: true })
    expect(item.state).toBe('open')
    expect(item.resolution).toBeUndefined()
  })

  it('never auto-closes a keyless obligation', () => {
    const store = new ObligationStore()
    const item = failure(store, 10)
    expect(item.validationKey).toBeUndefined()
    expect(store.recordValidation(run({ validationKey: 'k-auth', startedSeq: 20, completedSeq: 25 }))).toHaveLength(0)
    expect(item.state).toBe('open')
  })

  it('merges keyless failures into one task-level item', () => {
    const store = new ObligationStore()
    const first = failure(store, 10)
    const second = failure(store, 20)
    expect(second.id).toBe(first.id)
    expect(store.list('s1', 100)).toHaveLength(1)
  })

  it('does not merge different claims', () => {
    const store = new ObligationStore()
    const a = store.recordClaimContradiction({ ...base, seq: 10, at: 1000, claimId: 'claim-a', summary: 'a' })
    const b = store.recordClaimContradiction({ ...base, seq: 11, at: 1100, claimId: 'claim-b', summary: 'b' })
    expect(a.id).not.toBe(b.id)
    expect(store.open('s1', 100)).toHaveLength(2)
  })

  it('requires both a witness and a correction for a contradicted claim', () => {
    const store = new ObligationStore()
    const item = store.recordClaimContradiction({ ...base, seq: 10, at: 1000, claimId: 'claim-a', summary: 'trigger-related failures are never evicted', validationKey: 'k-auth' })
    // A correction alone cannot resolve it.
    store.recordCorrection('s1', 100, item.id, { claimId: 'claim-a', document: 'README.md', change: 'narrowed', evidence: 'packet 1cfe2dfc', at: 2000, seq: 20 })
    expect(item.state).toBe('open')
    // With the correction in place, a usable witness resolves it.
    expect(store.recordValidation(run({ startedSeq: 30, completedSeq: 35 }))).toHaveLength(1)
    expect(item.resolution?.kind).toBe('reverified-and-corrected')
  })

  it('does not close a contradicted claim on a witness alone', () => {
    const store = new ObligationStore()
    const item = store.recordClaimContradiction({ ...base, seq: 10, at: 1000, claimId: 'claim-b', summary: 'a published claim', validationKey: 'k-auth' })
    expect(store.recordValidation(run({ startedSeq: 20, completedSeq: 25 }))).toHaveLength(0)
    expect(item.state).toBe('open')
  })

  it('rejects a correction that names a different claim', () => {
    const store = new ObligationStore()
    const item = store.recordClaimContradiction({ ...base, seq: 10, at: 1000, claimId: 'claim-a', summary: 'a', validationKey: 'k-auth' })
    expect(store.recordCorrection('s1', 100, item.id, { claimId: 'claim-b', document: 'd', change: 'c', evidence: 'e', at: 1, seq: 11 })).toBeUndefined()
    expect(item.correction).toBeUndefined()
  })

  it('never resolves through disposition', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    store.recordDisposition('s1', 100, item.id, { kind: 'accept-risk', basis: 'accepted for this run', at: 2000, seq: 20 })
    expect(item.state).toBe('open')
    expect(item.disposition?.kind).toBe('accept-risk')
  })

  it('keeps the auto-continuation budget fixed per task regardless of repeats', () => {
    const store = new ObligationStore()
    let granted = 0
    // Repeats and reminders must not extend the budget.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      failure(store, 10 + attempt, 'k-auth')
      if (store.consumeReminder('s1', 100)) granted += 1
    }
    expect(granted).toBe(MAX_AUTO_REMINDERS_PER_TASK)
    expect(store.remindersUsed('s1', 100)).toBe(MAX_AUTO_REMINDERS_PER_TASK)
    // Exhaustion stops reminders but never hides or closes the record.
    expect(store.open('s1', 100)).toHaveLength(1)
  })

  it('counts the budget per task, not per obligation', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-a')
    failure(store, 11, 'k-b')
    expect(store.consumeReminder('s1', 100)).toBe(true)
    expect(store.consumeReminder('s1', 100)).toBe(true)
    expect(store.consumeReminder('s1', 100)).toBe(true)
    expect(store.consumeReminder('s1', 100)).toBe(false)
  })

  it('injects an item once per revision and reminds once per revision', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    expect(store.pendingInjection('s1', 100).map(entry => entry.id)).toEqual([item.id])
    expect(store.pendingInjection('s1', 100)).toHaveLength(0)
    expect(store.pendingReminder('s1', 100)).toHaveLength(1)
    store.markReminded(item)
    expect(store.pendingReminder('s1', 100)).toHaveLength(0)
    // A material change makes it due again, without inflating the task budget.
    failure(store, 40, 'k-auth')
    expect(store.pendingInjection('s1', 100)).toHaveLength(1)
    expect(store.pendingReminder('s1', 100)).toHaveLength(1)
    expect(store.remindersUsed('s1', 100)).toBe(0)
  })

  it('does not re-arm attention for a disposition, but does for later evidence', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    store.markReminded(item)
    expect(store.pendingReminder('s1', 100)).toHaveLength(0)

    // Recording a disposition is a RECORD, not new evidence. If it re-armed
    // attention, the same full text would be read out again every time one is
    // written - which is exactly the repetition this is meant to stop.
    store.recordDisposition('s1', 100, item.id, { kind: 'not-applicable', basis: 'measured against the artifact', at: 11_000, seq: 11 })
    expect(store.pendingReminder('s1', 100)).toHaveLength(0)
    // Suppressing the repetition is NOT closing anything: the item stays open and
    // counted, so a later reader still sees it.
    expect(store.open('s1', 100)).toHaveLength(1)
    expect(store.open('s1', 100)[0]?.state).toBe('open')

    // Later evidence moves the revision PAST the disposition, which re-arms
    // attention on its own - the anti-burial direction is untouched.
    failure(store, 40, 'k-auth')
    const due = store.pendingReminder('s1', 100)
    expect(due).toHaveLength(1)
    expect(due[0]?.dispositionRevision).toBeLessThan(due[0]?.revision ?? 0)
    expect(store.remindersUsed('s1', 100)).toBe(0)
  })

  it('keeps a dispositioned item visible and counted after suppression', () => {
    const store = new ObligationStore()
    const item = failure(store, 10, 'k-auth')
    store.recordDisposition('s1', 100, item.id, { kind: 'accept-risk', basis: 'operator accepted the residual risk', at: 11_000, seq: 11 })
    expect(store.open('s1', 100).map(entry => entry.id)).toEqual([item.id])
    expect(store.list('s1', 100)[0]).toMatchObject({ state: 'open', disposition: { kind: 'accept-risk' } })
    // Only a witness closes; a disposition never does.
    expect(store.open('s1', 100)).toHaveLength(1)
  })

  it('reports nothing for a task it never observed', () => {
    const store = new ObligationStore()
    failure(store, 10, 'k-auth')
    expect(store.list('s1', 500)).toHaveLength(0)
    expect(store.list('other', 100)).toHaveLength(0)
  })
})
