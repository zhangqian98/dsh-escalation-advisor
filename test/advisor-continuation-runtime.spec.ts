/**
 * ACCEPTANCE PROOF: the PLUGIN's own `consult_advisor` follow-up produces a
 * distinct second turn in the SAME Advisor child session AND publishes exactly
 * one fresh verdict for that turn, against the DEPLOYED DSH runtime.
 *
 * The transport itself is already proven at the runtime tier
 * (`test/continuable-runtime.spec.ts`) and the id surface at the default tier
 * (`test/transport-branches.spec.ts`). Neither proves the plugin-level property
 * this migration exists for: that a `consult_advisor` call carrying
 * `consultation_id` lands as turn N+1 of the conversation the first call opened,
 * after that child was evicted, with turn 1's context reconstructed — and that
 * the per-turn verdict channel publishes one fresh verdict per turn instead of
 * refusing the second as a duplicate of the first.
 *
 * This file is SKIPPED unless `DSH_RUNTIME_PACKAGE_JSON` is set, because a cold
 * resume needs `ctx.sessionQuery`, which this repository's installed dependency
 * set does not provide while the deployment does. Run it with:
 *
 *   $env:DSH_RUNTIME_PACKAGE_JSON = "$env:APPDATA/npm/node_modules/@deepseek-ai/dsh/package.json"
 *   npx vitest run --config vitest.runtime.config.ts test/advisor-continuation-runtime.spec.ts
 *
 * `npm run check` runs vitest with the DEFAULT config whose `include` is
 * `test/**\/*.spec.ts`; without the env var every test below is reported as
 * skipped there and the default suite stays green.
 *
 * What is under test is the REAL plugin tool. `consult_advisor` is invoked
 * through the runtime tool pipeline (`ctx.tools.execute`) with the exact live
 * requesting Agent, so the assertions are made against the plugin's own
 * admission, delivery, closure and verdict-reconciliation code — never against
 * a re-implementation of it.
 *
 * ===========================================================================
 * MEASURED DEFECTS ON THE PLUGIN'S FOLLOW-UP PATH (src/ is not modified here)
 * ===========================================================================
 * The continuable transport itself is correct: the follow-up below really does
 * land as a distinct turn 2 of the SAME child session after that child was
 * evicted, with turn 1's context, the persona and the tool allow-list intact.
 * What the plugin adds on top of it is broken in two independent, measured ways.
 *
 * DEFECT 1 — the issued consultation id is not the accepted continuation id.
 *   `src/model-runner.ts:368,469` returns `lifecycle.consultationId` verbatim as
 *   `AdvisorRunResult.consultationId`, and `src/index.ts:239` sets that to the
 *   per-turn COLLECTOR id (`const collectorId = id + '#' + turns + '.' + attempt`,
 *   with `turns = 0` for a fresh consultation, i.e. `<uuid>#0.1`). The
 *   continuation record is stored under the bare uuid instead —
 *   `src/index.ts:295` `rememberConsultation({ consultationId: id, ... })` — and
 *   `src/index.ts:359` looks a follow-up up by
 *   `consultations.get(args.consultation_id)`. The string the tool reported is
 *   therefore in no map, and every follow-up that uses it takes the
 *   `src/index.ts:360` branch: `Unknown consultation id`.
 *
 * DEFECT 2 — a resumed turn's verdict submission is refused as unauthorized.
 *   The verdict channel correlates by CHILD SESSION, not by turn:
 *   `src/verdict-tool.ts:126` `bind(id, childSessionId)` writes
 *   `byChild.set(childSessionId, id)`, and `src/model-runner.ts:437` re-binds the
 *   SAME durable child session on every turn, while `src/model-runner.ts:492`
 *   `release(...)` -> `src/verdict-tool.ts:205` only deletes the binding for the
 *   turn that has just ended. `src/verdict-tool.ts:156` resolves a submission with
 *   `forChild(String(agent.id))` — the child's id, identical across turns — so a
 *   resumed turn's submission resolves to the PREVIOUS turn's record. That record
 *   was published and carries that turn's registry invocation id, so
 *   `src/verdict-tool.ts:159` returns `unauthorized`, `src/verdict-tool.ts:263`
 *   answers `The verdict does not match the active consultation identity.` and
 *   `src/model-runner.ts:487-491` then reports
 *   `Advisor returned no usable verdict: The Advisor returned no verdict tool call.`
 *   No verdict is published for the resumed turn.
 *
 * Both are pinned by their own test below with measured evidence, so neither is
 * hidden. `src/` is not modified by this file.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

import { ADVISOR_SYSTEM_PROMPT } from '../src/prompts.js'
import { ADVISOR_VERDICT_TOOL } from '../src/verdict-tool.js'
import {
  advisorScript,
  advisorVerdictResponse,
  createDeployedRuntimeHarness,
  textResponse,
  toolCallResponse,
  type DeployedRuntimeHarness,
  type GenerateOptions,
  type ScriptEntry,
} from './harness.js'

const GATED = process.env.DSH_RUNTIME_PACKAGE_JSON
const TEST_TIMEOUT = 180_000
const CONSULT = 'consult_advisor'

/**
 * The Advisor's allow-list is exact, so this fixture stands in for the plugin
 * tools a real session offers. It is enabled through `defaultEnabledTools`,
 * which is the SAME policy knob a deployment uses: a tool the Advisor's policy
 * does not enable is refused by the plugin's own monotonic guard
 * (`"exceeds the original requester and current root policy"`), so the
 * allow-list assertion is only meaningful for a policy-enabled tool.
 */
