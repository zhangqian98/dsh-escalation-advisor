import { describe, expect, it } from 'vitest'
import { parseVerdict } from '../src/verdict.js'
describe('parseVerdict', () => {
  it('parses structured JSON', () => { const verdict = parseVerdict(JSON.stringify({ severity: 'blocker', summary: 'Wrong layer', diagnosis: 'The patch changes auth, but the failing path is middleware.', next_actions: ['Trace middleware order'], confidence: 0.9 })); expect(verdict.severity).toBe('blocker'); expect(verdict.nextActions).toEqual(['Trace middleware order']) })
  it('falls back safely for prose', () => { expect(parseVerdict('Concern: verify the failing branch first.').severity).toBe('concern') })
})
