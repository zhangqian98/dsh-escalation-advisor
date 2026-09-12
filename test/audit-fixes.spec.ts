import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { deadlineSignal, installTurnObserver } from '../src/model-runner.js'
import { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import { AdvisorRegistry } from '../src/registry.js'
import { classifyToolOutcome, EscalationTracker } from '../src/state.js'
import { ObligationStore } from '../src/obligations.js'
import { MAX_CASE_PACKET_BYTES, buildCasePacket, fitCasePacket, hasNewMaterialConclusion } from '../src/context.js'
import { AdvisorVerdictCollector } from '../src/verdict-tool.js'
import { VERDICT_FIELD_BUDGETS, parseVerdict, verdictFromStructured } from '../src/verdict.js'
import { advisorRunHistory } from '../src/telemetry.js'
import {
  advisorScript,
  advisorVerdictResponse,
  createIntegrationHarness,
  textResponse,
  toolCallResponse,
  type IntegrationHarness,
} from './harness.js'

const opened: IntegrationHarness[] = []
afterEach(async () => { for (const h of opened.splice(0)) await h.ctx.fiber.dispose() })
async function harness(...args: Parameters<typeof createIntegrationHarness>) {
  const h = await createIntegrationHarness(...args)
  opened.push(h)
  return h
}

describe('P0: Advisor turn activation gate', () => {
  it('admits only the authorized invocation while it is live', async () => {
    const h = await harness({})
    const registry = new AdvisorRegistry(h.ctx)
    const { invocationId, release } = registry.reserve(h.root, h.root, ['read'])
    try {
      // A bare reservation authorizes nothing: only authorizeTurn opens the window.
      expect(registry.isTurnAuthorized('not-yet-known', invocationId)).toBe(false)
      registry.authorizeTurn({ invocationId, collectorId: 'c1', ttlMs: 60000 })
      // Pre-bind window of a fresh start: no child yet, but the invocation is live.
      expect(registry.isTurnAuthorized('not-yet-known', invocationId)).toBe(true)
      expect(registry.isTurnAuthorized('not-yet-known', 'forged-invocation')).toBe(false)
      registry.bindTurn({ invocationId, childSessionId: 'child-1', messageId: 'm-1' })
      expect(registry.isTurnAuthorized('child-1', invocationId)).toBe(true)
      expect(registry.isTurnAuthorized('child-1', 'other-invocation')).toBe(false)
      expect(registry.isTurnAuthorized('other-child', invocationId)).toBe(false)
      // Once the claimed turn is known, only that turn is authorized.
      registry.noteClaimedTurn('child-1', 'm-1', 5)
      expect(registry.isTurnAuthorized('child-1', invocationId, 5)).toBe(true)
      expect(registry.isTurnAuthorized('child-1', invocationId, 6)).toBe(false)
      // A competing message in the same child never becomes the authorized turn.
      registry.noteClaimedTurn('child-1', 'm-attacker', 6)
      expect(registry.isTurnAuthorized('child-1', invocationId, 5)).toBe(true)
      expect(registry.isTurnAuthorized('child-1', invocationId, 6)).toBe(false)
      // Revocation is scoped: a stale cleanup for another invocation is a no-op.
      registry.revokeTurn('child-1', 'other-invocation')
      expect(registry.isTurnAuthorized('child-1', invocationId, 5)).toBe(true)
      registry.revokeTurn('child-1', invocationId)
      expect(registry.isTurnAuthorized('child-1', invocationId, 5)).toBe(false)
    } finally {
      release()
    }
  })

  it('preserves the early-claimed turn across the runner bind order', async () => {
    const h = await harness({})
    const registry = new AdvisorRegistry(h.ctx)
    const { invocationId, release } = registry.reserve(h.root, h.root, ['read'])
    try {
      registry.authorizeTurn({ invocationId, collectorId: 'c1', ttlMs: 60000 })
      const deadline = deadlineSignal(new AbortController().signal, 60000)
      try {
        const observer = installTurnObserver(h.ctx, deadline, undefined, (claimedId, claimedTurn) => {
          registry.noteClaimedTurn('child-9', claimedId, claimedTurn)
        })
        // The delivered message is claimed BEFORE dispatch resolves, while the
        // child and message id are still unknown to the caller.
        const fake = { id: 'child-9' } as unknown as Agent
        agentEvents(h.ctx, fake).emit('agent/inbox/claimed', { message: { id: 'm-9' }, turn: 3 } as unknown as never)
        // The runner binds the delivered message BEFORE replaying buffered claims:
        // replaying first would find no binding and lose the claimed turn.
        expect(registry.bindTurn({ invocationId, childSessionId: 'child-9', messageId: 'm-9' })).toBe(true)
        observer.bind('child-9', 'm-9')
        expect(registry.isTurnAuthorized('child-9', invocationId, 3)).toBe(true)
        expect(registry.isTurnAuthorized('child-9', invocationId, 4)).toBe(false)
        observer.dispose()
      } finally { deadline.dispose() }
    } finally { release() }
  })

  it('taints competing turns claimed during the window so they stay refused', async () => {
    const h = await harness({})
    const registry = new AdvisorRegistry(h.ctx)
    const { invocationId, release } = registry.reserve(h.root, h.root, ['read'])
    try {
      registry.authorizeTurn({ invocationId, collectorId: 'c1', ttlMs: 60000 })
      const deadline = deadlineSignal(new AbortController().signal, 60000)
      try {
        // Wired exactly like the runner: own claims bind the turn, foreign ones taint it.
        const observer = installTurnObserver(h.ctx, deadline, 'child-9', (claimedId, claimedTurn, isOwn, claimSession) => {
          if (claimSession !== 'child-9') return
          if (isOwn) registry.noteClaimedTurn('child-9', claimedId, claimedTurn)
          else registry.noteForeignTurn('child-9', claimedTurn)
        })
        const fake = { id: 'child-9' } as unknown as Agent
        // A competing delivery is claimed first, while the authorized message id
        // is still unknown: it can only look like a session candidate for now.
        agentEvents(h.ctx, fake).emit('agent/inbox/claimed', { message: { id: 'm-x' }, turn: 7 } as unknown as never)
        expect(registry.bindTurn({ invocationId, childSessionId: 'child-9', messageId: 'm-9' })).toBe(true)
        // Replaying the buffer with the message known taints the foreign turn...
        observer.bind('child-9', 'm-9')
        expect(registry.isTurnAuthorized('child-9', invocationId, 7)).toBe(false)
        // ...while the authorized delivery still binds and admits exactly its turn.
        agentEvents(h.ctx, fake).emit('agent/inbox/claimed', { message: { id: 'm-9' }, turn: 8 } as unknown as never)
        expect(registry.isTurnAuthorized('child-9', invocationId, 8)).toBe(true)
        expect(registry.isTurnAuthorized('child-9', invocationId, 7)).toBe(false)
        expect(registry.isTurnAuthorized('child-9', invocationId, 9)).toBe(false)
        observer.dispose()
      } finally { deadline.dispose() }
    } finally { release() }
  })

  it('scopes a follow-up reservation to its child and refuses binding clobbers', async () => {
    const h = await harness({})
    const registry = new AdvisorRegistry(h.ctx)
    const a = registry.reserve(h.root, h.root, ['read'])
    const b = registry.reserve(h.root, h.root, ['read'])
    try {
      registry.authorizeTurn({ invocationId: a.invocationId, collectorId: 'ca', childSessionId: 'child-A', ttlMs: 60000 })
      expect(registry.isTurnAuthorized('child-A', a.invocationId)).toBe(true)
      // A follow-up reservation names its child: no other child is admitted.
      expect(registry.isTurnAuthorized('child-B', a.invocationId)).toBe(false)
      // A strict bind without a live reservation manufactures nothing.
      expect(registry.bindTurn({ invocationId: 'unknown-invocation', childSessionId: 'child-B', messageId: 'm' })).toBe(false)
      expect(registry.isTurnAuthorized('child-B', 'unknown-invocation')).toBe(false)
      // An overlapping turn keeps the older binding: authorize and bind both
      // refuse to clobber a live activation (the runner refuses the overlap).
      registry.authorizeTurn({ invocationId: b.invocationId, collectorId: 'cb', childSessionId: 'child-A', ttlMs: 60000 })
      expect(registry.activationFor('child-A')?.invocationId).toBe(a.invocationId)
      expect(registry.bindTurn({ invocationId: b.invocationId, childSessionId: 'child-A', messageId: 'm-b' })).toBe(false)
      expect(registry.isTurnAuthorized('child-A', a.invocationId)).toBe(true)
      expect(registry.isTurnAuthorized('child-A', b.invocationId)).toBe(false)
    } finally { a.release(); b.release() }
  })

  it('enforces exact batch purity once the delivery is bound', () => {
    const base = { invocationId: 'inv', collectorId: 'c', messageId: 'm-1', turn: 3, expiresAt: Date.now() + 60000 }
    // Exactly the authorized delivery: admitted.
    expect(AdvisorRegistry.stepAdmits(base, 'inv', 3, ['m-1'])).toBe(true)
    // A step carrying nothing new falls back to the turn binding.
    expect(AdvisorRegistry.stepAdmits(base, 'inv', 3, [])).toBe(true)
    // A foreign message batched into our own turn contaminates it: refused.
    expect(AdvisorRegistry.stepAdmits(base, 'inv', 3, ['m-1', 'm-x'])).toBe(false)
    // A step carrying only foreign content: refused.
    expect(AdvisorRegistry.stepAdmits(base, 'inv', 3, ['m-x'])).toBe(false)
    // Wrong turn, wrong invocation, or expiry: refused.
    expect(AdvisorRegistry.stepAdmits(base, 'inv', 4, ['m-1'])).toBe(false)
    expect(AdvisorRegistry.stepAdmits(base, 'other', 3, ['m-1'])).toBe(false)
    expect(AdvisorRegistry.stepAdmits({ ...base, expiresAt: Date.now() - 1 }, 'inv', 3, ['m-1'])).toBe(false)
    // Unbound activation (pre-bind window): nonce-bearer admitted without batch check.
    const unbound = { invocationId: 'inv', collectorId: 'c', expiresAt: Date.now() + 60000 }
    expect(AdvisorRegistry.stepAdmits(unbound, 'inv', 3, ['anything'])).toBe(true)
    expect(AdvisorRegistry.stepAdmits(unbound, 'other', 3, ['anything'])).toBe(false)
    // Tainted turn refused even with the exact batch.
    expect(AdvisorRegistry.stepAdmits({ ...base, taintedTurns: new Set([3]) }, 'inv', 3, ['m-1'])).toBe(false)
  })

  it('expires activations past their deadline', async () => {
    const h = await harness({})
    const registry = new AdvisorRegistry(h.ctx)
    const { invocationId, release } = registry.reserve(h.root, h.root, ['read'])
    try {
      registry.authorizeTurn({ invocationId, collectorId: 'c1', ttlMs: 1 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(registry.isTurnAuthorized('child-x', invocationId)).toBe(false)
    } finally {
      release()
    }
  })

  it('refuses post-delivery turns into the Advisor child before any model work', async () => {
    const h = await harness({
      weak: [toolCallResponse('m', 'consult_advisor', { question: 'Review this' }), textResponse('done')],
      advisor: advisorScript(advisorVerdictResponse()),
    })
    await h.runRoot('Review this task')
    // The consultation above delivered, which proves authorized Advisor steps pass
    // the activation gate; only the post-delivery state is asserted here.
    const delivered = advisorRunHistory(h.root).find(run => run.status === 'delivered')
    expect(delivered?.childSessionId).toBeTruthy()
    const advisorCalls = h.adapter.forModel('advisor').length
    expect(advisorCalls).toBeGreaterThan(0)
    // No live activation survives the delivered turn (per-turn authorize/bind/revoke
    // lifecycle pinned by the registry unit tests above), so any later turn of this
    // child — a Web-composer prompt or a generic send_message — must be refused at
    // pre-step before budgets, locks, or the strong model. In this harness the child
    // is additionally evicted after close, so the runtime's own cold-resume guard
    // (which requires sessionQuery) refuses first; on runtimes WITH sessionQuery the
    // activation gate is the enforcer. Either way no new strong-model work may occur.
    await expect(h.sendToChild(delivered!.childSessionId!, 'Continue analyzing the whole repo and edit code')).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(h.adapter.forModel('advisor')).toHaveLength(advisorCalls)
    expect(advisorRunHistory(h.root).filter(run => run.status === 'delivered')).toHaveLength(1)
  }, 15000)
})

describe('P0: claim obligations close only through a real validation identity', () => {
  const failure = (store: ObligationStore, seq: number, validationKey = 'vk-check') =>
    store.recordFailure({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq, at: seq, callId: 'c' + seq, validationKey, summary: 'check failed' })
  const pass = (store: ObligationStore, startedSeq: number, completedSeq: number, validationKey = 'vk-check') =>
    store.recordValidation({ sessionId: 's', taskStartSeq: 0, scope: 'scope', validationKey, callId: 'p' + completedSeq, startedSeq, completedSeq, succeeded: true })

  it('resolves a keyed claim after correction plus a later pass of the same validation', () => {
    const store = new ObligationStore()
    failure(store, 10)
    const claim = store.recordClaimContradiction({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq: 11, at: 11, claimId: 'claim-1', summary: 'published claim', validationKey: 'vk-check' })
    expect(store.open('s', 0).map(item => item.id)).toContain(claim.id)
    // Correction alone never closes.
    store.recordCorrection('s', 0, claim.id, { claimId: 'claim-1', document: 'doc', change: 'fix', evidence: 'counterexample', at: 12, seq: 12 })
    expect(store.open('s', 0).map(item => item.id)).toContain(claim.id)
    // A pass that started before the latest failure is not a witness.
    expect(pass(store, 5, 13)).toHaveLength(0)
    expect(store.open('s', 0).map(item => item.id)).toContain(claim.id)
    // A later pass with no related change since closes both the failure and the claim.
    const resolved = pass(store, 14, 15)
    expect(resolved.map(item => item.id)).toContain(claim.id)
    expect(store.open('s', 0)).toHaveLength(0)
  })

  it('never closes a keyless claim, even with correction and passing runs', () => {
    const store = new ObligationStore()
    const claim = store.recordClaimContradiction({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq: 10, at: 10, claimId: 'claim-x', summary: 'unverifiable claim' })
    store.recordCorrection('s', 0, claim.id, { claimId: 'claim-x', document: 'doc', change: 'fix', evidence: 'note', at: 11, seq: 11 })
    failure(store, 9, 'vk-unrelated-check')
    expect(pass(store, 12, 13)).toHaveLength(0)
    expect(store.open('s', 0).map(item => item.id)).toContain(claim.id)
  })

  it('lets a keyless claim gain its verified identity on re-registration', () => {
    const store = new ObligationStore()
    const first = store.recordClaimContradiction({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq: 10, at: 10, claimId: 'claim-1', summary: 'first report' })
    expect(first.validationKey).toBeUndefined()
    const second = store.recordClaimContradiction({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq: 11, at: 11, claimId: 'claim-1', summary: 're-reported with check', validationKey: 'vk-check' })
    expect(second.id).toBe(first.id)
    expect(second.validationKey).toBe('vk-check')
  })
})

describe('P1: verdict reconciliation binds the candidate to its own turn', () => {
  const fakeAgent = (id: string, turn: number, seq: number) => ({
    id,
    session: { seq, snapshotEvents: () => [{ type: 'step/start', data: { turn } }] },
  }) as unknown as Agent
  const verdict = () => verdictFromStructured({ severity: 'concern', summary: 's', diagnosis: 'd' }, 'raw')

  it('refuses a closing boundary from a different turn or message', () => {
    const collector = new AdvisorVerdictCollector()
    collector.open({ id: 'c1', invocationId: 'inv1', requesterId: 'r', rootId: 'root' })
    collector.bind('c1', 'child-1')
    expect(collector.submit(fakeAgent('child-1', 4, 10), { invocationId: 'inv1', requesterId: 'r' }, verdict())).toBe('accepted')
    expect(collector.reconcile('c1', { stopReason: 'completed', turnEnd: { seq: 11, kind: 'completed' }, turn: 7 }).published).toBe(false)
    expect(collector.reconcile('c1', { stopReason: 'completed', turnEnd: { seq: 11, kind: 'completed' }, turn: 4, messageId: 'a', authorizedMessageId: 'b' }).published).toBe(false)
    const ok = collector.reconcile('c1', { stopReason: 'completed', turnEnd: { seq: 11, kind: 'completed' }, turn: 4, messageId: 'a', authorizedMessageId: 'a' })
    expect(ok.published).toBe(true)
  })
})

describe('P1: packet and verdict budgets', () => {
  it('bounds a hostile case packet and reports what was omitted', async () => {
    const h = await harness({})
    const evidence = Array.from({ length: 10000 }, (_, index) => 'Evidence ' + index + ': ' + 'fact '.repeat(200))
    const packet = buildCasePacket({
      requester: h.root,
      root: h.root,
      mode: 'manual',
      question: 'Review everything',
      consultationId: 'consultation-1',
      evidence,
      failedAttempts: Array.from({ length: 100 }, (_, index) => 'attempt ' + index),
      allowedTools: ['read'],
      unavailableTools: [],
      mutationPolicy: 'propose-only',
    })
    expect(Buffer.byteLength(packet.prompt)).toBeLessThanOrEqual(MAX_CASE_PACKET_BYTES + 64)
    const parsed = JSON.parse(packet.prompt) as { requester_supplied: { evidence: string[]; failed_attempts: string[] }; truncation: { requester_evidence_omitted: number; failed_attempts_omitted: number } }
    expect(parsed.requester_supplied.evidence).toHaveLength(8)
    expect(parsed.requester_supplied.failed_attempts).toHaveLength(8)
    expect(parsed.truncation.requester_evidence_omitted).toBe(9992)
    expect(parsed.truncation.failed_attempts_omitted).toBe(92)
  })

  it('degrades an oversized packet structurally: always parseable, omissions recorded', () => {
    // A packet that cannot fit even after the build-time caps, but that the
    // graduated degradation can still rescue: sections are big enough to
    // overflow 48 KB together, small enough to survive once the low-priority
    // ones are dropped.
    const huge = 'x'.repeat(64 * 1024)
    const mid = 'y'.repeat(2048)
    const packet = {
      schema_version: 1,
      consultation: { id: 'c', mode: 'manual', task_start_seq: 0, last_seq: 5 },
      requester: { role: 'root', session_id: 'root', cwd: mid },
      task: { root_objective: 'o'.repeat(8192), success_criteria: Array.from({ length: 12 }, () => 'c'.repeat(1024)) },
      question: { exact_question: 'q'.repeat(4096), current_hypothesis: 'h'.repeat(4096), decision_needed: 'd'.repeat(4096) },
      requester_supplied: { evidence: Array.from({ length: 8 }, () => mid), failed_attempts: Array.from({ length: 8 }, () => mid), authority: 'claims-for-review' },
      attempts: Array.from({ length: 8 }, () => ({ action: mid, outcome: 'failed' })),
      failures: Array.from({ length: 4 }, (_, index) => ({ call_id: 'f' + index, tool: 'bash', repeat_count: 1 })),
      validation: Array.from({ length: 10 }, (_, index) => ({ call_id: 'v' + index, tool: 'bash', outcome: 'failed', relevant_to_problem: false })),
      workspace: { observed_changed_paths: Array.from({ length: 40 }, () => 'p'.repeat(512)) },
      prior_advice: Array.from({ length: 4 }, () => ({ summary: mid })),
      capabilities: { allowed_tools: ['read'], unavailable_tools: [], mutation_policy: 'propose-only' },
      tool_activity: Array.from({ length: 20 }, (_, index) => ({ call_id: 't' + index, tool: 'bash', arguments_summary: mid, outcome: 'failed' })),
      recent_tail: Array.from({ length: 12 }, () => ({ role: 'assistant', summary: mid })),
      truncation: { requester_evidence_omitted: 100 },
    }
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeGreaterThan(MAX_CASE_PACKET_BYTES)
    const fitted = fitCasePacket(packet)
    const serialized = JSON.stringify(fitted)
    // The whole point: it parses, it fits, and the omissions are visible.
    expect(() => JSON.parse(serialized)).not.toThrow()
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_CASE_PACKET_BYTES)
    const parsed = JSON.parse(serialized)
    expect(parsed.truncation.packet_budget_bytes).toBe(MAX_CASE_PACKET_BYTES)
    expect(parsed.recent_tail).toHaveLength(0)
    expect(parsed.tool_activity).toHaveLength(0)
    // The build-time counter stays truthful through the extra degradation.
    expect(parsed.truncation.requester_evidence_omitted).toBe(104)
    // The absolute floor: even pathological input yields a minimal valid packet.
    const pathological = { schema_version: 1, consultation: { id: 'c' }, question: { exact_question: huge }, filler: Array.from({ length: 100 }, () => huge) }
    const floor = fitCasePacket(pathological)
    expect(() => JSON.parse(JSON.stringify(floor))).not.toThrow()
    expect(Buffer.byteLength(JSON.stringify(floor))).toBeLessThanOrEqual(MAX_CASE_PACKET_BYTES)
    expect((floor.truncation as { degraded_to?: string } | undefined)?.degraded_to).toBe('minimal')
  })

  it('bounds verdict fields and the total delivered verdict', () => {
    const big = 'x'.repeat(100000)
    const parsed = verdictFromStructured({ severity: 'concern', summary: big, diagnosis: big, next_actions: [big, big], evidence_used: [{ kind: 'log', reference: big }], validation_plan: [big, big, big] }, big)
    expect(Buffer.byteLength(parsed.summary)).toBeLessThanOrEqual(VERDICT_FIELD_BUDGETS.summary + 64)
    expect(Buffer.byteLength(parsed.diagnosis)).toBeLessThanOrEqual(VERDICT_FIELD_BUDGETS.diagnosis + 1024)
    // The whole structured verdict fits the aggregate budget exactly — not with
    // slack, and not by cutting serialized JSON.
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(VERDICT_FIELD_BUDGETS.totalDelivered)
    const unstructured = parseVerdict(big)
    expect(Buffer.byteLength(unstructured.raw)).toBeLessThanOrEqual(VERDICT_FIELD_BUDGETS.totalDelivered + 64)
    expect(Buffer.byteLength(JSON.stringify(unstructured))).toBeLessThanOrEqual(VERDICT_FIELD_BUDGETS.totalDelivered)
  })

  it('fits a verdict whose bounded arrays alone exceed the aggregate budget', () => {
    const big = 'x'.repeat(20000)
    // Every bounded array at its per-field cap: ~100 KB before the fitter runs.
    const parsed = verdictFromStructured({
      severity: 'blocker', summary: 'All checks failed', diagnosis: big,
      next_actions: Array.from({ length: 8 }, () => 'a'.repeat(1024)),
      evidence_used: Array.from({ length: 16 }, () => ({ kind: 'log', reference: 'r'.repeat(512) })),
      assumptions: Array.from({ length: 12 }, () => 's'.repeat(512)),
      recommended_next_action: 'r'.repeat(2048),
      validation_plan: Array.from({ length: 12 }, () => 'v'.repeat(1024)),
      changes_made: Array.from({ length: 12 }, () => ({ paths: ['p'.repeat(200)], reason: 'r'.repeat(1024), validation: Array.from({ length: 12 }, () => 'v'.repeat(1024)) })),
      confidence: 0.9, disposition: 'review', needs_more_evidence: false,
    }, big)
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(VERDICT_FIELD_BUDGETS.totalDelivered)
    // The fitter preserves the verdict's spine: severity, summary and the
    // first next-actions still carry signal.
    expect(parsed.severity).toBe('blocker')
    expect(parsed.summary).toBe('All checks failed')
    expect(parsed.diagnosis.length).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(parsed))).toMatchObject({ severity: 'blocker' })
  })
})