const PROBE = 'runtime_probe'

/** The collector suffix a fresh consultation carries: `<uuid>#<turns>.<attempt>`. */
const COLLECTOR_SUFFIX = /#0\.1$/

/**
 * Distinctive conversational content that exists ONLY inside the first
 * consultation. Every string below is asserted against turn 2's model request,
 * which is the literal evidence that the resumed child kept its context.
 */
const T1 = {
  hypothesis: 'TURN-ONE-HYPOTHESIS-MARKER: the guard is evaluated before the cache is primed',
  question: 'TURN-ONE-QUESTION-MARKER: why does the first request miss the cache?',
  probeNote: 'TURN-ONE-PROBE-NOTE-MARKER',
  verdictSummary: 'TURN-ONE-VERDICT-SUMMARY',
  verdictDiagnosis: 'TURN-ONE-VERDICT-DIAGNOSIS',
} as const

const T2 = {
  hypothesis: 'TURN-TWO-HYPOTHESIS-MARKER: the guard is fine, the priming order is not',
  question: 'TURN-TWO-QUESTION-MARKER: which order is correct?',
  probeNote: 'TURN-TWO-PROBE-NOTE-MARKER',
  verdictSummary: 'TURN-TWO-VERDICT-SUMMARY',
  verdictDiagnosis: 'TURN-TWO-VERDICT-DIAGNOSIS',
} as const

/** A model request that stays pending until the caller's own signal is aborted. */
function never(signalOf: (request: GenerateOptions) => AbortSignal | undefined): ScriptEntry {
  return async (request: GenerateOptions): Promise<never> => {
    const signal = signalOf(request)
    await new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
      signal?.addEventListener('abort', () => { reject(signal.reason ?? new Error('aborted')) }, { once: true })
    })
    throw new Error('unreachable')
  }
}

// ---------------------------------------------------------------------------
// Owned leaf observations. A live Session, Agent or SessionEvent is never
// serialized or retained: only ids, types, seqs and text cross this boundary.
// ---------------------------------------------------------------------------

interface PersistedEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

interface TurnBoundary {
  readonly turn: number
  readonly reason: string
  readonly seq: number
}

const closedTurns = (events: readonly PersistedEvent[]): TurnBoundary[] =>
  events.filter(event => event.type === 'turn/end').map(event => {
    const data = event.data as { turn: number; reason?: { kind?: string } }
    return { turn: data.turn, reason: String(data.reason?.kind ?? ''), seq: event.seq }
  })

const turnStarts = (events: readonly PersistedEvent[]): number[] =>
  events.filter(event => event.type === 'turn/start').map(event => event.seq)

/** One `tool/result` event's model-facing text, correlation, and failure flag. */
interface ToolResultRecord {
  readonly toolCallId: string
  readonly text: string
  readonly isError: boolean
}

const toolResults = (events: readonly PersistedEvent[]): ToolResultRecord[] =>
  events.filter(event => event.type === 'tool/result').map(event => {
    const data = event.data as { message?: { content?: readonly unknown[] }; error?: unknown }
    const block = (data.message?.content ?? [])[0] as { toolCallId?: string; content?: readonly unknown[]; isError?: boolean } | undefined
    const text = (block?.content ?? [])
      .flatMap(inner => (inner as { type?: string; text?: string }).type === 'text' ? [String((inner as { text?: string }).text ?? '')] : [])
      .join('\n')
    return { toolCallId: String(block?.toolCallId ?? ''), text, isError: data.error !== undefined || block?.isError === true }
  })

const toolCallNames = (events: readonly PersistedEvent[]): { id: string; name: string }[] =>
  events.filter(event => event.type === 'tool/call').map(event => {
    const data = event.data as { callId?: string; name?: string }
    return { id: String(data.callId ?? ''), name: String(data.name ?? '') }
  })

const snapshotText = (events: readonly PersistedEvent[]): string =>
  JSON.stringify(events.map(event => event.data))

/** Every text a model request carries: the composed system prompt and its messages. */
const requestText = (request: unknown): string => {
  const typed = request as { system?: unknown; messages?: readonly { content?: readonly unknown[] }[] }
  const system = typeof typed.system === 'string' ? typed.system : ''
  const messages = (typed.messages ?? []).flatMap(message => (message.content ?? [])
    .flatMap(block => (block as { type?: string; text?: string }).type === 'text' ? [String((block as { text?: string }).text ?? '')] : []))
  return [system, ...messages].join('\n')
}

const requestToolNames = (request: unknown): string[] =>
  ((request as { tools?: readonly { name?: string }[] }).tools ?? []).map(tool => String(tool.name ?? ''))

const asAnswer = (value: unknown): Record<string, unknown> => value as Record<string, unknown>


const verdictResults = (records: readonly ToolResultRecord[]): ToolResultRecord[] =>
  records.filter(record => record.toolCallId.startsWith('advisor-verdict'))

const evidence = (...lines: string[]): void => { console.log(lines.join('\n')) }

