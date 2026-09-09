import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { coverageEnabled } from '../src/coverage.js'

const config = Config({ enabled: true, mode: 'escalate', provider: 'test', model: 'strong' })

describe('advisor coverage defaults', () => {
  it('allows manual consultation for root and local subagents, never advisor children', () => {
    expect(coverageEnabled(config, 'manual', 'root')).toBe(true)
    expect(coverageEnabled(config, 'manual', 'local-subagent')).toBe(true)
    expect(coverageEnabled(config, 'manual', 'advisor')).toBe(false)
  })

  it('auto-escalates root and local subagents', () => {
    expect(coverageEnabled(config, 'escalation', 'root')).toBe(true)
    expect(coverageEnabled(config, 'escalation', 'local-subagent')).toBe(true)
  })

  it('keeps continuous review root-only by default', () => {
    expect(coverageEnabled(config, 'continuous', 'root')).toBe(true)
    expect(coverageEnabled(config, 'continuous', 'local-subagent')).toBe(false)
  })

  it('honors explicit subagent continuous opt-in', () => {
    const enabled = Config({ ...config, continuousLocalSubagents: true })
    expect(coverageEnabled(enabled, 'continuous', 'local-subagent')).toBe(true)
  })
})
