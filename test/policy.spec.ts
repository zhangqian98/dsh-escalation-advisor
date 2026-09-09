import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config } from '../src/config.js'
import { effectiveAdvisorPolicy, normalizeToolList, sessionPolicyOverride } from '../src/policy.js'

function fakeSession(events: unknown[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

const config = Config({ enabled: true, mode: 'escalate', provider: 'test', model: 'strong' })

describe('advisor policy', () => {
  it('uses safe global defaults when a session has no override', () => {
    const policy = effectiveAdvisorPolicy(config, fakeSession([]))
    expect(policy.toolPreset).toBe('inspect')
    expect(policy.allowedTools).toEqual(['read', 'read_image', 'glob', 'grep'])
    expect(policy.escalationWait).toBe('block')
    expect(policy.continuousWait).toBe('background')
  })
  it('uses the latest per-session override', () => {
    const first = { type: 'advisor/policy', data: { toolPreset: 'none', tools: [], escalationWait: 'inherit', continuousWait: 'inherit' } }
    const second = { type: 'advisor/policy', data: { toolPreset: 'edit', tools: [], escalationWait: 'background', continuousWait: 'block' } }
    const session = fakeSession([first, second])
    expect(sessionPolicyOverride(session).toolPreset).toBe('edit')
    const policy = effectiveAdvisorPolicy(config, session)
    expect(policy.allowedTools).toContain('edit')
    expect(policy.allowedTools).toContain('write')
    expect(policy.escalationWait).toBe('background')
    expect(policy.continuousWait).toBe('block')
  })
  it('honors exact custom allowlists and removes duplicates', () => {
    const session = fakeSession([{ type: 'advisor/policy', data: { toolPreset: 'custom', tools: [' read ', 'bash', 'read', ''], escalationWait: 'inherit', continuousWait: 'inherit' } }])
    expect(effectiveAdvisorPolicy(config, session).allowedTools).toEqual(['read', 'bash'])
    expect(normalizeToolList(['x', 'x', ' y '])).toEqual(['x', 'y'])
  })
})
