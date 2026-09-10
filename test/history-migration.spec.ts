import { describe, expect, it } from 'vitest'

const maintenance = await import(new URL('../scripts/patch-dsh-history.mjs', import.meta.url).href)
const validate = maintenance.assertAdvisorHistoryPayload

describe('Advisor historical migration schema', () => {
  it('validates all four owned records without changing their payloads', () => {
    const events = [
      { type: 'advisor/policy', data: { version: 2, mode: 'continuous', timeoutMs: 600000, allowTools: ['read'], denyTools: ['write'], escalationWait: 'inherit', continuousWait: 'background' } },
      { type: 'advisor/model', data: { version: 1, selection: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } } },
      { type: 'advisor/identity', data: { version: 1, invocationId: 'invocation', advisorId: 'child', requesterId: 'root', rootId: 'root', allowedTools: ['read'] } },
      { type: 'advisor/run', data: { version: 1, id: 'review', requesterId: 'root', mode: 'escalation', turn: 4, taskRevision: 'old:42', attempt: 1, status: 'delivered', timestamp: '2026-09-10T00:00:00Z', responseText: 'Original reply', usage: { inputTokens: 10, outputTokens: 5 } } },
    ]
    const original = structuredClone(events)
    events.forEach(event => validate(event))
    expect(events).toEqual(original)
    expect(() => validate({ type: 'advisor/policy', data: { toolPreset: 'custom', tools: ['grep'] } })).not.toThrow()
    expect(() => validate({ type: 'advisor/model', data: { version: 1, selection: null } })).not.toThrow()
  })

  it('refuses foreign types, unknown versions, extra fields and malformed permissions', () => {
    for (const event of [
      { type: 'foreign/required', data: {} },
      { type: 'advisor/model', data: { version: 99, selection: null } },
      { type: 'advisor/model', data: { version: 1, selection: null, extra: true } },
      { type: 'advisor/policy', data: { version: 2, allowTools: ['read'], denyTools: null } },
      { type: 'advisor/policy', data: { version: 2, allowTools: [], denyTools: [], timeoutMs: -1 } },
    ]) expect(() => validate(event)).toThrow()
  })
})
