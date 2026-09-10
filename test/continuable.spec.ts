import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  ContinuationTrace,
  childOutputText,
  closedTurns,
  createIntegrationHarness,
  deferred,
  requestText,
  systemPromptOf,
  textResponse,
  toolCallResponse,
  waitUntil,
  waitForTurnEnd,
  type IntegrationHarness,
  type ScriptEntry,
} from './harness.js'

/**
 * Evidence for the continuable-subagent turn-closure protocol, produced by
 * running the real DSH runtime.
 *
 * The harness mounts a real `AgentRegistry`, `AgentLoop`, `SubagentRuntime`,
 * spawn provider, `LlmRuntime` + scripted adapter, `ToolRuntime`, and the
 * Advisor plugin. `sessionPersistence` is mounted as an in-memory backend
 * because a continuable child cannot start without that capability; see
 * `MemorySessionPersistence` for exactly what that backend does and does not
 * prove.
 */

const PERSONA = 'CONTINUABLE-PERSONA-MARKER'
const PROBE = 'continuable_probe'
const TIMEOUT = 20000

const openHarnesses: IntegrationHarness[] = []

async function harness(
  scripts: Record<string, ScriptEntry[]>,
  persist = true,
): Promise<IntegrationHarness> {
  const value = await createIntegrationHarness(scripts, {}, {}, { sessionPersistence: persist })
  openHarnesses.push(value)
  return value
}

afterEach(async () => {
  for (const current of openHarnesses.splice(0)) await current.ctx.fiber.dispose()
})

/** Register the host-tier plugin tool a continuable child is allowed to call. */
function registerProbe(h: IntegrationHarness, onCall: () => void): void {
  h.ctx.tools.register(defineContentToolFixture({
    name: PROBE,
    description: 'Continuable-child evidence fixture.',
    parameters: {},
    execute: async () => { onCall(); return [{ type: 'text', text: 'probe ok' }] },
  }))
}

/**
 * The turn that actually claimed a delivered message. `agent/inbox/claimed`
 * carries the owning turn, so a delivery is attributed without guessing — and
 * the recorder was installed before dispatch, so an early claim is not missed.
 */
async function claimedTurn(trace: ContinuationTrace, childId: string, messageId: string): Promise<number> {
  await waitUntil(() => trace.all('agent/inbox/claimed', { agent: childId, message: messageId }).length > 0)
  return Number(trace.all('agent/inbox/claimed', { agent: childId, message: messageId })[0]!.detail.turn)
}

/** A model entry that blocks until `release` resolves or its request is cancelled. */
function held(started: () => void, release: Promise<void>, chunks: StreamChunk[]): ScriptEntry {
  return async request => {
    started()
    await Promise.race([
      release,
      new Promise<never>((_resolve, reject) => {
        const signal = request.signal
        if (signal === undefined) return
        if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return }
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
      }),
    ])
    return chunks
  }
}

describe('continuable subagent children: capability gates', () => {
  it('refuses to start a continuable child without the sessionPersistence capability', async () => {
    const h = await harness({ worker: [textResponse('unreachable')] }, false)
    await expect(h.startContinuableChild()).rejects.toMatchObject({
      code: 'PERSISTENCE_UNAVAILABLE',
      message: expect.stringContaining('continuable subagents require session persistence'),
    })
    // The refusal precedes every child resource: only the root was ever created.
    expect(h.created.map(({ agent }) => String(agent.id))).toEqual(['integration-root'])
  }, TIMEOUT)
})