describe('P1: watermark survives evidence saturation and conclusions', () => {
  function failingHarness(failCount: number, verdictCount: number) {
    const fails = Array.from({ length: failCount }, (_, index) => toolCallResponse('f' + index, 'fails', {}))
    return harness({
      weak: [...fails, toolCallResponse('manual', 'consult_advisor', { question: 'Review these failures' }), toolCallResponse('g1', 'fails', {}), toolCallResponse('g2', 'fails', {}), textResponse('Done.'), textResponse('Settled.'), textResponse('Closed.'), textResponse('Extra.'), textResponse('Final.')],
      advisor: advisorScript(...Array.from({ length: verdictCount }, (_, index) => advisorVerdictResponse({ summary: 'review-' + index }))),
    }, { mode: 'escalate', scoreThreshold: 1, maxAutoConsultsPerTurn: 30, maxAutoConsultsPerProblem: 30, cooldownTurns: 0 })
  }

  it('keeps a monotonic observation revision past the 24-entry evidence cap', () => {
    // The bounded evidence array saturates at 24 with shift(); a length-based
    // review cursor would stop advancing there. The watermark reads this counter.
    const tracker = new EscalationTracker()
    const config = { scoreThreshold: 1, toolErrorWeight: 2, repeatedFailureWeight: 3, nonZeroExitWeight: 1, repeatedMutationWeight: 2, repeatedMutationCount: 3, maxAutoConsultsPerTurn: 10, maxAutoConsultsPerProblem: 10, cooldownTurns: 0 } as never
    for (let index = 0; index < 30; index++) {
      tracker.observe('a', { callId: 'c' + index, name: 'bash', arguments: { command: 'echo ok' }, isError: false, value: { exitCode: 0, output: 'ok' }, contentText: 'ok', scope: 'task:a:0' }, config)
    }
    expect(tracker.evidence('a')).toHaveLength(24)
    expect(tracker.observationCount('a')).toBe(30)
  })

  it('marks masked shell exits compound while preserving reporting idioms', () => {
    const outcome = (command: string, exitCode: number, name = 'bash') => classifyToolOutcome({ name, arguments: { command }, isError: false, value: { exitCode, output: 'o' }, contentText: 'o', scope: 'task:a:0' })
    // Masked exits: same target identity, but no success proof.
    expect(outcome('npm test; true', 0).compound).toBe(true)
    expect(outcome('npm test && deploy', 0).compound).toBe(true)
    expect(outcome('true || npm test', 0).compound).toBe(true)
    expect(outcome('npm test | tee log | grep ok', 0).compound).toBe(true)
    expect(outcome('npm test | true', 0).compound).toBe(true)
    expect(outcome('npm test | ./mutate.sh', 0).compound).toBe(true)
    // A POSIX pipeline reports its LAST stage: `npm test | tee` exits with
    // tee's status, so the check's exit never reached the harness — the run has
    // no per-process exit provenance and cannot close anything.
    expect(outcome('npm test | tee build.log', 0).compound).toBe(true)
    expect(outcome('npm test | tee build.log', 0).exitSource).toBe('pipeline-tail')
    expect(outcome('npm test | tail -20', 0).compound).toBe(true)
    // The pipe only masks when it follows the check: `tee log | npm test`
    // reports the check's own exit in any shell.
    expect(outcome('tee log | npm test', 0).compound ?? false).toBe(false)
    // PowerShell is different: cmdlet stages never touch $LASTEXITCODE, so a
    // cmdlet tail keeps the check's own exit. A native-looking tail (more,
    // less, head) is not a cmdlet and still masks.
    expect(outcome('npm test | Select-Object -First 40', 0, 'pwsh').compound ?? false).toBe(false)
    expect(outcome('npm test | Tee-Object build.log', 0, 'pwsh').compound ?? false).toBe(false)
    expect(outcome('npm test | more', 0, 'pwsh').compound).toBe(true)
    expect(outcome('npm test; > wiped.ts', 0).compound).toBe(true)
    // Reporting tails keep attribution in PowerShell (bare literals report) and
    // before the check in any shell; in bash a quoted tail executes, so it masks.
    expect(outcome('npm test; "TSC_EXIT=$LASTEXITCODE"', 0, 'pwsh').compound ?? false).toBe(false)
    expect(outcome('npm test; "true"', 0, 'bash').compound).toBe(true)
    expect(outcome('npm test; echo done', 0, 'bash').compound).toBe(true)
    expect(outcome('npm test; echo done', 0, 'pwsh').compound).toBe(true)
    expect(outcome('grep needle file; npm test', 0).compound ?? false).toBe(false)
    // Faithful shapes: bare check, wrappers, redirects, trailing &&, one pipe.
    expect(outcome('npm test', 0).compound ?? false).toBe(false)
    expect(outcome('time npm test', 0).compound ?? false).toBe(false)
    expect(outcome('npm test > out.log 2>&1', 0).compound ?? false).toBe(false)
    expect(outcome('cd sub && npm test', 0).compound ?? false).toBe(false)
    expect(outcome('npm test 2>&1 | Select-Object -First 40', 0, 'pwsh').compound ?? false).toBe(false)
    expect(outcome('npm test', 0).exitSource).toBe('check')
    expect(outcome('npm test; true', 0).exitSource).toBe('masked')
    // Identity is unaffected: masked and plain runs name the same target.
    expect(outcome('npm test; true', 0).validationKey).toBe(outcome('npm test', 0).validationKey)
  })
  it('detects material conclusions newer than the watermark seq', () => {
    const events = [
      { type: 'user/message', seq: 1, data: {} },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Root cause found in auth.ts: the guard compared strings, therefore login failed for all users. Fixed and validated.' }] } } },
    ]
    expect(hasNewMaterialConclusion(events, 2)).toBe(true)
    expect(hasNewMaterialConclusion(events, 3)).toBe(false)
    expect(hasNewMaterialConclusion(events.slice(0, 2), 1)).toBe(false)
    expect(hasNewMaterialConclusion([], 0)).toBe(false)
  })
})

