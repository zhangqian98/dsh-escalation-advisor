import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { EscalationTracker, failureFingerprint, findExitCode, normalizeFailureText } from '../src/state.js'
const config = Config({ enabled: true, mode: 'escalate', provider: 'test', model: 'strong' })
describe('failure normalization', () => {
  it('normalizes line numbers and long ids for repeated failure detection', () => {
    const a = normalizeFailureText('Error at src/a.ts:123:9 request abcdef1234567890')
    const b = normalizeFailureText('Error at src/a.ts:987:2 request ffffffffffffffff')
    expect(a).toBe(b); expect(failureFingerprint('bash', a)).toBe(failureFingerprint('bash', b))
  })
  it('finds nested exit codes', () => { expect(findExitCode({ process: { exitCode: 2 } })).toBe(2); expect(findExitCode({ process: { exitCode: 0 } })).toBe(0) })
})
describe('EscalationTracker', () => {
  it('escalates repeated identical failures', () => {
    const tracker = new EscalationTracker(), failure = { name: 'bash', arguments: { command: 'pnpm test' }, isError: true, errorMessage: 'Assertion failed at src/a.ts:10:2', contentText: 'Assertion failed' }
    tracker.observe('s', failure, config); expect(tracker.decision('s', 1, config).shouldConsult).toBe(false)
    tracker.observe('s', failure, config); const decision = tracker.decision('s', 2, config); expect(decision.shouldConsult).toBe(true); expect(decision.score).toBeGreaterThanOrEqual(config.scoreThreshold)
  })
  it('deduplicates one problem after consultation', () => {
    const tracker = new EscalationTracker(), failure = { name: 'bash', arguments: { command: 'pnpm test' }, isError: true, errorMessage: 'same error', contentText: 'same error' }
    tracker.observe('s', failure, config); tracker.observe('s', failure, config); const first = tracker.decision('s', 3, config); expect(first.shouldConsult).toBe(true); tracker.markAutoConsult('s', 3, first.problemFingerprint); expect(tracker.decision('s', 5, config).shouldConsult).toBe(false)
  })
  it('resets stuck state after a successful validation command', () => {
    const tracker = new EscalationTracker(); tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm test' }, isError: true, errorMessage: 'failure', contentText: 'failure' }, config); tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm test' }, isError: false, value: { exitCode: 0 }, contentText: 'all tests passed' }, config); expect(tracker.decision('s', 10, config).score).toBe(0)
  })
})