describe('continuable subagent children: one successful turn', () => {
  it('records the exact observable order of a successful turn from a host-scoped listener', async () => {
    let probes = 0
    const h = await harness({
      worker: [toolCallResponse('probe-1', PROBE, { note: 'turn one' }), textResponse('TURN-ONE-CLOSE')],
    })
    registerProbe(h, () => { probes += 1 })

    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const child = h.childAgent(id)!

    const turn = await claimedTurn(trace, id, String(messageId))
    const closed = await waitForTurnEnd(child, turn)
    // Eviction can only follow the turn it settles, never precede it.
    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)
    await waitUntil(() => trace.position('subagent/end', { id }) >= 0, 3000)
    expect(trace.position('agent/disposed', { agent: id }))
      .toBeGreaterThan(trace.position('session/turn/end', { session: id, turn }))
    expect(h.childAgent(id)).toBeUndefined()

    console.log('--- one successful continuable turn, as a host-scoped listener sees it ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    expect(turn).toBe(1)
    expect(closed).toEqual({ turn: 1, reason: 'completed' })
    expect(childOutputText(child)).toBe('TURN-ONE-CLOSE')
    expect(probes).toBe(1)
    expect(h.adapter.forModel('worker')).toHaveLength(2)

    expect(trace.of(id).map(entry => entry.name)).toEqual([
      'agent/created',
      'subagent/start',
      'agent/inbox/inserted',
      'agent/status',
      'session/turn/start',
      'agent/inbox/claimed',
      'session/user/message',
      'session/user/message',
      'session/assistant/message',
      'session/assistant/message',
      'agent/turn-stopping',
      'session/turn/end',
      'agent/status',
      'agent/disposed',
      'subagent/end',
    ])
    expect(trace.of(id).filter(entry => entry.name === 'agent/status').map(entry => entry.detail.status)).toEqual(['running', 'idle'])
    expect(trace.all('agent/turn-stopping')[0]!.detail).toMatchObject({ turn: 1, turnAlreadyClosed: false })
  }, TIMEOUT)

  it('settles the child after the turn closes, evicts it, and wakes the parent', async () => {
    const h = await harness({ worker: [textResponse('TURN-ONE-CLOSE')] })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const rootId = String(h.root.id)

    await claimedTurn(trace, id, String(messageId))
    await waitForTurnEnd(h.childAgent(id)!, 1)
    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)
    await waitUntil(() => trace.position('subagent/end', { id }) >= 0, 3000)

    console.log('--- post-turn settlement order ---')
    console.log(trace.entries.map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    const closedAt = trace.position('session/turn/end', { session: id, turn: 1 })
    const idleAt = trace.position('agent/status', { agent: id, status: 'idle' })
    const disposedAt = trace.position('agent/disposed', { agent: id })
    const noticedAt = trace.position('agent/inbox/inserted', { agent: rootId, source: 'subagent-settled' })
    const endAt = trace.position('subagent/end', { id })

    expect(closedAt).toBeGreaterThan(0)
    expect(idleAt).toBeGreaterThan(closedAt)
    expect(disposedAt).toBeGreaterThan(idleAt)
    expect(noticedAt).toBeGreaterThan(disposedAt)
    // The published lifecycle edge is last: after teardown and after the parent
    // was already told.
    expect(endAt).toBeGreaterThan(noticedAt)
    expect(trace.all('subagent/end')[0]!.detail).toMatchObject({ id, provider: 'spawn', stopReason: 'completed' })
    expect(h.childAgent(id)).toBeUndefined()
    // The settlement notice is a real user-role message that STARTS A PARENT TURN.
    const notice = trace.all('agent/inbox/inserted', { agent: rootId, source: 'subagent-settled' })
    expect(notice).toHaveLength(1)
    expect(trace.position('session/turn/start', { session: rootId })).toBeGreaterThan(noticedAt)
  }, TIMEOUT)
})

