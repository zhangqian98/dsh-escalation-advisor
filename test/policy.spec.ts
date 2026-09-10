import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config } from '../src/config.js'
import { effectiveAdvisorPolicy, normalizeToolList, sessionPolicyOverride } from '../src/policy.js'

function fakeSession(events: unknown[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

const config = Config({ enabled: true, mode: 'escalate', provider: 'test', model: 'strong' })

describe('advisor policy', () => {
  it('restores legacy preset policies without granting global extras', () => {
    const legacy = (toolPreset: string, tools: string[] = []) => fakeSession([{ type: 'advisor/policy', data: { toolPreset, tools, escalationWait: 'inherit', continuousWait: 'block' } }])
    expect(effectiveAdvisorPolicy(config, legacy('none')).allowedTools).toEqual([])
    expect(effectiveAdvisorPolicy(config, legacy('custom', ['grep'])).allowedTools).toEqual(['grep'])
    expect(effectiveAdvisorPolicy({ ...config, defaultEnabledTools: ['bash'] }, legacy('inspect')).allowedTools).toEqual(['read', 'read_image', 'glob', 'grep'])
    expect(sessionPolicyOverride(legacy('research'))).toMatchObject({ version: 2 })
  })

  it('handles invalid persisted payloads and never exposes delegation tools', () => {
    for (const data of [null, 4, {}, { version: 999 }, { allowTools: null, denyTools: 2 }, { toolPreset: '__proto__' }, { toolPreset: 'toString' }]) {
      expect(() => effectiveAdvisorPolicy(config, fakeSession([{ type: 'advisor/policy', data }]))).not.toThrow()
    }
    const policy = effectiveAdvisorPolicy({ ...config, defaultEnabledTools: ['read', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'consult_advisor'] }, fakeSession([]))
    expect(policy.allowedTools).toEqual(['read'])
    expect(effectiveAdvisorPolicy({ ...config, defaultEnabledTools: ['read', 'remote_delegate'], capabilityAmplifierTools: ['remote_delegate'] }, fakeSession([])).allowedTools).toEqual(['read'])
  })
  it('turns on only conservative inspection tools by default', () => {
    const policy = effectiveAdvisorPolicy(config, fakeSession([]))
    expect(policy.allowedTools).toEqual(['read', 'read_image', 'glob', 'grep'])
    expect(policy.allowedTools).not.toContain('edit')
    expect(policy.allowedTools).not.toContain('bash')
    expect(policy.escalationWait).toBe('block')
    expect(policy.continuousWait).toBe('background')
    expect(config.timeoutMs).toBe(600000)
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
    expect(sessionPolicyOverride(session).allowTools).toEqual(['web_search'])
    const policy = effectiveAdvisorPolicy(config, session)
    expect(policy.allowedTools).toContain('web_search')
    expect(policy.allowedTools).not.toContain('bash')
    expect(policy.allowedTools).not.toContain('read')
    expect(normalizeToolList(['x', 'x', ' y '])).toEqual(['x', 'y'])
  })

  it('restores mode overrides while old and invalid records follow the latest global mode', () => {
    const policy = { version: 2, allowTools: [], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit' }
    const stored = (mode?: string) => fakeSession([{ type: 'advisor/policy', data: { ...policy, ...(mode === undefined ? {} : { mode }) } }])
    expect(effectiveAdvisorPolicy(config, stored('manual')).mode).toBe('manual')
    expect(effectiveAdvisorPolicy(config, stored('continuous')).mode).toBe('continuous')
    for (const mode of [undefined, 'invalid', 'inherit']) expect(effectiveAdvisorPolicy(config, stored(mode)).mode).toBe('escalate')
    expect(effectiveAdvisorPolicy({ ...config, mode: 'continuous' }, stored()).mode).toBe('continuous')
  })

  it('restores valid timeout overrides and inherits defaults for old or invalid records', () => {
    const stored = (timeoutMs?: unknown) => fakeSession([{ type: 'advisor/policy', data: { version: 2, allowTools: [], denyTools: [], timeoutMs } }])
    expect(effectiveAdvisorPolicy(config, stored(180000)).timeoutMs).toBe(180000)
    expect(effectiveAdvisorPolicy(config, stored(3600000)).timeoutMs).toBe(3600000)
    for (const value of [undefined, 0, 999, 3600001, NaN, Infinity, '120000']) expect(effectiveAdvisorPolicy(config, stored(value)).timeoutMs).toBe(600000)
  })
})
