import { describe, expect, it } from 'vitest'

const maintenance = await import(new URL('../scripts/patch-dsh-history.mjs', import.meta.url).href)
const validate = maintenance.assertAdvisorHistoryPayload

describe('Advisor historical migration schema', () => {
  it('validates all four owned records without changing their payloads', () => {
    const events = [
      { type: 'advisor/policy', data: { version: 2, mode: 'continuous', timeoutMs: 600000, allowTools: ['read'], denyTools: ['write'], escalationWait: 'inherit', continuousWait: 'background' } },
      { type: 'advisor/model', data: { version: 1, selection: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } } },
      { type: 'advisor/identity', data: { version: 1, invocationId: 'invocation', advisorId: 'child', requesterId: 'root', rootId: 'root', allowedTools: ['read'] } },
      // Complete AdvisorRunRecord as written by alpha.27 consult(): every field
      // a delivered multi-turn manual consultation actually persists.
      { type: 'advisor/run', data: { version: 1, id: 'review', requesterId: 'root', mode: 'manual', turn: 4, step: 2, taskRevision: 'old:42', taskAnchor: 12, attempt: 1, status: 'delivered', timestamp: '2026-09-10T00:00:00Z', collectorId: 'review#2.1.nonce', turns: 2, childSessionId: 'child', fingerprint: 'fp', score: 3, severity: 'concern', summary: 's', question: 'q', responseText: 'Original reply', verdictTool: 'advisor_verdict', structuredFallback: false, usage: { inputTokens: 10, outputTokens: 5 } } },
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
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', collectorId: '' } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', turns: 0 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', turns: 1.5 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', taskAnchor: -1 } },
      { type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'manual', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', taskAnchor: 'seq' } },
    ]) expect(() => validate(event)).toThrow()
  })
})