describe('continuable subagent children: rejected closure signals', () => {
  it('shows whenIdle() cannot distinguish a failed turn from a successful one', async () => {
    // No scripted entry: the child's first model request fails, and the turn
    // closes with a reason other than `completed`.
    const h = await harness({ worker: [] })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)

    const turn = await claimedTurn(trace, id, String(messageId))
    const child = h.childAgent(id)!
    await child.whenIdle()
    trace.mark('whenIdle/resolved')
    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)

    console.log('--- a failed turn observed through whenIdle ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    expect(turn).toBe(1)
    expect(closedTurns(child)).toEqual([{ turn: 1, reason: 'error' }])
    // whenIdle resolved, so a caller that trusted it concluded "done"...
    expect(trace.position('whenIdle/resolved'))
      .toBeGreaterThan(trace.position('session/turn/end', { session: id, turn: 1 }))
    // ...and every other candidate signal looks the same as on success:
    expect(trace.position('agent/status', { agent: id, status: 'idle' })).toBeGreaterThan(0)
    expect(trace.all('agent/disposed', { agent: id })).toHaveLength(1)
    // Only the turn/end reason separates this run from a successful one.
    expect(trace.all('subagent/end')[0]!.detail.stopReason).toBe('error')
  }, TIMEOUT)

  it('shows whenIdle() over-waits past the delivered turn once more input is pending', async () => {
    const started = deferred()
    const release = deferred()
    const h = await harness({
      worker: [
        held(() => started.resolve(), release.promise, textResponse('TURN-ONE-CLOSE')),
        textResponse('TURN-TWO-CLOSE'),
      ],
    })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const child = h.childAgent(id)!

    const turn = await claimedTurn(trace, id, String(messageId))
    await started.promise
    // A follow-up queued as a distinct turn while turn 1 still runs.
    await h.queueToChild(id, 'TURN TWO PROMPT')
    const idle = child.whenIdle().then(() => trace.mark('whenIdle/resolved'))
    release.resolve()

    await waitForTurnEnd(child, turn)
    await waitForTurnEnd(child, 2)
    await idle

    console.log('--- whenIdle over-wait ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    expect(closedTurns(child)).toEqual([
      { turn: 1, reason: 'completed' },
      { turn: 2, reason: 'completed' },
    ])
    // Both turns closed before whenIdle resolved, so whenIdle cannot answer
    // "has the turn I delivered closed?" for the turn of interest.
    expect(trace.position('session/turn/end', { session: id, turn: 1 }))
      .toBeLessThan(trace.position('whenIdle/resolved'))
    expect(trace.position('session/turn/end', { session: id, turn: 2 }))
      .toBeLessThan(trace.position('whenIdle/resolved'))
  }, TIMEOUT)

  it('shows agent/turn-stopping fires while the turn is still open', async () => {
    const h = await harness({
      worker: [toolCallResponse('probe-1', PROBE, {}), textResponse('TURN-ONE-CLOSE')],
    })
    registerProbe(h, () => undefined)
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)

    const turn = await claimedTurn(trace, id, String(messageId))
    await waitForTurnEnd(h.childAgent(id)!, turn)

    const stopping = trace.all('agent/turn-stopping', { agent: id, turn })
    expect(stopping).toHaveLength(1)
    // At that instant the child's own log has no turn/end for this turn.
    expect(stopping[0]!.detail.turnAlreadyClosed).toBe(false)
    expect(trace.position('agent/turn-stopping', { agent: id, turn }))
      .toBeLessThan(trace.position('session/turn/end', { session: id, turn }))
  }, TIMEOUT)
})

