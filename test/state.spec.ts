import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { classifyToolOutcome, EscalationTracker, failureFingerprint, findExitCode, normalizeFailureText } from '../src/state.js'
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
  it('excludes expected negative command exits and structured non-intelligence outcomes', () => {
    const tracker = new EscalationTracker()
    const expectedNegatives = [
      { name: 'bash', arguments: { command: 'grep needle file.txt' }, isError: false, value: { exitCode: 1 }, contentText: 'no matches' },
      { name: 'bash', arguments: { command: 'git diff --quiet' }, isError: false, value: { exitCode: 1 }, contentText: 'changes present' },
      { name: 'bash', arguments: { command: 'test -e missing-file' }, isError: false, value: { exitCode: 1 }, contentText: '' },
    ]
    for (const observed of expectedNegatives) {
      expect(classifyToolOutcome(observed).class).toBe('expected-negative')
      tracker.observe('s', observed, config)
    }
    const exclusions = [
      { name: 'bash', arguments: { command: 'pnpm test' }, isError: false, value: { exitCode: 1, sandbox: { denied: true } }, contentText: '' },
      { name: 'bash', arguments: { command: 'pnpm test' }, isError: true, errorCode: 'CANCELLED', contentText: '' },
      { name: 'bash', arguments: { command: 'pnpm test' }, isError: true, errorCode: 'ETIMEDOUT', contentText: '' },
      { name: 'mcp_tool', arguments: {}, isError: true, errorCode: 'ECONNRESET', contentText: '' },
    ]
    for (const observed of exclusions) {
      expect(classifyToolOutcome(observed).class).not.toBe('unknown-failure')
      tracker.observe('s', observed, config)
    }
    expect(tracker.decision('s', 1, config).score).toBe(0)
  })
  it('keeps validation failures until a matching validation succeeds', () => {
    const tracker = new EscalationTracker()
    const authTestFailure = { name: 'bash', arguments: { command: 'pnpm test auth' }, isError: false, value: { exitCode: 1 }, contentText: 'authentication test failed' }
    expect(classifyToolOutcome(authTestFailure).class).toBe('validation-failure')
    tracker.observe('s', authTestFailure, config)
    tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm test auth' }, isError: false, value: { session_id: 12 }, contentText: 'process still running' }, config)
    expect(tracker.decision('s', 1, config).score).toBe(config.nonZeroExitWeight)
    tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm lint' }, isError: false, value: { exitCode: 0 }, contentText: 'lint passed' }, config)
    expect(tracker.decision('s', 1, config).score).toBe(config.nonZeroExitWeight)
    tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm test billing' }, isError: false, value: { exitCode: 0 }, contentText: 'other tests passed' }, config)
    expect(tracker.decision('s', 2, config).score).toBe(config.nonZeroExitWeight)
    tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm test auth' }, isError: false, value: { exitCode: 0 }, contentText: 'tests passed' }, config)
    expect(tracker.decision('s', 3, config).score).toBe(0)
  })
  it('resets repeated-mutation accounting after validation progress', () => {
    const tracker = new EscalationTracker()
    const mutation = { name: 'apply_patch', arguments: { file_path: 'src/auth.ts' }, isError: false, contentText: '' }
    for (let count = 0; count < config.repeatedMutationCount; count += 1) tracker.observe('s', mutation, config)
    expect(tracker.decision('s', 1, config).score).toBe(config.repeatedMutationWeight)
    tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm lint' }, isError: false, value: { exitCode: 0 }, contentText: 'lint passed' }, config)
    expect(tracker.decision('s', 1, config).score).toBe(config.repeatedMutationWeight)
    tracker.observe('s', { name: 'bash', arguments: { command: 'pnpm test auth' }, isError: false, value: { exitCode: 0 }, contentText: 'tests passed' }, config)
    expect(tracker.decision('s', 2, config).score).toBe(0)
    for (let count = 0; count < config.repeatedMutationCount; count += 1) tracker.observe('s', mutation, config)
    expect(tracker.decision('s', 3, config).score).toBe(config.repeatedMutationWeight)
  })
  it('does not treat a compound validation failure as a search no-match', () => {
    expect(classifyToolOutcome({ name: 'bash', arguments: { command: 'grep needle file; npm test' }, isError: false, value: { exitCode: 1 }, contentText: 'tests failed' }).class).toBe('validation-failure')
  })
})