describe('P0: claim registration conflicts and recovery through the public tool', () => {
  let callSeq = 0
  async function runTool(h: IntegrationHarness, name: string, args: Record<string, unknown>): Promise<{ text: string }> {
    const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> }
    const result = await tools.execute({ callId: ToolCallId('audit-' + (++callSeq)), name, arguments: args, agent: h.root, signal: new AbortController().signal })
    const text = (result.content as readonly { type?: string; text?: string }[]).flatMap(block => block.type === 'text' ? [String(block.text ?? '')] : []).join('')
    return { text }
  }
  function shellFixture(h: IntegrationHarness, outcomes: Map<string, { exitCode: number; output: string }[]>) {
    h.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Scripted shell for obligation tests.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.output }] },
      execute: async (args) => {
        const outcome = outcomes.get(args.command)?.shift()
        if (!outcome) throw new Error('No scripted outcome left for command: ' + JSON.stringify(args.command))
        return { exitCode: outcome.exitCode, output: outcome.output }
      },
    }))
  }
  const pass = (output: string) => ({ exitCode: 0, output })

  it('closes a keyed claim end to end through the model pipeline', async () => {
    // Direct pipeline calls share one session seq, so witnesses (which need a
    // strictly later dispatch boundary) can only be exercised through runRoot.
    // The model-emitted call ids below ARE the tracker evidence ids.
    const h = await harness({
      weak: [
        toolCallResponse('val-test', 'bash', { command: 'npm test' }),
        toolCallResponse('val-lint', 'bash', { command: 'npm run lint' }),
        toolCallResponse('reg', 'advisor_obligation', { action: 'register', claim_id: 'C1', summary: 'PIPE-MARKER publish claims green', validation_call_id: 'val-test' }),
        // No id: the tool resolves the unique open item for the claim id.
        toolCallResponse('corr', 'advisor_obligation', { action: 'correct', claim_id: 'C1', document: 'doc', change: 'fix', evidence: 'counterexample' }),
        toolCallResponse('val-test-2', 'bash', { command: 'npm test' }),
        textResponse('done'),
      ],
      advisor: [],
    })
    shellFixture(h, new Map([
      ['npm test', [pass('12 passed'), pass('12 passed')]],
      ['npm run lint', [pass('clean')]],
    ]))
    await h.runRoot('Verify the published claim')
    const listed = JSON.parse((await runTool(h, 'advisor_obligation', { action: 'list' })).text) as { obligations: string[] }
    const done = listed.obligations.find(entry => entry.includes('PIPE-MARKER'))
    expect(done).toContain('resolved')
    expect(done).toContain('reverified-and-corrected')
    // Re-binding the closed claim to a different validation is refused outright.
    const clash = JSON.parse((await runTool(h, 'advisor_obligation', { action: 'register', claim_id: 'C1', summary: 're-bind attempt', validation_call_id: 'val-lint' })).text) as { message: string }
    expect(clash.message).toContain('already bound')
  }, 20000)

  it('issues distinct channel identities across consultations', async () => {
    const h = await harness({ weak: [textResponse('done')], advisor: advisorScript(advisorVerdictResponse(), advisorVerdictResponse()) })
    const first = JSON.parse((await runTool(h, 'consult_advisor', { question: 'First' })).text) as { status: string }
    const second = JSON.parse((await runTool(h, 'consult_advisor', { question: 'Second' })).text) as { status: string }
    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    const ids = advisorRunHistory(h.root).filter(run => run.status === 'delivered').map(run => run.collectorId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  }, 20000)

  it('recovers after a refused delivery without poisoning later turns', async () => {
    // Follow-ups to a delivered child cannot cold-resume in this harness (no
    // sessionQuery), so recovery is proven with a fresh consultation instead:
    // a refused delivery must not corrupt budgets, collectors, or routing.
    const h = await harness({ weak: [textResponse('done')], advisor: advisorScript(advisorVerdictResponse(), advisorVerdictResponse()) })
    const first = JSON.parse((await runTool(h, 'consult_advisor', { question: 'Review once' })).text) as { status: string; consultation_id: string; child_session_id: string; diagnosis: string }

    expect(first.status).toBe('ok')
    const subagents = h.ctx.get('subagents') as { sendMessage(...args: unknown[]): Promise<unknown> }
    vi.spyOn(subagents, 'sendMessage').mockRejectedValueOnce(new Error('injected timeout delivery failure'))
    const refused = JSON.parse((await runTool(h, 'consult_advisor', { question: 'Follow up', consultation_id: first.consultation_id })).text) as { status: string }
    expect(refused.status).toBe('unavailable')
    const fresh = JSON.parse((await runTool(h, 'consult_advisor', { question: 'Review again' })).text) as { status: string; child_session_id: string }
    expect(fresh.status).toBe('ok')
    expect(fresh.child_session_id).not.toBe(first.child_session_id)
    expect(advisorRunHistory(h.root).filter(run => run.status === 'delivered')).toHaveLength(2)
  }, 25000)
})
describe('P1: proof freshness across shells, turns, and dispatch loss', () => {
  function shellFixture(h: IntegrationHarness, outcomes: Map<string, { exitCode: number; output: string }[]>) {
    h.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Scripted shell.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.output }] },
      execute: async (args) => {
        const outcome = outcomes.get(args.command)?.shift()
        if (!outcome) throw new Error('No scripted outcome left for command: ' + JSON.stringify(args.command))
        if (outcome.exitCode !== 0) throw new Error(outcome.output)
        return { exitCode: outcome.exitCode, output: outcome.output }
      },
    }))
  }
  async function obligationsOf(h: IntegrationHarness): Promise<string[]> {
    const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> }
    const result = await tools.execute({ callId: ToolCallId('audit-list'), name: 'advisor_obligation', arguments: { action: 'list' }, agent: h.root, signal: new AbortController().signal })
    const text = (result.content as readonly { type?: string; text?: string }[]).flatMap(block => block.type === 'text' ? [String(block.text ?? '')] : []).join('')
    return (JSON.parse(text) as { obligations: string[] }).obligations
  }

  it('reopens a resolved obligation on a later shell mutation (not just edits)', async () => {
    // The passing check's own shell execution must not invalidate itself (same
    // call id is exempt); a LATER shell command reopens the proof it outdates.
    const h = await harness({
      weak: [toolCallResponse('t1', 'bash', { command: 'npm test' }), toolCallResponse('t2', 'bash', { command: 'npm test' }), toolCallResponse('e1', 'bash', { command: 'echo touch' }), textResponse('done')],
    })
    shellFixture(h, new Map([['npm test', [{ exitCode: 1, output: 'FAIL' }, { exitCode: 0, output: 'green' }]], ['echo touch', [{ exitCode: 0, output: 'touched' }]]]))
    await h.runRoot('Verify the suite')
    const items = await obligationsOf(h)
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(entry => entry.includes('/open'))).toBe(true)
  }, 20000)

  it('keeps every consultation turn visible instead of collapsing follow-ups', async () => {
    const { advisorRunHistory } = await import('../src/telemetry.js')
    const run = (id: string, attempt: number, status: string, collectorId?: string, turns?: number) => ({
      type: 'advisor/run', seq: 1,
      data: { version: 1 as const, id, requesterId: 'r', mode: 'manual' as const, turn: 0, attempt, status, ...(collectorId === undefined ? {} : { collectorId }), ...(turns === undefined ? {} : { turns }) },
    })
    const fakeRoot = { session: { snapshotEvents: () => [
      run('u1', 1, 'reserved', 'u1#0.1'), run('u1', 1, 'started', 'u1#0.1'), run('u1', 1, 'delivered', 'u1#0.1', 1),
      run('u1', 1, 'reserved', 'u1#1.1'), run('u1', 1, 'failed-transient', 'u1#1.1'),
      run('u1', 2, 'reserved', 'u1#1.2'), run('u1', 2, 'delivered', 'u1#1.2', 2),
    ] } } as unknown as Parameters<typeof advisorRunHistory>[0]
    const history = advisorRunHistory(fakeRoot)
    expect(history.map(item => [item.status, item.collectorId, item.turns])).toEqual([
      ['delivered', 'u1#0.1', 1],
      ['failed-transient', 'u1#1.1', undefined],
      ['delivered', 'u1#1.2', 2],
    ])
    // Attempts restart at 1 on every follow-up call, so the channel identity
    // carries a per-call nonce in production; history keys must not assume
    // bare attempt numbers are unique across calls.
  })
})
describe('P1: editing Advisor delivery', () => {
  it('delivers an editing Advisor review despite its own authorized edits', async () => {
    // The Advisor's own writes are reported in its verdict, not mistaken for
    // external interference: its review must deliver, not go stale on itself.
    // (Concurrent read-only reviews cannot exist beside it — the exclusive
    // workspace lease serializes editors against every reader.)
    const written: string[] = []
    const h = await harness({
      weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Fix it and review' }), textResponse('done')],
      advisor: [toolCallResponse('fix', 'write', { path: 'fix.ts' }), ...advisorScript(advisorVerdictResponse({ severity: 'concern', changes_made: [{ paths: ['fix.ts'], reason: 'Corrected the guard', validation: ['check passed'] }] }))],
    }, { defaultEnabledTools: ['write'] })
    h.ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Fixture write', parameters: { path: { type: 'string' } }, async execute(args) { written.push(String(args.path)); return [{ type: 'text', text: 'written' }] } }))
    await h.runRoot('Fix and review')
    expect(written).toEqual(['fix.ts'])
    const delivered = advisorRunHistory(h.root).filter(run => run.status === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.childSessionId).toBeTruthy()
  }, 20000)
})
describe('P1: masked exits, stale tasks, recurrence, and worker mirrors', () => {
  function shellOutcomes(entries: [string, { exitCode: number; output: string }[]][]): Map<string, { exitCode: number; output: string }[]> {
    return new Map(entries)
  }
  function registerBash(h: IntegrationHarness, outcomes: Map<string, { exitCode: number; output: string }[]>) {
    h.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Scripted shell.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.output }] },
      execute: async (args) => {
        const outcome = outcomes.get(args.command)?.shift()
        if (!outcome) throw new Error('No scripted outcome left for command: ' + JSON.stringify(args.command))
        if (outcome.exitCode !== 0) throw new Error(outcome.output)
        return { exitCode: outcome.exitCode, output: outcome.output }
      },
    }))
  }
  async function obligationsOf(h: IntegrationHarness): Promise<string[]> {
    const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> }
    const result = await tools.execute({ callId: ToolCallId('audit-list'), name: 'advisor_obligation', arguments: { action: 'list' }, agent: h.root, signal: new AbortController().signal })
    const text = (result.content as readonly { type?: string; text?: string }[]).flatMap(block => block.type === 'text' ? [String(block.text ?? '')] : []).join('')
    return (JSON.parse(text) as { obligations: string[] }).obligations
  }

  it('does not reset failure state on a masked compound success', async () => {
    // `npm test; true` exits 0 even when the suite fails: the target identity is
    // kept, but the success must neither reset the score nor witness anything.
    const h = await harness({
      weak: [toolCallResponse('f1', 'bash', { command: 'npm test' }), toolCallResponse('m1', 'bash', { command: 'npm test; true' }), toolCallResponse('f2', 'bash', { command: 'npm test' }), textResponse('done')],
      advisor: advisorScript(advisorVerdictResponse({ summary: 'masked-review' })),
    }, { mode: 'escalate', scoreThreshold: 3, maxAutoConsultsPerTurn: 10, maxAutoConsultsPerProblem: 10, cooldownTurns: 0 })
    registerBash(h, shellOutcomes([['npm test', [{ exitCode: 1, output: 'FAIL' }, { exitCode: 1, output: 'FAIL' }]], ['npm test; true', [{ exitCode: 0, output: 'masked ok' }]]]))
    await h.runRoot('Fix the suite')
    // Score 2 after the first failure (below 3, silent), still 2 after the masked
    // pass (no reset), then 2+2+3 past the threshold: exactly one escalation.
    expect(h.adapter.forModel('advisor')).toHaveLength(2)
    expect(advisorRunHistory(h.root).filter(run => run.status === 'delivered')).toHaveLength(1)
  }, 20000)

  it('quarantines a stale-task result from scoring and registration', async () => {
    const h = await harness({ weak: [textResponse('task B done')], advisor: [] }, { mode: 'escalate', scoreThreshold: 1, maxAutoConsultsPerTurn: 10, maxAutoConsultsPerProblem: 10, cooldownTurns: 0 })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    h.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Scripted shell.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.output }] },
      execute: async () => { await gate; throw new Error('FAIL from task A') },
    }))
    const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> }
    const pending = tools.execute({ callId: ToolCallId('stale-1'), name: 'bash', arguments: { command: 'npm test' }, agent: h.root, signal: new AbortController().signal })
    await h.runRoot('task B work')
    release()
    await pending
    // The task-A failure must not score task B, open anything visible in task B,
    // or leave registrable validation evidence behind.
    expect(await obligationsOf(h)).toHaveLength(0)
    const tools2 = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> }
    const attempt = await tools2.execute({ callId: ToolCallId('audit-reg'), name: 'advisor_obligation', arguments: { action: 'register', claim_id: 'CX', summary: 'stale claim', validation_call_id: 'stale-1' }, agent: h.root, signal: new AbortController().signal })
    const text = (attempt.content as readonly { type?: string; text?: string }[]).flatMap(block => block.type === 'text' ? [String(block.text ?? '')] : []).join('')
    expect(JSON.parse(text) as { message: string }).toMatchObject({ message: expect.stringContaining('Unknown validation_call_id') })
    expect(h.adapter.forModel('advisor')).toHaveLength(0)
  }, 25000)

  it('requires a fresh correction for a repeated contradiction', () => {
    const store = new ObligationStore()
    const failure = (seq: number) => store.recordFailure({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq, at: seq, callId: 'c' + seq, validationKey: 'vk', summary: 'f' })
    const pass = (started: number, completed: number, callId: string) => store.recordValidation({ sessionId: 's', taskStartSeq: 0, scope: 'scope', validationKey: 'vk', callId, startedSeq: started, completedSeq: completed, succeeded: true })
    failure(10)
    const claim = store.recordClaimContradiction({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq: 11, at: 11, claimId: 'C', summary: 'c', validationKey: 'vk' })
    store.recordCorrection('s', 0, claim.id, { claimId: 'C', document: 'd', change: 'x', evidence: 'e1', at: 12, seq: 12 })
    expect(pass(13, 14, 'p1')).not.toHaveLength(0)
    expect(store.open('s', 0)).toHaveLength(0)
    // A later contradiction reopens the same item but must not inherit the old
    // correction: the next pass alone closes nothing.
    store.recordClaimContradiction({ sessionId: 's', taskStartSeq: 0, scope: 'scope', seq: 15, at: 15, claimId: 'C', summary: 'c2', validationKey: 'vk' })
    const reopened = store.open('s', 0).find(item => item.id === claim.id)
    expect(reopened?.correction).toBeUndefined()
    expect(pass(16, 17, 'p2')).toHaveLength(0)
    expect(store.open('s', 0).map(item => item.id)).toContain(claim.id)
    store.recordCorrection('s', 0, claim.id, { claimId: 'C', document: 'd', change: 'x2', evidence: 'e2', at: 18, seq: 18 })
    expect(pass(19, 20, 'p3').map(item => item.id)).toContain(claim.id)
    expect(store.open('s', 0)).toHaveLength(0)
  })

  it('reopens a root proof on a later worker edit', async () => {
    const h = await harness({
      weak: [toolCallResponse('w-fail', 'bash', { command: 'npm test' }), toolCallResponse('w-pass', 'bash', { command: 'npm test' }), toolCallResponse('spawn', 'dispatch_worker', {}), textResponse('done'), textResponse('spare one'), textResponse('spare two')],
      worker: [toolCallResponse('w-edit', 'edit', { file_path: 'w.ts', content: 'x' }), textResponse('worker done')],
    })
    const npmOutcomes = new Map<string, { exitCode: number; output: string }[]>([['npm test', [{ exitCode: 1, output: 'FAIL' }, { exitCode: 0, output: 'green' }]]])
    h.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Scripted shell.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.output }] },
      execute: async (args) => {
        const outcome = npmOutcomes.get(args.command)?.shift()
        if (!outcome) throw new Error('No scripted outcome left for command: ' + JSON.stringify(args.command))
        if (outcome.exitCode !== 0) throw new Error(outcome.output)
        return { exitCode: outcome.exitCode, output: outcome.output }
      },
    }))
    h.ctx.tools.register(defineContentToolFixture({ name: 'edit', description: 'Fixture edit', parameters: { file_path: { type: 'string' }, content: { type: 'string' } }, async execute(args) { return [{ type: 'text', text: 'wrote ' + String(args.file_path) }] } }))
    h.ctx.tools.register(defineContentToolFixture({ name: 'dispatch_worker', description: 'Run one worker turn', parameters: {}, async execute() {
      const child = await h.spawnWorker()
      const result = await child.result
      await child.dispose()
      return result.output
    } }))
    await h.runRoot('Verify, then let the worker change a file')
    // Resolved by the passing re-run, then reopened by the worker edit that
    // outdates it: without the root-mirrored mutation it would stay resolved.
    expect((await obligationsOf(h)).some(entry => entry.includes('/open'))).toBe(true)
  }, 30000)
})
describe('P1: manual consultations suppress repeat automatic consultations', () => {
  it('covers the live problems of a manual review, not just its version', async () => {
    // Threshold 4 keeps the first failure below the auto line so the model consults
    // first. The manual review must then cover that live fingerprint: the repeat
    // failure after it re-arms nothing (same problem, same workspace), while any
    // failure the review never saw still would.
    const h = await harness(
      {
        weak: [
          toolCallResponse('f1', 'bash', { command: 'npm test' }),
          toolCallResponse('manual', 'consult_advisor', { question: 'Review this failure' }),
          toolCallResponse('f2', 'bash', { command: 'npm test' }),
          textResponse('Applied the manual review.'),
          textResponse('Turn two spare.'),
        ],
        advisor: advisorScript(
          advisorVerdictResponse({ summary: 'manual-review' }),
          advisorVerdictResponse({ summary: 'spare-never-used' }),
        ),
      },
      { mode: 'escalate', scoreThreshold: 4, maxAutoConsultsPerTurn: 10, maxAutoConsultsPerProblem: 10, cooldownTurns: 0 },
    )
    const outcomes = new Map<string, { exitCode: number; output: string }[]>()
    outcomes.set('npm test', [{ exitCode: 1, output: 'FAIL same' }, { exitCode: 1, output: 'FAIL same' }])
    h.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Scripted shell.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.output }] },
      execute: async (args) => {
        const outcome = outcomes.get(args.command)?.shift()
        if (!outcome) throw new Error('No scripted outcome left for command: ' + JSON.stringify(args.command))
        if (outcome.exitCode !== 0) throw new Error(outcome.output)
        return { exitCode: outcome.exitCode, output: outcome.output }
      },
    }))
    await h.runRoot('Fix the failure')
    const delivered = advisorRunHistory(h.root).filter(run => run.status === 'delivered')
    expect(delivered.map(run => run.mode)).toEqual(['manual'])
    expect(h.adapter.forModel('advisor')).toHaveLength(2)
  }, 20000)
})