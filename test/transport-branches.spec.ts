import { afterEach, describe, expect, it } from 'vitest'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { advisorRunHistory } from '../src/telemetry.js'
import { advisorScript, advisorVerdictResponse, createIntegrationHarness, deferred, textResponse, toolCallResponse, waitUntil, type IntegrationHarness } from './harness.js'

/**
 * The continuable transport's failure branches, each measured against the real
 * runtime and each asserted as an explicit NON-SUCCESS with its own reason.
 *
 * A branch is only proven when the plugin never falls back to the Advisor's own
 * prose and never leaves the requester without a durable record of what happened.
 */

const opened: IntegrationHarness[] = []
afterEach(async () => { for (const h of opened.splice(0)) await h.ctx.fiber.dispose() })
async function harness(...args: Parameters<typeof createIntegrationHarness>) { const h = await createIntegrationHarness(...args); opened.push(h); return h }

/**
 * The last tool result the requester received, exactly as the requester saw it.
 * A manual consultation returns the structured answer and then the advice message
 * that carries the follow-up hint, so the JSON is the first line.
 */
function toolResultText(h: IntegrationHarness, index = 1): string {
  return h.adapter.forModel('weak')[index]!.request.messages
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'tool-result' ? block.content.flatMap(inner => inner.type === 'text' ? [inner.text] : []) : [])
    .join('')
}

/**
 * The structured answer inside a tool result. Results for the same tool may be
 * concatenated into one message, so the LAST structured answer is the one under test.
 */
function toolResultAnswer(h: IntegrationHarness, index = 1): Record<string, unknown> {
  const text = toolResultText(h, index)
  return JSON.parse(text.slice(text.lastIndexOf('{"status"'))) as Record<string, unknown>
}

function runs(h: IntegrationHarness): Record<string, unknown>[] {
  return (JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))) as { runs: Record<string, unknown>[] }).runs
}

/**
 * NOTE: `ACCEPTED_NOT_CLAIMED` is deliberately NOT exercised here. On this runtime
 * the child claims a delivery in its own dispatch, at the moment the inbox message is
 * picked up, so the only way to reach that branch is to make the runtime evict a child
 * between acceptance and dispatch. That gap is not reachable through public harness
 * APIs without injecting a fake subagent transport, and a fake transport would prove
 * nothing about the real one. The branch stays in `callAdvisor` as the measured
 * fallback for a claim that never arrives.
 */
/** A model request that stays pending until the caller's own signal is aborted. */
function never(signalOf: (request: { signal?: AbortSignal }) => AbortSignal | undefined) {
  return async (request: { signal?: AbortSignal }): Promise<never> => {
    const signal = signalOf(request)
    await new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
      signal?.addEventListener('abort', () => reject(signal?.reason ?? new Error('aborted')), { once: true })
    })
    throw new Error('unreachable')
  }
}

/** How many listeners one context event currently has. */
function listenerCount(h: IntegrationHarness, name: string): number {
  const events = (h.ctx as unknown as { events: { _hooks: Record<string, unknown[]> } }).events
  return (events._hooks[name] ?? []).length
}

