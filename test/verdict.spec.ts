import { describe, expect, it } from 'vitest'
import { parseVerdict, verdictFromStructured, VERDICT_SCHEMA } from '../src/verdict.js'
describe('parseVerdict', () => {
  it('parses structured JSON', () => { const verdict = parseVerdict(JSON.stringify({ severity: 'blocker', summary: 'Wrong layer', diagnosis: 'The patch changes auth, but the failing path is middleware.', next_actions: ['Trace middleware order'], confidence: 0.9 })); expect(verdict.severity).toBe('blocker'); expect(verdict.nextActions).toEqual(['Trace middleware order']) })
  it('falls back safely for prose', () => { expect(parseVerdict('Concern: verify the failing branch first.').severity).toBe('concern') })
  it('parses rich snake_case evidence and change reporting', () => {
    const verdict = verdictFromStructured({
      severity: 'concern',
      disposition: 'revise',
      summary: 'Validation is incomplete',
      diagnosis: 'The edit has no targeted test.',
      next_actions: ['Add the regression test'],
      evidence_used: [{ kind: 'file', reference: 'src/auth.ts:40' }],
      assumptions: ['The middleware order is stable'],
      recommended_next_action: 'Run the auth regression',
      validation_plan: ['npm test -- auth'],
      needs_more_evidence: true,
      confidence: 0.82,
      changes_made: [{
        paths: ['src/auth.ts'],
        reason: 'Correct the cache key',
        validation: ['npm test -- auth: passed'],
      }],
    })
    expect(verdict).toEqual(expect.objectContaining({
      disposition: 'revise',
      evidenceUsed: [{ kind: 'file', reference: 'src/auth.ts:40' }],
      assumptions: ['The middleware order is stable'],
      recommendedNextAction: 'Run the auth regression',
      validationPlan: ['npm test -- auth'],
      needsMoreEvidence: true,
      changesMade: [{
        paths: ['src/auth.ts'],
        reason: 'Correct the cache key',
        validation: ['npm test -- auth: passed'],
      }],
    }))
    expect(VERDICT_SCHEMA.properties).toHaveProperty('changes_made')
  })
  it('redacts secrets in structured fields', () => {
    const verdict = verdictFromStructured({
      severity: 'concern',
      summary: 'token=secret-value',
      diagnosis: 'Bearer abcdefghijklmnop',
    })
    expect(verdict.summary).toContain('[REDACTED]')
    expect(verdict.diagnosis).toContain('[REDACTED]')
  })
  it('does not treat an unrelated nit substring as nit severity', () => {
    expect(parseVerdict('The finite retry budget needs verification.').severity).toBe('concern')
    expect(parseVerdict('Severity: nit\nConsider renaming the helper.').severity).toBe('nit')
  })
})