describe('continuable subagent children: second turn in the same session', () => {
  it('runs a distinct second turn with context, persona, allow-list and a plugin tool intact', async () => {
    let probes = 0
    const started = deferred()
    const release = deferred()
    const h = await harness({
      worker: [
        held(() => started.resolve(), release.promise, toolCallResponse('probe-1', PROBE, {})),
        textResponse('TURN-ONE-CLOSE'),
        toolCallResponse('probe-2', PROBE, {}),
        textResponse('TURN-TWO-CLOSE'),
      ],
    })
    registerProbe(h, () => { probes += 1 })

    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({
      prompt: 'TURN ONE PROMPT',
      persona: PERSONA,
      toolFilter: { allow: [PROBE] },
    })
    const id = String(childId)
    const child = h.childAgent(id)!

    const firstTurn = await claimedTurn(trace, id, String(messageId))
    await started.promise
    const queuedId = String(await h.queueToChild(id, 'TURN TWO PROMPT'))
    release.resolve()

    const secondTurn = await claimedTurn(trace, id, queuedId)
    const closed = await waitForTurnEnd(child, secondTurn)
    // The turn ran on the child that was started: it was never re-materialized,
    // and it outlived the second turn because both turns are in its own log.
    expect(String(child.id)).toBe(id)
    expect(trace.position('agent/disposed', { agent: id }))
      .toBeGreaterThan(trace.position('session/turn/end', { session: id, turn: 2 }))

    console.log('--- two turns in one child session ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    expect(firstTurn).toBe(1)
    expect(secondTurn).toBe(2)
    expect(closed).toEqual({ turn: 2, reason: 'completed' })
    // Same durable session: one materialization, two turns in one log.
    expect(trace.all('agent/created', { agent: id })).toHaveLength(1)
    expect(closedTurns(child)).toEqual([
      { turn: 1, reason: 'completed' },
      { turn: 2, reason: 'completed' },
    ])
    expect(trace.all('session/turn/start', { session: id }).map(entry => entry.detail.turn)).toEqual([1, 2])

    const requests = h.adapter.forModel('worker')
    expect(requests).toHaveLength(4)
    const secondTurnRequests = requests.slice(2)

    // (a) turn 1's conversation context is intact
    for (const { request } of secondTurnRequests) {
      expect(requestText(request)).toContain('TURN ONE PROMPT')
      expect(requestText(request)).toContain('TURN TWO PROMPT')
    }
    // (b) the persona is still applied
    for (const { request } of secondTurnRequests) expect(systemPromptOf(request)).toContain(PERSONA)
    // (c) the allow-list is still in force
    for (const { request } of secondTurnRequests) {
      expect((request.tools ?? []).map(tool => tool.name)).toEqual([PROBE])
    }
    // the host-registered plugin tool is still callable in turn 2
    expect(probes).toBe(2)
    expect(childOutputText(child)).toBe('TURN-TWO-CLOSE')
  }, TIMEOUT)

  it('steers an accepted sendMessage into the running turn instead of opening a new one', async () => {
    const started = deferred()
    const release = deferred()
    const h = await harness({
      worker: [
        held(() => started.resolve(), release.promise, toolCallResponse('probe-1', PROBE, {})),
        textResponse('TURN-ONE-CLOSE'),
      ],
    })
    registerProbe(h, () => undefined)

    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const child = h.childAgent(id)!

    const turn = await claimedTurn(trace, id, String(messageId))
    await started.promise
    const steerId = String(await h.sendToChild(id, 'STEER TEXT'))
    release.resolve()
    await waitForTurnEnd(child, turn)

    console.log('--- sendMessage against a running child ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    // The running turn claimed it: `sendMessage` cannot open a second turn.
    expect(await claimedTurn(trace, id, steerId)).toBe(turn)
    expect(closedTurns(child)).toEqual([{ turn: 1, reason: 'completed' }])
    // ...but it did reach the model, in that turn's next step.
    expect(requestText(h.adapter.forModel('worker')[1]!.request)).toContain('STEER TEXT')
  }, TIMEOUT)
})

describe('continuable subagent children: eviction and cold resume', () => {
  it('evicts the idle child and cannot cold-resume it', async () => {
    const h = await harness({ worker: [textResponse('TURN-ONE-CLOSE')] })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)

    await claimedTurn(trace, id, String(messageId))
    await waitForTurnEnd(h.childAgent(id)!, 1)
    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)

    // Evidence of eviction rather than mere idleness:
    // 1. the exact child Agent left the registry,
    expect(h.childAgent(id)).toBeUndefined()
    // 2. it left the live session store,
    expect(h.ctx.sessions.get(SessionId(id))).toBeUndefined()
    // 3. its epoch teardown edge was published with a successful reason,
    expect(trace.all('subagent/end', { id })[0]!.detail.stopReason).toBe('completed')
    // 4. and the pre-publication record survives in the backend, so the child
    //    was released rather than lost. Live events are NOT here: the installed
    //    `SessionPersistence` is an abstract service with no routing, and
    //    `SessionStore.flush(session)` merely dispatches `session/flush` to
    //    listeners on the session carrier, of which this repository installs
    //    none. This assertion therefore records the harness's storage boundary,
    //    not a property of the runtime.
    const persistence = h.ctx.get('sessionPersistence')!
    let storedTypes: string[] | undefined
    try {
      const handle = await persistence.open(SessionId(id), 'read')
      const stored = await handle.read()
      await handle.close()
      storedTypes = stored.events.map(event => String(event.type))
    } catch {
      storedTypes = undefined
    }
    if (storedTypes !== undefined) expect(storedTypes).toContain('subagent/descriptor')

    // The follow-up takes the cold-resume branch and fails there: a missing
    // activation is the only way to reach `requireSessionQuery()`.
    await expect(h.sendToChild(id, 'TURN TWO PROMPT')).rejects.toMatchObject({
      code: 'CONTINUATION_UNAVAILABLE',
      message: expect.stringContaining('continuable subagents require session query'),
    })
    await expect(h.queueToChild(id, 'TURN TWO PROMPT')).rejects.toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' })
    // The refused deliveries re-materialized nothing.
    expect(trace.all('agent/created', { agent: id })).toHaveLength(1)
    expect(h.adapter.forModel('worker')).toHaveLength(1)
  }, TIMEOUT)
})