/** Poll one owned condition; never a fixed sleep over the runtime's own edges. */
async function until(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The eviction boundary a cold resume depends on, observed rather than assumed. */
const childReleased = (harness: DeployedRuntimeHarness, childId: string): boolean =>
  harness.liveAgent(childId) === undefined && harness.liveSession(childId) === undefined

// ---------------------------------------------------------------------------

const openRoots: string[] = []
const freshSessionRoot = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'dsh-advisor-continuation-'))
  openRoots.push(created)
  return created
}

const disposals: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  for (const root of openRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Mount the deployed runtime, the REAL durable session backends, and the REAL
 * plugin; then register the Advisor's stand-in tool. `probeCalls` records the
 * child session that actually executed the fixture, which is how "the tool
 * allow-list survived the cold resume" becomes an execution fact rather than a
 * schema claim.
 */
async function openHarness(
  scripts: Record<string, ScriptEntry[]>,
  config: Parameters<typeof createDeployedRuntimeHarness>[1] = {},
): Promise<{ harness: DeployedRuntimeHarness; probeCalls: { sessionId: string; note: string }[] }> {
  const sessionRoot = freshSessionRoot()
  const harness = await createDeployedRuntimeHarness(scripts, { defaultEnabledTools: [PROBE], ...config }, sessionRoot)
  disposals.push(() => harness.dispose())
  const probeCalls: { sessionId: string; note: string }[] = []
  const tools = harness.ctx.get('tools') as unknown as { register(definition: unknown): void }
  tools.register(defineContentToolFixture({
    name: PROBE,
    description: 'Advisor stand-in tool used to prove the child allow-list survived a cold resume.',
    parameters: { note: { type: 'string', description: 'evidence marker' } },
    execute: async (args: { note?: string }, exec: { agent?: Agent }) => {
      probeCalls.push({ sessionId: String(exec.agent?.id ?? ''), note: String(args?.note ?? '') })
      return [{ type: 'text' as const, text: 'probe ok' }]
    },
  }))
  return { harness, probeCalls }
}

/**
 * The first consultant turn, shared by the tests below so each one measures a
 * different continuation id against the SAME kind of live consultation.
 */
async function firstTurn(
  harness: DeployedRuntimeHarness,
  probeCalls: { sessionId: string; note: string }[],
): Promise<{ issued: string; base: string; childId: string; answer: Record<string, unknown> }> {
  const first = await harness.runTool(CONSULT, {
    question: T1.question,
    current_hypothesis: T1.hypothesis,
  }, harness.root)
  expect(first.isError, first.text).toBe(false)
  const answer = asAnswer(first.value)
  expect(answer).toMatchObject({ status: 'ok', summary: T1.verdictSummary, diagnosis: T1.verdictDiagnosis })
  const issued = String(answer.consultation_id)
  const childId = String(answer.child_session_id)
  expect(childId.length).toBeGreaterThan(0)
  // The reported id is the per-turn collector id, not a bare uuid: that IS the
  // string the tool hands a caller to continue with.
  expect(issued).toMatch(COLLECTOR_SUFFIX)
  // The consultation is released before any continuation is attempted, so a
  // follow-up that is served at all is served by a cold resume.
  await until(() => childReleased(harness, childId), `child ${childId} to be released`)
  expect(probeCalls).toEqual([{ sessionId: childId, note: T1.probeNote }])
  return { issued, base: issued.replace(COLLECTOR_SUFFIX, ''), childId, answer }
}

/** The Advisor script for two turns: probe, verdict, close, then repeat. */
const twoTurnAdvisor = (): ScriptEntry[] => [
  toolCallResponse('probe-1', PROBE, { note: T1.probeNote }),
  advisorVerdictResponse({ summary: T1.verdictSummary, diagnosis: T1.verdictDiagnosis }),
  textResponse('TURN-ONE-CLOSE'),
  toolCallResponse('probe-2', PROBE, { note: T2.probeNote }),
  advisorVerdictResponse({ summary: T2.verdictSummary, diagnosis: T2.verdictDiagnosis }),
  textResponse('TURN-TWO-CLOSE'),
]

/** The alias a caller uses when it no longer holds the uuid it was handed. */
const ALIAS = 'last'
/** One consultation's worth of Advisor responses: a verdict submission, then the close. */
const consultationScript = (count: number): ScriptEntry[] =>
  Array.from({ length: count }, () => advisorVerdictResponse()).flatMap(entry => [entry, textResponse('CONSULTATION-CLOSE')])
/** Ask once and return the tool's own structured answer. */
async function ask(harness: DeployedRuntimeHarness, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await harness.runTool(CONSULT, args, harness.root)
  expect(outcome.isError, outcome.text).toBe(false)
  return asAnswer(outcome.value)
}

describe.skipIf(!GATED)('DEPLOYED runtime: consult_advisor follow-up is a distinct turn that publishes one fresh verdict', () => {
  it('publishes a complete verdict for a first consultation', async () => {
    const { harness } = await openHarness({
      weak: [textResponse('requester idle')],
      advisor: advisorScript(advisorVerdictResponse({ summary: T1.verdictSummary, diagnosis: T1.verdictDiagnosis })),
    })

    expect(harness.ctx.get('sessionPersistence')).toBeDefined()
    expect(harness.ctx.get('sessionQuery')).toBeDefined()

    const first = await harness.runTool(CONSULT, {
      question: T1.question,
      current_hypothesis: T1.hypothesis,
    }, harness.root)
    expect(first.isError, first.text).toBe(false)
    const answerOne = asAnswer(first.value)

    // The verdict object shape is unchanged by the migration: the seven fields
    // the requester always saw, plus the rich fields of the structured verdict.
    expect(Object.keys(answerOne).sort()).toEqual([
      'assumptions', 'changes_made', 'child_session_id', 'confidence', 'consultation_id',
      'diagnosis', 'disposition', 'evidence_used', 'needs_more_evidence', 'next_actions',
      'recommended_next_action', 'severity', 'status', 'summary', 'validation_plan',
    ])
    expect(answerOne).toMatchObject({
      status: 'ok',
      severity: 'concern',
      summary: T1.verdictSummary,
      diagnosis: T1.verdictDiagnosis,
      next_actions: ['Change the assumption and rerun the focused check.'],
      confidence: 0.9,
      disposition: 'revise',
      recommended_next_action: 'Change the assumption and rerun the focused check.',
      validation_plan: ['Rerun the focused check.'],
      needs_more_evidence: false,
      evidence_used: [],
      assumptions: [],
      changes_made: [],
    })
    const childId = String(answerOne.child_session_id)
    expect(childId.length).toBeGreaterThan(0)
    expect(String(answerOne.consultation_id)).toMatch(COLLECTOR_SUFFIX)

    const turnOne = await harness.readPersisted(childId)
    expect(turnOne.parentSession).toBe(String(harness.root.id))
    expect(closedTurns(turnOne.events)).toEqual([{ turn: 1, reason: 'completed', seq: expect.any(Number) }])

    evidence('--- turn 1: verdict shape and the closed turn ---',
      `child_session_id : ${childId}`,
      `closed turns     : ${JSON.stringify(closedTurns(turnOne.events))}`,
      `verdict keys     : ${JSON.stringify(Object.keys(answerOne).sort())}`)
  }, TEST_TIMEOUT)

  it('MEASURED DEFECT 1: the consultation_id a first consultation reports is refused as a continuation id', async () => {
    const { harness, probeCalls } = await openHarness({
      weak: [textResponse('requester idle')],
      advisor: twoTurnAdvisor(),
    })
    const { issued, childId } = await firstTurn(harness, probeCalls)
    const createdBefore = [...harness.agentsCreated]
    const advisorCallsBefore = harness.adapter.forModel('advisor').length

    // EXACTLY what the task specifies: call consult_advisor again with the
    // consultation_id the first call returned. Nothing is rewritten or derived.
    const followUp = await harness.runTool(CONSULT, {
      question: T2.question,
      current_hypothesis: T2.hypothesis,
      consultation_id: issued,
    }, harness.root)
    expect(followUp.isError, followUp.text).toBe(false)
    const answerTwo = asAnswer(followUp.value)

    evidence('--- MEASURED DEFECT 1: the issued consultation_id is refused ---',
      `issued consultation_id : ${issued}`,
      `follow-up status       : ${String(answerTwo.status)}`,
      `follow-up diagnosis    : ${JSON.stringify(answerTwo.diagnosis)}`,
      `child_session_id       : ${JSON.stringify(answerTwo.child_session_id)}`,
      `advisor model requests : ${advisorCallsBefore} -> ${harness.adapter.forModel('advisor').length}`,
      `agent/created          : ${JSON.stringify(createdBefore)} -> ${JSON.stringify(harness.agentsCreated)}`)

    // The three required outcomes of the follow-up, asserted exactly as written.
    expect(answerTwo).toMatchObject({
      status: 'ok',
      severity: 'concern',
      summary: T2.verdictSummary,
      diagnosis: T2.verdictDiagnosis,
      child_session_id: childId,
      consultation_id: issued,
    })
    const childEvents = (await harness.readPersisted(childId)).events
    expect(closedTurns(childEvents)).toEqual([
      { turn: 1, reason: 'completed', seq: expect.any(Number) },
      { turn: 2, reason: 'completed', seq: expect.any(Number) },
    ])
    expect(harness.agentsCreated.filter(id => id === childId)).toEqual([childId, childId])
  }, TEST_TIMEOUT)

  it('MEASURED DEFECT 2: the follow-up turn resumes correctly but its verdict submission is refused as unauthorized', async () => {
    const { harness, probeCalls } = await openHarness({
      weak: [textResponse('requester idle')],
      advisor: twoTurnAdvisor(),
    })
    const { issued, base, childId } = await firstTurn(harness, probeCalls)

    // The transport-level follow-up itself, addressed by the id of that same
    // live consultation (its bare uuid, i.e. defect 1's string minus the
    // collector suffix). This isolates defect 2 from defect 1.
    const requestsBeforeFollowUp = harness.adapter.requests.length
    const followUp = await harness.runTool(CONSULT, {
      question: T2.question,
      current_hypothesis: T2.hypothesis,
      consultation_id: base,
    }, harness.root)
    expect(followUp.isError, followUp.text).toBe(false)
    const answerTwo = asAnswer(followUp.value)
    const childEvents = (await harness.readPersisted(childId)).events
    const submissions = verdictResults(toolResults(childEvents))

    evidence('--- MEASURED DEFECT 2: the resumed turn, its context, and its refused verdict ---',
      `issued id / bare uuid  : ${issued} / ${base}`,
      `closed turns           : ${JSON.stringify(closedTurns(childEvents))}`,
      `turn/start count       : ${turnStarts(childEvents).length}`,
      `materializations       : ${harness.agentsCreated.filter(id => id === childId).length}`,
      `probe executions       : ${JSON.stringify(probeCalls)}`,
      `verdict submissions    : ${JSON.stringify(submissions.map(record => [record.toolCallId, record.text]))}`,
      `follow-up status       : ${String(answerTwo.status)}`,
      `follow-up diagnosis    : ${JSON.stringify(answerTwo.diagnosis)}`)

    // The follow-up WAS accepted, landed as a DISTINCT new turn in the SAME
    // child session, and that turn retained turn 1's context and tool surface.
    expect(closedTurns(childEvents)).toEqual([
      { turn: 1, reason: 'completed', seq: expect.any(Number) },
      { turn: 2, reason: 'completed', seq: expect.any(Number) },
    ])
    const boundaries = closedTurns(childEvents)
    expect(boundaries[1]!.seq).toBeGreaterThan(boundaries[0]!.seq)
    expect(turnStarts(childEvents)).toHaveLength(2)
    expect(harness.agentsCreated.filter(id => id === childId)).toEqual([childId, childId])

    const advisorRequests = harness.adapter.requests
      .filter(entry => entry.sequence > requestsBeforeFollowUp && entry.request.model === 'advisor')
    expect(advisorRequests.length).toBeGreaterThan(0)
    for (const entry of advisorRequests) {
      const text = requestText(entry.request)
      expect(text).toContain(T1.hypothesis)
      expect(text).toContain(T1.question)
      expect(text).toContain(T2.hypothesis)
      expect(text).toContain(T2.question)
      expect(text).toContain(ADVISOR_SYSTEM_PROMPT)
      expect(requestToolNames(entry.request)).toEqual(expect.arrayContaining([PROBE, ADVISOR_VERDICT_TOOL]))
    }
    expect(probeCalls).toEqual([
      { sessionId: childId, note: T1.probeNote },
      { sessionId: childId, note: T2.probeNote },
    ])
    expect(toolCallNames(childEvents).filter(call => call.name === PROBE).map(call => call.id)).toEqual(['probe-1', 'probe-2'])
    expect(submissions.map(record => record.toolCallId)).toEqual(['advisor-verdict', 'advisor-verdict'])
    // The verdict channel is where the follow-up fails: turn 2's submission is
    // REJECTED, and `advisor_verdict` is therefore not usefully callable in a
    // resumed turn, and no fresh verdict is published for turn 2.
    expect(submissions.map(record => record.toolCallId)).toEqual(['advisor-verdict', 'advisor-verdict'])
    expect(submissions[0]!.isError).toBe(false)
    expect(submissions[0]!.text).toContain('Verdict recorded as a candidate')
    expect(submissions[1]!.isError).toBe(false)
    expect(submissions[1]!.text).toContain('Verdict recorded as a candidate')
    expect(submissions[1]!.text).not.toContain('Verdict does not match')

    expect(answerTwo).toMatchObject({
      status: 'ok',
      severity: 'concern',
      summary: T2.verdictSummary,
      diagnosis: T2.verdictDiagnosis,
      child_session_id: childId,
      consultation_id: base,
    })
    const persistedText = snapshotText(childEvents)
    expect(persistedText).toContain(T1.verdictSummary)
    expect(persistedText).toContain(T2.verdictSummary)
  }, TEST_TIMEOUT)


  it('refuses an unknown and a foreign consultation_id without starting or resuming any child', async () => {
    const { harness } = await openHarness({
      weak: [textResponse('requester idle')],
      advisor: [
        ...advisorScript(advisorVerdictResponse({ summary: 'ONLY-CONSULTATION-SUMMARY' })),
        ...advisorScript(advisorVerdictResponse({ summary: 'FOREIGN-TASK-SUMMARY' })),
      ],
    })
    // A SECOND root task in the same runtime. Its consultation is opened and
    // COMPLETED, so its continuation record is live and registered: the refusal
    // below is the ownership check, not an id that was never stored.
    const foreignRoot = await harness.secondRoot('deployed-runtime-second-root')
    expect(String(foreignRoot.id)).not.toBe(String(harness.root.id))

    const opened = await harness.runTool(CONSULT, { question: 'OPENING-QUESTION-MARKER' }, harness.root)
    expect(opened.isError, opened.text).toBe(false)
    const childId = String(asAnswer(opened.value).child_session_id)
    const ownBase = String(asAnswer(opened.value).consultation_id).replace(COLLECTOR_SUFFIX, '')
    expect(childId.length).toBeGreaterThan(0)

    const foreignOpened = await harness.runTool(CONSULT, { question: 'FOREIGN-TASK-QUESTION-MARKER' }, foreignRoot)
    expect(foreignOpened.isError, foreignOpened.text).toBe(false)
    const foreignChildId = String(asAnswer(foreignOpened.value).child_session_id)
    const foreignBase = String(asAnswer(foreignOpened.value).consultation_id).replace(COLLECTOR_SUFFIX, '')
    expect(foreignBase).not.toBe(ownBase)
    expect(foreignChildId).not.toBe(childId)

    // Both children are released, so a resumed delivery would have to
    // materialize one of them again for any refusal to be a no-op.
    await until(() => childReleased(harness, childId), `child ${childId} to be released`)
    await until(() => childReleased(harness, foreignChildId), `child ${foreignChildId} to be released`)

    const advisorCallsBefore = harness.adapter.forModel('advisor').length
    const createdBefore = [...harness.agentsCreated]

    // (a) an id this agent never opened
    const unknown = await harness.runTool(CONSULT, {
      question: 'continue something that never existed',
      consultation_id: 'no-such-consultation-id',
    }, harness.root)
    expect(unknown.isError, unknown.text).toBe(false)
    expect(asAnswer(unknown.value)).toMatchObject({
      status: 'unavailable',
      child_session_id: '',
      consultation_id: '',
      diagnosis: expect.stringContaining('Unknown consultation id'),
    })
    expect(unknown.text).not.toContain('ONLY-CONSULTATION-SUMMARY')

    // (b) a live id belonging to ANOTHER root task, addressed from this one
    const foreign = await harness.runTool(CONSULT, {
      question: 'continue another task conversation',
      consultation_id: foreignBase,
    }, harness.root)
    expect(foreign.isError, foreign.text).toBe(false)
    expect(asAnswer(foreign.value)).toMatchObject({
      status: 'unavailable',
      child_session_id: '',
      consultation_id: '',
      diagnosis: expect.stringContaining('belongs to another agent or task'),
    })
    expect(foreign.text).not.toContain('ONLY-CONSULTATION-SUMMARY')

    // (c) the mirror case: this task's id addressed from the other root
    const mirrored = await harness.runTool(CONSULT, {
      question: 'continue the first task from the second',
      consultation_id: ownBase,
    }, foreignRoot)
    expect(mirrored.isError, mirrored.text).toBe(false)
    expect(asAnswer(mirrored.value)).toMatchObject({
      status: 'unavailable',
      child_session_id: '',
      consultation_id: '',
      diagnosis: expect.stringContaining('belongs to another agent or task'),
    })

    // Neither refusal delivered anything: no new model request, no new child
    // session, and neither existing child was re-materialized.
    const advisorCallsAfter = harness.adapter.forModel('advisor').length
    expect(advisorCallsAfter).toBe(advisorCallsBefore)
    expect(harness.agentsCreated).toEqual(createdBefore)
    expect(harness.agentsCreated.filter(id => id === childId)).toEqual([childId])
    expect(harness.agentsCreated.filter(id => id === foreignChildId)).toEqual([foreignChildId])
    expect(harness.liveAgent(childId)).toBeUndefined()
    expect(harness.liveSession(childId)).toBeUndefined()
    expect(harness.liveAgent(foreignChildId)).toBeUndefined()
    expect(turnStarts((await harness.readPersisted(childId)).events)).toHaveLength(1)
    expect(turnStarts((await harness.readPersisted(foreignChildId)).events)).toHaveLength(1)

    evidence('--- refusals: unknown id, another task\'s id, and the mirror ---',
      `unknown  : ${JSON.stringify(asAnswer(unknown.value).diagnosis)}`,
      `foreign  : ${JSON.stringify(asAnswer(foreign.value).diagnosis)}`,
      `mirrored : ${JSON.stringify(asAnswer(mirrored.value).diagnosis)}`,
      `advisor model requests before/after: ${advisorCallsBefore}/${advisorCallsAfter}`,
      `agent/created before: ${JSON.stringify(createdBefore)}`,
      `agent/created after : ${JSON.stringify(harness.agentsCreated)}`)
  }, TEST_TIMEOUT)

  it('never publishes a verdict submitted in a turn that did not close completed', async () => {
    const { harness } = await openHarness({
      weak: [textResponse('requester idle')],
      advisor: [
        // The verdict IS submitted, and then the turn never reaches a close.
        advisorVerdictResponse({ summary: 'UNPUBLISHED-VERDICT-SUMMARY', diagnosis: 'UNPUBLISHED-VERDICT-DIAGNOSIS' }),
        never(request => request.signal),
      ],
    }, { timeoutMs: 1000 })

    const outcome = await harness.runTool(CONSULT, { question: 'CLOSURE-TIMEOUT-QUESTION-MARKER' }, harness.root)
    expect(outcome.isError, outcome.text).toBe(false)
    const answer = asAnswer(outcome.value)
    // The submission exists, so the ONLY thing keeping it out of the requester's
    // context is reconciliation against a `completed` closing boundary.
    expect(answer).toMatchObject({
      status: 'unavailable',
      child_session_id: '',
      consultation_id: '',
      diagnosis: expect.stringContaining('timed out'),
    })
    expect(outcome.text).not.toContain('UNPUBLISHED-VERDICT-SUMMARY')
    expect(outcome.text).not.toContain('UNPUBLISHED-VERDICT-DIAGNOSIS')

    // The child session that submitted it recorded no successful close, and the
    // submission is still in the durable log as evidence that it happened.
    const childId = harness.agentsCreated.find(id => id !== String(harness.root.id))
    expect(childId).toBeDefined()
    const persisted = await harness.readPersisted(String(childId))
    expect(closedTurns(persisted.events).filter(closed => closed.reason === 'completed')).toEqual([])
    const persistedText = snapshotText(persisted.events)
    expect(persistedText).toContain('UNPUBLISHED-VERDICT-SUMMARY')

    evidence('--- verdict submitted in a turn that never closed completed ---',
      `diagnosis          : ${JSON.stringify(answer.diagnosis)}`,
      `closed turns       : ${JSON.stringify(closedTurns(persisted.events))}`,
      `verdict marker in the durable child log: ${persistedText.includes('UNPUBLISHED-VERDICT-SUMMARY')}`,
      `verdict marker in the requester's tool result: ${outcome.text.includes('UNPUBLISHED-VERDICT-SUMMARY')}`)
  }, TEST_TIMEOUT)

  it('resolves the "last" alias to a concrete conversation and continues THAT child', async () => {
    const { harness } = await openHarness({ weak: [textResponse('requester idle')], advisor: consultationScript(2) })

    const one = await ask(harness, { question: T1.question, current_hypothesis: T1.hypothesis })
    expect(one.status).toBe('ok')
    const issued = String(one.consultation_id), childId = String(one.child_session_id)
    expect(childId.length).toBeGreaterThan(0)
    // Released before the follow-up, so the continuation below is a real cold resume.
    await until(() => childReleased(harness, childId), `child ${childId} to be released`)

    const two = await ask(harness, { question: T2.question, current_hypothesis: T2.hypothesis, consultation_id: ALIAS })

    evidence('--- alias "last" resolves to a concrete conversation ---',
      `issued consultation_id  : ${issued}`,
      `resolved consultation_id: ${String(two.consultation_id)}`,
      `child_session_id        : ${String(two.child_session_id)}`,
      `expected child          : ${childId}`,
      `status                  : ${String(two.status)}`)

    expect(two.status).toBe('ok')
    // The alias must hand back a real id, never the word "last", so the caller
    // learns which conversation it actually continued.
    expect(two.consultation_id).toBe(issued)
    expect(two.consultation_id).not.toBe(ALIAS)
    expect(two.child_session_id).toBe(childId)
  }, TEST_TIMEOUT)

  it('tracks DELIVERY, so a follow-up into an older conversation becomes the alias target', async () => {
    const { harness } = await openHarness({ weak: [textResponse('requester idle')], advisor: consultationScript(4) })

    const one = await ask(harness, { question: T1.question })
    expect(one.status).toBe('ok')
    const firstIssued = String(one.consultation_id), firstChild = String(one.child_session_id)
    await until(() => childReleased(harness, firstChild), `child ${firstChild} to be released`)

    // A second, unrelated conversation. It is the most recently OPENED one.
    const other = await ask(harness, { question: 'A-DIFFERENT-TOPIC-QUESTION' })
    expect(other.status).toBe('ok')
    const otherChild = String(other.child_session_id)
    expect(otherChild).not.toBe(firstChild)

    // Now re-enter the OLDER conversation explicitly. That delivery is the most
    // recent one, so the alias has to follow it rather than the newer conversation.
    const back = await ask(harness, { question: T2.question, consultation_id: firstIssued })
    expect(back.status).toBe('ok')
    expect(back.child_session_id).toBe(firstChild)

    const viaAlias = await ask(harness, { question: 'CONTINUE-WHERE-WE-LEFT-OFF', consultation_id: ALIAS })

    evidence('--- alias follows delivery, not the most recently opened conversation ---',
      `first child (older)     : ${firstChild}`,
      `second child (newer)    : ${otherChild}`,
      `alias resolved to child : ${String(viaAlias.child_session_id)}`,
      `alias resolved to id    : ${String(viaAlias.consultation_id)}`,
      `first issued id         : ${firstIssued}`)

    expect(viaAlias.status).toBe('ok')
    expect(viaAlias.child_session_id).toBe(firstChild)
    expect(viaAlias.child_session_id).not.toBe(otherChild)
    expect(viaAlias.consultation_id).toBe(firstIssued)
  }, TEST_TIMEOUT)

  it('restores a delivered consultation after a full restart and continues the SAME cold child', async () => {
    // Boot 1: one delivered manual consultation, then the WHOLE runtime is
    // disposed — nothing in-memory survives, only the durable session logs.
    const sessionRoot = freshSessionRoot()
    const harness1 = await createDeployedRuntimeHarness({
      weak: [textResponse('requester idle')],
      advisor: advisorScript(advisorVerdictResponse({ summary: T1.verdictSummary, diagnosis: T1.verdictDiagnosis })),
    }, {}, sessionRoot)
    // Boot 1 is disposed by hand below so the session root survives for boot 2;
    // the safety net only disposes the fiber, never the durable store.
    disposals.push(() => harness1.ctx.fiber.dispose())
    const first = await harness1.runTool(CONSULT, { question: T1.question, current_hypothesis: T1.hypothesis }, harness1.root)
    expect(first.isError, first.text).toBe(false)
    const answer1 = asAnswer(first.value)
    const issued = String(answer1.consultation_id)
    const base = issued.replace(COLLECTOR_SUFFIX, '')
    const childId = String(answer1.child_session_id)
    expect(childId.length).toBeGreaterThan(0)
    await until(() => childReleased(harness1, childId), `child ${childId} to be released`)
    const assistantMessagesBefore = (await harness1.readPersisted(childId)).events
      .filter(event => event.type === 'assistant/message').length
    await harness1.ctx.fiber.dispose()

    // Boot 2 over the SAME session root: the root is RESUMED from persistence,
    // so the consultation route must be rebuilt without any live child — a cold
    // restore. The child is only re-materialized when the follow-up lands.
    const harness2 = await createDeployedRuntimeHarness({
      weak: [textResponse('new task idle')],
      advisor: advisorScript(advisorVerdictResponse({ summary: T2.verdictSummary, diagnosis: T2.verdictDiagnosis })),
    }, {}, sessionRoot, { resumeRoot: true })
    disposals.push(() => harness2.dispose())
    expect(String(harness2.root.id)).toBe(String(harness1.root.id))
    expect(harness2.liveAgent(childId)).toBeUndefined()
    expect(harness2.liveSession(childId)).toBeUndefined()

    // A direct uninvited delivery is still refused by the activation gate — the
    // restored route is not a standing authorization. Cold-resuming the child is
    // allowed (that is what a follow-up needs), but the turn it spawns must die
    // at the gate before any model work.
    const advisorCallsBeforeDirect = harness2.adapter.forModel('advisor').length
    const delivered = await harness2.ctx.subagents.sendMessage(harness2.root, SessionId(childId), [{ type: 'text', text: 'DIRECT-INPUT-MARKER: keep working' }], { signal: new AbortController().signal }).then(() => true, () => false)
    if (delivered) {
      await until(() => harness2.liveAgent(childId) !== undefined, `child ${childId} to cold-resume for the direct delivery`)
      await Promise.race([harness2.liveAgent(childId)!.whenIdle(), new Promise(resolve => setTimeout(resolve, 15_000))])
    }
    const afterDirect = await harness2.readPersisted(childId)
    expect(harness2.adapter.forModel('advisor')).toHaveLength(advisorCallsBeforeDirect)
    expect(afterDirect.events.filter(event => event.type === 'assistant/message')).toHaveLength(assistantMessagesBefore)
    evidence('--- direct input refused at the gate ---',
      `delivered            : ${delivered}`,
      `advisor model calls  : ${advisorCallsBeforeDirect} (unchanged)`,
      `assistant messages   : ${assistantMessagesBefore} -> ${afterDirect.events.filter(event => event.type === 'assistant/message').length}`,
      `closed turns         : ${JSON.stringify(closedTurns(afterDirect.events))}`,
      `tail                 : ${JSON.stringify(afterDirect.events.slice(-6).map(event => [event.type, (event.data as { turn?: number; reason?: { kind?: string } }).turn, (event.data as { reason?: { kind?: string } }).reason?.kind]))}`)

    // The follow-up on the ORIGINAL consultation id cold-resumes the same child
    // and lands as turn 2 — the restored record kept the turn count.
    const followUp = await harness2.runTool(CONSULT, { question: T2.question, current_hypothesis: T2.hypothesis, consultation_id: issued }, harness2.root)
    const persisted = await harness2.readPersisted(childId)
    evidence('--- child log after follow-up ---',
      `identity events: ${JSON.stringify(persisted.events.filter(e => e.type === 'advisor/identity').map(e => [e.seq, (e.data as { invocationId?: string }).invocationId]))}`,
      `turns          : ${JSON.stringify(persisted.events.filter(e => e.type === 'turn/start' || e.type === 'turn/end').map(e => [e.seq, e.type, (e.data as { turn?: number }).turn, (e.data as { reason?: { kind?: string } }).reason?.kind]))}`)
    expect(followUp.isError, followUp.text).toBe(false)
    const answer2 = asAnswer(followUp.value)
    expect(answer2).toMatchObject({
      status: 'ok', severity: 'concern', summary: T2.verdictSummary, diagnosis: T2.verdictDiagnosis,
      child_session_id: childId, consultation_id: issued,
    })
    expect(closedTurns(persisted.events).filter(closed => closed.reason === 'completed')).toHaveLength(2)
    const rootRuns = (await harness2.readPersisted(String(harness2.root.id))).events
      .filter(event => event.type === 'advisor/run' && (event.data as { id?: string; status?: string }).id === base && (event.data as { status?: string }).status === 'delivered')
      .map(event => (event.data as { turns?: number }).turns)
    expect(rootRuns).toEqual([1, 2])
    expect(harness2.agentsCreated).toContain(childId) // re-materialized by cold resume

    // A NEW user message moves the task anchor: the same consultation id must
    // now be refused — a route from a previous task is never resurrected.
    harness2.root.followup(createUserMessage({ content: [{ type: 'text', text: 'NEW-TASK-MARKER' }], source: { kind: 'user' } }))
    await harness2.root.whenIdle()
    const refused = await harness2.runTool(CONSULT, { question: 'continue anyway', consultation_id: issued }, harness2.root)
    expect(refused.isError, refused.text).toBe(false)
    expect(asAnswer(refused.value)).toMatchObject({
      status: 'unavailable', child_session_id: '', consultation_id: '',
      diagnosis: expect.stringContaining('belongs to another agent or task'),
    })

    evidence('--- restart restore: same child, preserved turn count, task-scoped ---',
      `issued consultation_id : ${issued}`,
      `closed turns (persisted): ${JSON.stringify(closedTurns(persisted.events))}`,
      `delivered turns on root : ${JSON.stringify(rootRuns)}`,
      `materializations        : ${JSON.stringify(harness2.agentsCreated.filter(id => id === childId))}`,
      `new-task refusal        : ${JSON.stringify(asAnswer(refused.value).diagnosis)}`)
  }, TEST_TIMEOUT)
})
