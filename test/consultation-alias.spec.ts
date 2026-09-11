import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { advisorScript, advisorVerdictResponse, createIntegrationHarness, textResponse, type IntegrationHarness } from './harness.js'

/**
 * `consultation_id: "last"` spares a caller from carrying a uuid across a
 * compacted context. A convenience alias that guesses is worse than no alias at
 * all, so these tests pin the two properties that need NO continuation to prove:
 * that the alias never invents a target, and that it cannot reach across agents.
 *
 * The alias SEMANTICS that require actually continuing a conversation - resolving
 * to the intended child, and tracking re-delivery into an older conversation -
 * are proven in test/advisor-continuation-runtime.spec.ts instead. They cannot be
 * proven here: a follow-up must cold-resume a child that was already evicted, and
 * this runtime has no `sessionQuery`, so every continuation is refused before its
 * target could be observed. Measured, not assumed: a fresh consultation in this
 * harness returns status ok with a child_session_id, and the follow-up that
 * addresses it fails with CONTINUATION_UNAVAILABLE.
 */
const CONSULT = 'consult_advisor'
const opened: IntegrationHarness[] = []
afterEach(async () => { for (const h of opened.splice(0)) await h.ctx.fiber.dispose() })
async function harness(...args: Parameters<typeof createIntegrationHarness>) { const h = await createIntegrationHarness(...args); opened.push(h); return h }

let callSeq = 0
interface Answer { status: string; consultation_id: string; child_session_id: string; diagnosis: string }
/** Call the REAL tool through the runtime pipeline so the assertions see what a model would. */
async function call(h: IntegrationHarness, args: Record<string, unknown>, agent?: Agent): Promise<Answer> {
  const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> }
  const result = await tools.execute({ callId: ToolCallId(`alias-${++callSeq}`), name: CONSULT, arguments: args, agent: agent ?? h.root, signal: new AbortController().signal })
  const text = (result.content as readonly { type?: string; text?: string }[])
    .flatMap(block => block.type === 'text' ? [String(block.text ?? '')] : []).join('')
  return JSON.parse(text) as Answer
}
const verdicts = (count: number) => advisorScript(...Array.from({ length: count }, () => advisorVerdictResponse()))

describe('consultation_id: "last"', () => {
  it('refuses the alias when nothing was delivered, and dispatches nothing at all', async () => {
    const h = await harness({ weak: [textResponse('done')], advisor: verdicts(1) })
    const refused = await call(h, { question: 'Anything at all', consultation_id: 'last' })
    expect(refused.status).toBe('unavailable')
    expect(refused.diagnosis).toContain('no earlier manual consultation')
    // The critical property: it must NOT silently fall back to a fresh consultation.
    expect(h.adapter.forModel('advisor')).toHaveLength(0)
    expect(refused.child_session_id).toBe('')
    // Nothing was recorded, so a second attempt is refused just the same.
    const again = await call(h, { question: 'Again', consultation_id: 'last' })
    expect(again.status).toBe('unavailable')
    expect(h.adapter.forModel('advisor')).toHaveLength(0)
  })

  it('is scoped to the calling agent, so another agent cannot reach that conversation through it', async () => {
    const h = await harness({ weak: [textResponse('done'), textResponse('done')], advisor: verdicts(1) })
    const first = await call(h, { question: 'Root review' })
    expect(first.status, first.diagnosis).toBe('ok')

    const worker = await h.spawnWorker({ model: 'weak' })
    const workerAgent = worker.localAgent
    expect(workerAgent).toBeTruthy()

    // The root HAS a delivered manual consultation on this same root task, so a
    // root-wide lookup would hand it to the worker. It must not.
    const refused = await call(h, { question: 'Worker question', consultation_id: 'last' }, workerAgent)
    expect(refused.status).toBe('unavailable')
    expect(refused.diagnosis).toContain('no earlier manual consultation')
    expect(refused.child_session_id).toBe('')
  })
})