describe('continuable subagent children: cancellation', () => {
  it('treats the caller signal as pre-acceptance only', async () => {
    const started = deferred()
    const release = deferred()
    const h = await harness({
      worker: [
        held(() => started.resolve(), release.promise, textResponse('TURN-ONE-CLOSE')),
        textResponse('AFTER-STEER'),
      ],
    })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const child = h.childAgent(id)!

    const turn = await claimedTurn(trace, id, String(messageId))
    await started.promise

    // A signal aborted before acceptance refuses the delivery outright.
    const refused = new AbortController()
    refused.abort(new Error('caller gave up'))
    const insertedBefore = trace.all('agent/inbox/inserted', { agent: id }).length
    await expect(h.sendToChild(id, 'NEVER DELIVERED', refused.signal)).rejects.toThrow('caller gave up')
    expect(trace.all('agent/inbox/inserted', { agent: id })).toHaveLength(insertedBefore)

    // A signal aborted AFTER acceptance does not stop the delivered turn.
    const accepted = new AbortController()
    const acceptedId = String(await h.sendToChild(id, 'STILL DELIVERED', accepted.signal))
    accepted.abort(new Error('too late'))
    release.resolve()
    const closed = await waitForTurnEnd(child, turn)

    console.log('--- caller signal handling ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    expect(closed.reason).toBe('completed')
    expect(await claimedTurn(trace, id, acceptedId)).toBe(turn)
    expect(requestText(h.adapter.forModel('worker')[1]!.request)).toContain('STILL DELIVERED')
    expect(requestText(h.adapter.forModel('worker')[1]!.request)).not.toContain('NEVER DELIVERED')
  }, TIMEOUT)

  it('stops a running turn through interrupt, and rejects a foreign authority', async () => {
    const started = deferred()
    const release = deferred()
    const h = await harness({
      worker: [held(() => started.resolve(), release.promise, textResponse('TURN-ONE-CLOSE'))],
    })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const child = h.childAgent(id)!

    const turn = await claimedTurn(trace, id, String(messageId))
    await started.promise

    expect(() => h.interruptChild(id, { kind: 'user', parentSessionId: SessionId('some-other-parent') }))
      .toThrow(/another parent session/)
    expect(() => h.interruptChild(id, { kind: 'ancestor', agent: h.root })).not.toThrow()
    const closed = await waitForTurnEnd(child, turn)
    release.resolve()

    console.log('--- interrupt ---')
    console.log(trace.of(id).map(({ order, name, detail }) => `${order} ${name} ${JSON.stringify(detail)}`).join('\n'))

    expect(closed.reason).toBe('aborted')
    expect(childOutputText(child)).toBe('')
  }, TIMEOUT)

  it('accepts interrupt as a silent no-op for a non-resident child', async () => {
    const h = await harness({ worker: [textResponse('TURN-ONE-CLOSE')] })
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    await claimedTurn(trace, id, String(messageId))
    await waitForTurnEnd(h.childAgent(id)!, 1)
    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)

    expect(() => h.interruptChild(id)).not.toThrow()
    expect(() => h.interruptChild(String(SessionId('no-such-child')))).not.toThrow()
    expect(trace.all('subagent/end', { id })[0]!.detail.stopReason).toBe('completed')
  }, TIMEOUT)
})

