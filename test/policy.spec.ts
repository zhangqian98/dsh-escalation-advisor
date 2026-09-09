import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config } from '../src/config.js'
import { effectiveAdvisorPolicy, normalizeToolList, sessionPolicyOverride } from '../src/policy.js'

function fakeSession(events: unknown[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

const config = Config({ enabled: true, mode: 'escalate', provider: 'test', model: 'strong' })

describe('advisor policy', () => {
  it('turns on only conservative inspection tools by default', () => {
    const policy = effectiveAdvisorPolicy(config, fakeSession([]))
    expect(policy.allowedTools).toEqual(['read', 'read_image', 'glob', 'grep'])
    expect(policy.allowedTools).not.toContain('edit')
    expect(policy.allowedTools).not.toContain('bash')
    expect(policy.escalationWait).toBe('block')
    expect(policy.continuousWait).toBe('background')
  })

  it('lets a session enable a globally disabled tool and disable a global default', () => {
    const event = {
      type: 'advisor/policy',
      data: {
        allowTools: ['bash'],
        denyTools: ['grep'],
        escalationWait: 'background',
        continuousWait: 'block',
      },
    }
    const session = fakeSession([event])
    const policy = effectiveAdvisorPolicy(config, session)
    expect(policy.allowedTools).toContain('bash')
    expect(policy.allowedTools).not.toContain('grep')
    expect(policy.allowedTools).toContain('read')
    expect(policy.escalationWait).toBe('background')
    expect(policy.continuousWait).toBe('block')
  })

  it('uses the latest per-session override and deduplicates names', () => {
    const first = { type: 'advisor/policy', data: { allowTools: ['bash'], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit' } }
    const second = { type: 'advisor/policy', data: { allowTools: [' web_search ', 'web_search'], denyTools: ['read'], escalationWait: 'inherit', continuousWait: 'inherit' } }
    const session = fakeSession([first, second])
    expect(sessionPolicyOverride(session).allowTools).toEqual([' web_search ', 'web_search'])
    const policy = effectiveAdvisorPolicy(config, session)
    expect(policy.allowedTools).toContain('web_search')
    expect(policy.allowedTools).not.toContain('bash')
    expect(policy.allowedTools).not.toContain('read')
    expect(normalizeToolList(['x', 'x', ' y '])).toEqual(['x', 'y'])
  })
})
