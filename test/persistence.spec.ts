import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'
import { installAdvisorEventCompatibility } from '../src/session-events.js'
import { sessionPolicyOverride, updateToolOverride } from '../src/policy.js'
import { sessionModelSelection, updateModelSelection } from '../src/model-selection.js'
import { advisorChildren, advisorScript, advisorVerdictResponse, createIntegrationHarness, textResponse, toolCallResponse } from './harness.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'fixture/required': { value: string } }
}

// alpha.2 extracted the same cold-read validation from rc.1's coordinator.
// Exercise the native reader in each runtime against a serialized event prefix.
async function coldRead(ctx: Context, stored: SessionInspection): Promise<SessionInspection> {
  const prefix: SessionInspection = JSON.parse(JSON.stringify(stored))
  const validate = Reflect.get(Persistence, 'validateStoredEvents') as ((meta: SessionInspection['meta'], events: SessionEvent[]) => SessionEvent[]) | undefined
  if (validate) return { ...prefix, events: validate(prefix.meta, [...prefix.events]) }
  const Coordinator = Reflect.get(Persistence, 'PersistenceCoordinator') as new (ctx: Context, backend: object) => { load(id: SessionId): Promise<SessionInspection> }
  const revision = Persistence.SessionPersistenceRevision('fixture:1')
  return new Coordinator(ctx, {
    name: 'test-medium',
    async loadStored() { return { ...prefix, revision } },
    async readStoredRevision() { return revision },
    async appendBatch() { throw new Error('Cold read must not append') },
    async commitRepair() { throw new Error('Completed logs must not need repair') },
    async list() { return [prefix.meta] },
  }).load(prefix.meta.id)
}

describe('Advisor persistent session compatibility', () => {
  it('cold-loads real root and Advisor logs while preserving required policy, identity, and verdict records', async () => {
    const h = await createIntegrationHarness({ weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review' }), textResponse('done')], advisor: advisorScript(advisorVerdictResponse()) })
    let childId!: SessionId
    let storedRoot!: SessionInspection, storedChild!: SessionInspection
    try {
      updateToolOverride(h.root.session, 'bash', 'deny')
      updateModelSelection(h.root.session, { provider: 'mock', model: 'advisor' })
      await h.runRoot('Review the current task')
      const child = advisorChildren(h)[0]!
      childId = child.agent.id
      storedRoot = { meta: h.root.session.header, events: h.root.session.snapshotEvents(), inheritedEventCount: SessionLogOffset(0) }
      storedChild = { meta: child.agent.session.header, events: child.disposedEvents!, inheritedEventCount: SessionLogOffset(0) }
    } finally { await h.ctx.fiber.dispose() }

    const reader = new Context()
    try {
      await reader.plugin(SessionStore)
      await reader.plugin({ name: 'advisor-events', apply: installAdvisorEventCompatibility })
      const root = await coldRead(reader, storedRoot)
      const child = await coldRead(reader, storedChild)
      const restored = Session.create(root.meta.id, root.events, root.meta, root.inheritedEventCount)
      expect(sessionPolicyOverride(restored)).toMatchObject({ version: 2, denyTools: ['bash'] })
      expect(sessionModelSelection(restored)).toEqual({ provider: 'mock', model: 'advisor' })
      expect(root.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'advisor/run', data: expect.objectContaining({ status: 'delivered', childSessionId: childId }) })]))
      expect(child.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'advisor/identity', data: expect.objectContaining({ advisorId: childId, requesterId: h.root.id }) })]))
      expect([...root.events, ...child.events].filter(event => event.type.startsWith('advisor/')).every(event => event.ignorable !== true)).toBe(true)
    } finally { await reader.fiber.dispose() }

    const withoutAdvisor = new Context()
    try {
      await withoutAdvisor.plugin(SessionStore)
      await expect(coldRead(withoutAdvisor, storedChild)).rejects.toThrow('unknown to this harness')
    } finally { await withoutAdvisor.fiber.dispose() }
  })

  it('keeps unknown required events rejected and owns the compatibility lifetime across multiple contexts', async () => {
    const first = new Context(), second = new Context()
    const source = Session.create(SessionId('foreign-event'))
    source.append('fixture/required', { value: 'must not be skipped' })
    try {
      await first.plugin({ name: 'advisor-events', apply: installAdvisorEventCompatibility })
      await second.plugin(SessionStore)
      await second.plugin({ name: 'advisor-events', apply: installAdvisorEventCompatibility })
      await first.fiber.dispose()
      expect(KNOWN_SESSION_EVENT_TYPES.has('advisor/identity')).toBe(true)
      await expect(coldRead(second, { meta: source.header, events: source.snapshotEvents(), inheritedEventCount: SessionLogOffset(0) })).rejects.toThrow('fixture/required')
    } finally { await Promise.all([first.fiber.dispose(), second.fiber.dispose()]) }
  })
})