/** Record the four instrumented boundaries as seen from one context tier. */
function observe(ctx: Context, into: string[]): void {
  ctx.on('agent/inbox/claimed', ({ agent }) => { into.push(`claimed:${String(agent.id)}`) })
  ctx.on('agent/status', ({ agent }) => { into.push(`status:${String(agent.id)}`) })
  ctx.on('agent/turn-stopping', ({ agent }) => { into.push(`stopping:${String(agent.id)}`) })
  ctx.on('subagent/end', ({ id }) => { into.push(`end:${String(id)}`) })
}

/**
 * `Agent.inbox` is the narrow agent contract; the loop's own inbox additionally
 * reports the pending lists, which is how a delivered-but-unclaimed message is
 * distinguished from one that was never accepted.
 */
function pendingInput(agent: Agent): { nextTurn: number; nextStep: number } {
  const inbox = agent.inbox as unknown as {
    readonly nextTurn: readonly unknown[]
    readonly nextStep: readonly unknown[]
  }
  return { nextTurn: inbox.nextTurn.length, nextStep: inbox.nextStep.length }
}

describe('continuable subagent children: listener tiers and the resident window', () => {
  it('reports which listener tier observes each boundary', async () => {
    const h = await harness({ worker: [textResponse('TURN-ONE-CLOSE')] })
    const host: string[] = []
    const rootScoped: string[] = []
    const childScoped: string[] = []
    observe(h.ctx, host)
    observe(h.root.ctx, rootScoped)

    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    const rootId = String(h.root.id)
    const child = h.childAgent(id)!
    observe(child.ctx, childScoped)

    await claimedTurn(trace, id, String(messageId))
    await waitForTurnEnd(child, 1)
    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)
    await waitUntil(() => trace.position('subagent/end', { id }) >= 0, 3000)
    await new Promise(resolve => setTimeout(resolve, 50))

    console.log('host tier', JSON.stringify(host))
    console.log('root-agent tier', JSON.stringify(rootScoped))
    console.log('child-agent tier', JSON.stringify(childScoped))

    // The host tier is admitted to every carrier, so a host-scoped plugin sees
    // the child's whole lifecycle as well as the parent's.
    expect(host).toContain(`claimed:${id}`)
    expect(host).toContain(`stopping:${id}`)
    expect(host).toContain(`status:${id}`)
    expect(host).toContain(`end:${id}`)
    expect(host).toContain(`status:${rootId}`)
    expect(host).toContain(`claimed:${rootId}`)
    // A parent-agent-scoped listener sees NOTHING of the child's turn machinery,
    // but it does receive the child's `subagent/end` teardown edge.
    expect(rootScoped.filter(entry => !entry.endsWith(`:${rootId}`))).toEqual([`end:${id}`])
    expect(rootScoped.length).toBeGreaterThan(1)
    // The child's own scope sees its own status, but not its own teardown edge.
    expect(childScoped.filter(entry => !entry.endsWith(`:${id}`))).toEqual([])
    expect(childScoped.some(entry => entry.startsWith('end:'))).toBe(false)
    expect(childScoped.length).toBeGreaterThan(0)
  }, TIMEOUT)

  it('shows that only a delivery inside the running turn actually runs a second turn', async () => {
    const h = await harness({
      worker: [textResponse('T1-A'), textResponse('T2-A'), textResponse('T1-B'), textResponse('T2-B')],
    })
    const outcomes: Record<string, string> = {}

    for (const attempt of ['same-tick', 'next-macrotask'] as const) {
      const trace = new ContinuationTrace(h.ctx)
      const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
      const id = String(childId)
      const child = h.childAgent(id)!
      const outcome = { value: 'NOT-DELIVERED' }
      const settled = deferred()
      h.ctx.on('session/event', (session, event) => {
        if (String(session.id) !== id || event.type !== 'turn/end') return
        const fire = (): void => {
          void h.queueToChild(id, 'TURN TWO PROMPT').then(
            () => { outcome.value = 'DELIVERED'; settled.resolve() },
            error => { outcome.value = `REFUSED ${String((error as { code?: string }).code)}`; settled.resolve() },
          )
        }
        if (attempt === 'same-tick') fire()
        else setTimeout(fire, 0)
      })

      await claimedTurn(trace, id, String(messageId))
      await settled.promise
      await new Promise(resolve => setTimeout(resolve, 100))
      outcomes[attempt] = outcome.value

      if (attempt === 'same-tick') {
        // Accepted, but the driver had already decided to stop: the message sits
        // Accepted, but the driver had already stopped: the message sits in
        // `next-turn` unclaimed while the child stays resident and idle.
        expect(closedTurns(child)).toEqual([{ turn: 1, reason: 'completed' }])
        expect(pendingInput(child)).toEqual({ nextTurn: 1, nextStep: 0 })
        expect(child.status).toBe('idle')
        expect(trace.all('agent/disposed', { agent: id })).toHaveLength(0)
        // Only a later delivery makes the stranded turn run.
        const wakeId = String(await h.sendToChild(id, 'WAKE UP'))
        await waitForTurnEnd(child, 2)
        expect(await claimedTurn(trace, id, wakeId)).toBe(2)
        expect(closedTurns(child)).toEqual([
          { turn: 1, reason: 'completed' },
          { turn: 2, reason: 'completed' },
        ])
      } else {
        expect(trace.all('agent/disposed', { agent: id })).toHaveLength(1)
      }
    }

    console.log('resident-window outcomes', JSON.stringify(outcomes))
    expect(outcomes).toEqual({
      'same-tick': 'DELIVERED',
      'next-macrotask': 'REFUSED CONTINUATION_UNAVAILABLE',
    })
  }, TIMEOUT)
})