describe('continuable transport failure branches', () => {
  it('reports a start the transport refused as its own branch, never as success', async () => {
    // Without the session-query capability this runtime cannot start a continuable
    // child at all, so the dispatch itself is refused before anything is accepted.
    const h = await harness({
      weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review the change' }), textResponse('after the result')],
      advisor: advisorScript(advisorVerdictResponse()),
    }, { mode: 'manual' }, {}, { sessionPersistence: false })

    await h.runRoot('Ask for a review.')

    const history = advisorRunHistory(h.root)
    expect(history.length).toBeGreaterThan(0)
    expect(runs(h).at(-1)).toMatchObject({ status: 'failed-transient', error: expect.stringContaining('continuable subagents require session persistence') })
    expect(h.adapter.forModel('advisor')).toHaveLength(0)
    // The refusal is reported as its own branch; no verdict is invented for it.
    expect(toolResultAnswer(h)).toMatchObject({ status: 'unavailable', summary: 'Advisor unavailable', diagnosis: expect.stringContaining('continuable subagents require session persistence') })
  }, 15000)


  it('never publishes a verdict whose turn did not close completed', async () => {
    // The verdict IS submitted, and then the turn never reaches a `completed`
    // boundary: reconciliation against the closing boundary is what keeps it out of
    // the requester's context.
    const h = await harness({
      weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review the change' }), textResponse('after the result'), textResponse('after the settle notice')],
      advisor: [advisorVerdictResponse(), never(request => request.signal)],
    }, { mode: 'manual', timeoutMs: 1000 })

    await h.runRoot('Ask for a review.')

    expect(advisorRunHistory(h.root).at(-1)?.error).toMatch(/closed with|never closed/)
    expect(toolResultAnswer(h)).toMatchObject({ status: 'unavailable' })
    // The verdict text itself never reaches the requester.
    expect(toolResultText(h)).not.toContain('The repeated attempt preserves the failing assumption.')
  }, 15000)

  it('reports a turn that closed with an error instead of a verdict', async () => {
    const h = await harness({
      weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review the change' }), textResponse('after the result'), textResponse('after the settle notice')],
      // The Advisor model itself fails, so the child's turn closes with an error.
      advisor: [() => { throw new Error('advisor transport failure') }],
    }, { mode: 'manual' })

    await h.runRoot('Ask for a review.')

    expect(JSON.stringify(runs(h))).toContain('closed with error')
    expect(toolResultAnswer(h)).toMatchObject({ status: 'unavailable', diagnosis: expect.stringContaining('closed with error') })
  }, 15000)

  it('returns the consultation id and refuses an unknown or foreign one without starting anything', async () => {
    const h = await harness({
      weak: [
        toolCallResponse('ask', 'consult_advisor', { question: 'Review the change' }),
        toolCallResponse('unknown', 'consult_advisor', { question: 'Continue it', consultation_id: 'no-such-consultation' }),
        textResponse('after the refusals'),
        textResponse('after the settle notice'),
      ],
      advisor: advisorScript(advisorVerdictResponse()),
    }, { mode: 'manual', maxManualConsultsPerSession: 4 })

    await h.runRoot('Ask for a review, then continue it.')

    // The successful consultation publishes the durable id a follow-up must address.
    const delivered = toolResultAnswer(h, 1)
    expect(delivered.status).toBe('ok')
    expect(delivered.consultation_id).toEqual(expect.any(String))
    expect(String(delivered.consultation_id).length).toBeGreaterThan(0)
    expect(String(delivered.child_session_id).length).toBeGreaterThan(0)

    // The unknown id is refused outright and never silently restarted as a new one.
    const refused = toolResultAnswer(h, 2)
    expect(refused).toMatchObject({ status: 'unavailable', consultation_id: '', diagnosis: expect.stringContaining('Unknown consultation id') })
    // Exactly one Advisor child was ever created: the refusal started nothing.
    expect(h.adapter.forModel('advisor')).toHaveLength(2)
  }, 15000)

  it('releases every per-turn listener and deadline on a failing exit path', async () => {
    const h = await harness({
      weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review the change' }), textResponse('after the result'), textResponse('after the settle notice')],
      advisor: [() => { throw new Error('advisor transport failure') }],
    }, { mode: 'manual' })
    const before = {
      claimed: listenerCount(h, 'agent/inbox/claimed'),
      sessionEvents: listenerCount(h, 'session/event'),
      streams: listenerCount(h, 'llm/stream'),
    }

    await h.runRoot('Ask for a review.')

    // The turn threw, so the per-turn cleanup must still have run to completion.
    expect(listenerCount(h, 'agent/inbox/claimed')).toBe(before.claimed)
    expect(listenerCount(h, 'session/event')).toBe(before.sessionEvents)
    expect(listenerCount(h, 'llm/stream')).toBe(before.streams)
  }, 15000)
})
