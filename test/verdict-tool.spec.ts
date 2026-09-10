import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AdvisorVerdictCollector } from '../src/verdict-tool.js'
import { verdictFromStructured, type AdvisorVerdict } from '../src/verdict.js'

/**
 * A verdict is only a candidate until it is reconciled with a verified terminal
 * outcome. These tests pin that contract: a valid submission alone must never
 * become a published review, and every way of failing to prove the turn closed
 * must leave the consultation unpublished.
 */

function verdict(summary = 'Independent review'): AdvisorVerdict {
  return verdictFromStructured({
    severity: 'concern', disposition: 'revise', summary, diagnosis: 'diagnosis',
    next_actions: [], evidence_used: [], assumptions: [], recommended_next_action: '',
    validation_plan: [], needs_more_evidence: false, confidence: 0.9, changes_made: [],
  })
}

function advisorChild(id: string, turn = 1, seq = 10): Agent {
  return {
    id,
    session: { seq, snapshotEvents: () => [{ type: 'step/start', seq: 9, data: { turn, step: 1 } }] },
  } as unknown as Agent
}

const identity = { invocationId: 'inv-1', requesterId: 'root-1' }

function opened() {
  const collector = new AdvisorVerdictCollector()
  collector.open({ id: 'c-1', invocationId: identity.invocationId, requesterId: identity.requesterId, rootId: 'root-1' })
  collector.bind('c-1', 'advisor-1')
  return collector
}

const closedTurn = { stopReason: 'completed', turnEnd: { seq: 20, kind: 'completed' } }

describe('Advisor verdict channel', () => {
  it('publishes exactly once for a valid submission with a verified closing turn', () => {
    const collector = opened()
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict())).toBe('accepted')
    const first = collector.reconcile('c-1', closedTurn)
    expect(first.published).toBe(true)
    if (first.published) expect(first.verdict.summary).toBe('Independent review')
    expect(collector.reconcile('c-1', closedTurn)).toEqual({ published: false, reason: 'Consultation already published.' })
  })

  it('does not publish a run that never called the verdict tool', () => {
    const collector = opened()
    expect(collector.reconcile('c-1', closedTurn)).toEqual({ published: false, reason: 'The Advisor returned no verdict tool call.' })
  })

  it('does not publish when the run did not complete', () => {
    const collector = opened()
    collector.submit(advisorChild('advisor-1'), identity, verdict())
    expect(collector.reconcile('c-1', { stopReason: 'error', turnEnd: closedTurn.turnEnd }).published).toBe(false)
  })

  it('does not publish without a closing turn boundary in the session', () => {
    const collector = opened()
    collector.submit(advisorChild('advisor-1'), identity, verdict())
    expect(collector.reconcile('c-1', { stopReason: 'completed' }).published).toBe(false)
  })

  it('does not publish when the closing boundary predates the submission', () => {
    const collector = opened()
    collector.submit(advisorChild('advisor-1', 1, 30), identity, verdict())
    const stale = collector.reconcile('c-1', { stopReason: 'completed', turnEnd: { seq: 20, kind: 'completed' } })
    expect(stale).toEqual({ published: false, reason: 'The closing turn boundary predates the submitted verdict.' })
  })

  it('does not publish when the turn closed for another reason', () => {
    const collector = opened()
    collector.submit(advisorChild('advisor-1'), identity, verdict())
    const failed = collector.reconcile('c-1', { stopReason: 'completed', turnEnd: { seq: 20, kind: 'error' } })
    expect(failed).toEqual({ published: false, reason: 'The Advisor turn closed with error.' })
  })

  it('keeps the first verdict and refuses a conflicting second submission', () => {
    const collector = opened()
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict('first'))).toBe('accepted')
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict('second'))).toBe('conflicting')
    const published = collector.reconcile('c-1', closedTurn)
    expect(published.published).toBe(true)
    if (published.published) expect(published.verdict.summary).toBe('first')
  })

  it('treats an identical repeated submission as a duplicate rather than a conflict', () => {
    const collector = opened()
    collector.submit(advisorChild('advisor-1'), identity, verdict('same'))
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict('same'))).toBe('duplicate')
  })

  it('refuses a submission from a session with no consultation', () => {
    const collector = opened()
    expect(collector.submit(advisorChild('other-child'), identity, verdict())).toBe('unmatched')
  })

  it('refuses a submission whose identity does not match the consultation', () => {
    const collector = opened()
    expect(collector.submit(advisorChild('advisor-1'), { invocationId: 'other', requesterId: 'root-1' }, verdict())).toBe('unauthorized')
    expect(collector.submit(advisorChild('advisor-1'), { invocationId: 'inv-1', requesterId: 'other-root' }, verdict())).toBe('unauthorized')
  })

  it('refuses a late submission once the consultation is closed', () => {
    const collector = opened()
    collector.invalidate('c-1', 'run ended')
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict())).toBe('closed')
    expect(collector.reconcile('c-1', closedTurn).published).toBe(false)
  })

  it('refuses a late submission after publication', () => {
    const collector = opened()
    collector.submit(advisorChild('advisor-1'), identity, verdict())
    collector.reconcile('c-1', closedTurn)
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict('later'))).toBe('closed')
  })

  it('drops the child index when a consultation is released', () => {
    const collector = opened()
    collector.release('c-1')
    expect(collector.forChild('advisor-1')).toBeUndefined()
    expect(collector.submit(advisorChild('advisor-1'), identity, verdict())).toBe('unmatched')
  })

  it('does not prune a consultation that is still awaiting reconciliation', () => {
    const collector = new AdvisorVerdictCollector()
    const first = collector.open({ id: 'c-old', invocationId: 'inv-1', requesterId: 'root-1', rootId: 'root-1' })
    collector.bind('c-old', 'advisor-1')
    collector.submit(advisorChild('advisor-1'), identity, verdict())
    for (let index = 0; index < 80; index++) collector.open({ id: 'c-' + index, invocationId: 'inv-' + index, requesterId: 'root-1', rootId: 'root-1' })
    expect(collector.get('c-old')?.state).toBe('candidate')
    expect(collector.reconcile('c-old', closedTurn).published).toBe(true)
    expect(first.candidate).toBeDefined()
  })

  it('prunes stale closed records so the registry stays bounded', () => {
    let clock = 1_000
    const collector = new AdvisorVerdictCollector(() => clock)
    for (let index = 0; index < 80; index++) {
      const id = 'c-' + index
      collector.open({ id, invocationId: 'inv-' + index, requesterId: 'root-1', rootId: 'root-1' })
      collector.invalidate(id, 'done')
    }
    clock += 700_000
    collector.open({ id: 'c-trigger', invocationId: 'inv-trigger', requesterId: 'root-1', rootId: 'root-1' })
    expect(collector.list().length).toBeLessThan(80)
  })
})