describe('continuable subagent children: observer installation', () => {
  it('shows whether a closure observer installed after the start promise still sees the turn', async () => {
    const h = await harness({ worker: [textResponse('TURN-ONE-CLOSE')] })
    // Ground truth: installed before the start call, so it cannot miss anything.
    const trace = new ContinuationTrace(h.ctx)
    const { childId, messageId } = await h.startContinuableChild({ prompt: 'TURN ONE PROMPT' })
    const id = String(childId)
    trace.mark('late-observer-installed')
    const late: string[] = []
    observe(h.ctx, late)

    await waitUntil(() => trace.position('agent/disposed', { agent: id }) >= 0, 3000)
    await waitUntil(() => trace.position('subagent/end', { id }) >= 0, 3000)
    await new Promise(resolve => setTimeout(resolve, 50))

    const claim = trace.all('agent/inbox/claimed', { agent: id, message: String(messageId) })[0]!
    const installedOrder = trace.all('late-observer-installed')[0]!.order
    console.log(`claim order ${claim.order} (turn ${String(claim.detail.turn)}), late observer installed at order ${installedOrder}`)
    console.log('late observer saw', JSON.stringify(late))
    console.log('ordered trace', trace.entries.map(entry => `${entry.order}:${entry.name}`).join(' '))

    // Measured: the FIRST turn is claimed before the start promise continuation
    // runs. An observer that subscribes only after awaiting the start call has
    // already missed the claim of its own message, even though the child's
    // session boundaries (turn/end) are still observable afterwards.
    expect(claim.order).toBeLessThan(installedOrder)
    expect(late).not.toContain(`claimed:${id}`)
    expect(late).toContain(`stopping:${id}`)
    expect(late).toContain(`end:${id}`)
  }, TIMEOUT)
})
