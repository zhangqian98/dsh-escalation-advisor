import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { buildCasePacket } from '../src/context.js'

interface FakeEvent {
  type: string
  seq: number
  data: unknown
}

function fakeAgent(
  id: string,
  events: FakeEvent[],
  options: { parent?: string; inherited?: number } = {},
): Agent {
  return {
    id,
    session: {
      id,
      header: {
        id,
        isSeeded: options.inherited !== undefined,
        ...(options.parent ? { parentSession: options.parent, delegationDepth: 1 } : {}),
      },
      inheritedEventCount: options.inherited ?? 0,
      snapshotEvents: () => events,
    },
  } as unknown as Agent
}

function user(seq: number, text: string): FakeEvent {
  return {
    type: 'user/message',
    seq,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function call(seq: number, callId: string, name: string, args: unknown): FakeEvent {
  return {
    type: 'tool/call',
    seq,
    data: { callId, name, arguments: JSON.stringify(args), turn: 1, step: 1 },
  }
}

function result(seq: number, callId: string, text: string, isError = false): FakeEvent {
  return {
    type: 'tool/result',
    seq,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text }],
        }],
      },
      ...(isError ? { error: { name: 'Failure', code: 'FAILED' } } : {}),
    },
  }
}

function baseInput(requester: Agent, root: Agent) {
  return {
    requester,
    root,
    mode: 'manual' as const,
    question: 'What should change?',
    allowedTools: ['read', 'edit'],
    unavailableTools: ['bash'],
    mutationPolicy: 'propose-only' as const,
    consultationId: 'consult-1',
  }
}

describe('buildCasePacket', () => {
  it('excludes consultation transport from task evidence while preserving prior delivered advice', () => {
    const root = fakeAgent('root', [
      user(0, 'Review the interval function'),
      call(1, 'previous-consult', 'consult_advisor', { question: 'Earlier review' }),
      result(2, 'previous-consult', 'RAW_CONSULTATION_TRANSPORT'),
      { type: 'advisor/run', seq: 3, data: { requesterId: 'root', status: 'delivered', summary: 'Check the empty interval.' } },
      call(4, 'test', 'bash', { command: 'npm test interval' }), result(5, 'test', 'off-by-one assertion failed', true),
      call(6, 'current-consult', 'consult_advisor', { question: 'Review these findings' }),
    ])
    const output = buildCasePacket(baseInput(root, root))
    const packet = JSON.parse(output.prompt)
    expect(packet.tool_activity.map((entry: { call_id: string }) => entry.call_id)).toEqual(['test'])
    expect(packet.prior_advice[0].summary).toBe('Check the empty interval.')
    expect(output.prompt).not.toMatch(/current-consult|previous-consult|RAW_CONSULTATION_TRANSPORT|result-not-observed/)
  })
  it('retains the active durable objective across user steering but respects a later clear', () => {
    const events: FakeEvent[] = [user(0, 'Ship the service'), { type: 'goal/change', seq: 1, data: { operation: 'create', goal: { objective: 'Ship a validated service', phase: 'active', successCriteria: ['Targeted checks pass'] } } }, user(2, 'Prioritize the auth regression first')]
    const root = fakeAgent('root', events)
    const packet = JSON.parse(buildCasePacket(baseInput(root, root)).prompt)
    expect(packet.task.root_objective).toBe('Ship a validated service')
    expect(packet.task.success_criteria).toEqual(['Targeted checks pass'])
    events.push({ type: 'goal/change', seq: 3, data: { operation: 'clear' } }, user(4, 'A new task without an active goal'))
    expect(JSON.parse(buildCasePacket(baseInput(root, root)).prompt).task.root_objective).toBe('A new task without an active goal')
  })
  it('excludes earlier user-task records, late old results and unrelated prior advice', () => {
    const root = fakeAgent('root', [
      user(0, 'Old customer task'), call(1, 'old', 'read', { path: 'old-customer.json' }),
      result(2, 'old', 'OLD_PRIVATE_CUSTOMER_RECORD', true),
      { type: 'advisor/run', seq: 3, data: { requesterId: 'root', status: 'delivered', summary: 'OLD_PRIVATE_ADVICE', fingerprint: 'same-fp' } },
      user(4, 'Current compiler task'), result(5, 'old', 'LATE_OLD_PRIVATE_RESULT', true),
      call(6, 'current', 'bash', { command: 'npm test compiler' }), result(7, 'current', 'current compiler failure', true),
    ])
    const output = buildCasePacket({ ...baseInput(root, root), mode: 'escalation', trigger: { turn: 2, score: 5, shouldConsult: true, problemFingerprint: 'same-fp', signals: [] } })
    const packet = JSON.parse(output.prompt)
    expect(packet.failures).toHaveLength(1)
    expect(packet.failures[0].call_id).toBe('current')
    expect(output.prompt).not.toMatch(/OLD_PRIVATE|old-customer/)
    expect(packet.prior_advice).toEqual([])
  })
  it('uses canonical tracker outcomes, related validation and only the requester own prior advice', () => {
    const root = fakeAgent('root', [
      user(0, 'Old task'), user(1, 'Current auth task'),
      call(2, 'c1', 'bash', { command: 'npm test auth' }), result(3, 'c1', 'process exited with code 1'),
      { type: 'advisor/run', seq: 4, data: { requesterId: 'other-worker', status: 'delivered', summary: 'PRIVATE_WORKER_ADVICE' } },
      { type: 'advisor/run', seq: 5, data: { requesterId: 'root', status: 'delivered', summary: 'Check auth ordering', fingerprint: 'fp' } },
    ])
    const output = buildCasePacket({ ...baseInput(root, root), mode: 'escalation',
      trigger: { turn: 1, shouldConsult: true, score: 4, problemFingerprint: 'fp', signals: [{ kind: 'nonzero-exit', weight: 1, fingerprint: 'fp', detail: 'auth failed', validationKey: 'auth-test' }] },
      observedEvidence: [{ callId: 'c1', tool: 'bash', argumentsSummary: 'npm test auth', outcome: 'validation-failure', errorSummary: 'auth assertion failed', repeatCount: 2, validationKey: 'auth-test' }],
    })
    const packet = JSON.parse(output.prompt)
    expect(packet.task.root_objective).toBe('Current auth task')
    expect(packet.failures[0]).toMatchObject({ repeat_count: 2, error_summary: 'auth assertion failed' })
    expect(packet.validation[0].relevant_to_problem).toBe(true)
    expect(packet.prior_advice[0].summary).toBe('Check auth ordering')
    expect(output.prompt).not.toContain('PRIVATE_WORKER_ADVICE')
  })
  it('builds redacted JSON from durable root, child, and paired tool events', () => {
    const root = fakeAgent('root', [user(0, 'Ship the Unicode feature 你好')])
    const worker = fakeAgent('worker', [
      user(0, 'inherited root'),
      user(1, 'Implement the parser worker assignment'),
      call(2, 'edit-1', 'edit_file', { file_path: 'src/parser.ts', text: 'token=sk-1234567890abcdefghijkl' }),
      result(3, 'edit-1', 'updated src/parser.ts'),
      call(4, 'test-1', 'exec_command', { cmd: 'npm test -- parser' }),
      result(5, 'test-1', '1 test passed'),
    ], { parent: 'root', inherited: 1 })
    const output = buildCasePacket({
      ...baseInput(worker, root),
      evidence: ['api_key=super-secret-value'],
    })
    const packet = JSON.parse(output.prompt)
    expect(packet.schema_version).toBe(1)
    expect(packet.task.root_objective).toContain('你好')
    expect(packet.task.requester_assignment).toContain('parser worker assignment')
    expect(packet.tool_activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ call_id: 'edit-1', outcome: 'succeeded' }),
      expect.objectContaining({ call_id: 'test-1', outcome: 'succeeded' }),
    ]))
    expect(packet.workspace.observed_changed_paths).toEqual(['src/parser.ts'])
    expect(packet.validation[0]).toEqual(expect.objectContaining({ call_id: 'test-1', outcome: 'succeeded' }))
    expect(output.prompt).toContain('[REDACTED]')
    expect(output.prompt).not.toContain('super-secret-value')
    expect(output.prompt).not.toContain('sk-1234567890abcdefghijkl')
    expect(output.lastSeq).toBe(5)
  })

  it('preserves scoped evidence beyond the former byte cap together with the latest failure and capability policy', () => {
    const events: FakeEvent[] = [user(0, 'Fix the failing build')]
    for (let index = 1; index <= 5; index++) {
      events.push(call(index * 2 - 1, 'c' + index, 'exec_command', { cmd: 'npm test ' + 'old '.repeat(500) }))
      events.push(result(index * 2, 'c' + index, index === 5 ? 'LATEST_FAILURE_MARKER ' + '尾'.repeat(500) : 'old failure', true))
    }
    const root = fakeAgent('root', events)
    const output = buildCasePacket({
      ...baseInput(root, root),
      mode: 'escalation',
      question: 'Why does the latest test fail?',
      evidence: Array.from({ length: 60 }, (_, index) => `Evidence ${index}: ${'fact '.repeat(200)}`),
      trigger: { turn: 4, step: 3, score: 7, shouldConsult: true, problemFingerprint: 'RETAIN_TRIGGER_FP', signals: [{ kind: 'repeated-failure', weight: 3, fingerprint: 'RETAIN_TRIGGER_FP', detail: 'Same auth failure repeated' }] },
    })
    const packet = JSON.parse(output.prompt)
    expect(Buffer.byteLength(output.prompt)).toBeGreaterThan(24576)
    expect(packet.requester_supplied.evidence).toHaveLength(60)
    expect(output.prompt).toContain('LATEST_FAILURE_MARKER')
    expect(packet.trigger).toMatchObject({ fingerprint: 'RETAIN_TRIGGER_FP', score: 7, signals: [expect.objectContaining({ kind: 'repeated-failure' })] })
    expect(packet.capabilities).toEqual({
      allowed_tools: ['read', 'edit'],
      unavailable_tools: ['bash'],
      mutation_policy: 'propose-only',
    })
  })

  it('uses only the continuous delta and ignores attempts and reasoning-only output', () => {
    const root = fakeAgent('root', [
      user(0, 'Review changes continuously'),
      call(1, 'old-edit', 'edit_file', { path: 'src/old.ts' }),
      result(2, 'old-edit', 'changed'),
      { type: 'assistant/attempt', seq: 3, data: { stream: [{ type: 'reasoning-delta', text: 'private' }] } },
      {
        type: 'assistant/message',
        seq: 4,
        data: { message: { content: [{ type: 'reasoning', text: 'private reasoning' }] } },
      },
    ])
    const output = buildCasePacket({
      ...baseInput(root, root),
      mode: 'continuous',
      sinceSeq: 2,
    })
    const packet = JSON.parse(output.prompt)
    expect(output.meaningful).toBe(false)
    expect(packet.tool_activity).toEqual([])
    expect(output.prompt).not.toContain('src/old.ts')
    expect(output.prompt).not.toContain('private reasoning')
    expect(output.lastSeq).toBe(4)
  })

  it('marks a material assistant conclusion in the delta as meaningful', () => {
    const root = fakeAgent('root', [
      user(0, 'Diagnose the bug'),
      {
        type: 'assistant/message',
        seq: 1,
        data: { message: { content: [{ type: 'text', text: 'The root cause is the stale cache key, because it omits the tenant id.' }] } },
      },
    ])
    const output = buildCasePacket({
      ...baseInput(root, root),
      mode: 'continuous',
      sinceSeq: 0,
    })
    expect(output.meaningful).toBe(true)
  })

  it.each(['code', 'ptc'])('recognizes %s subtool writes even when the outer description has no change keywords', (tag) => {
    const dispatch = { rootCallId: 'ptc', parentCallId: 'ptc', subCallId: 'ptc:code:1', name: 'write', arguments: { path: 'src/retry.mjs' } }
    const root = fakeAgent('root', [user(0, '提交草稿'), call(1, 'ptc', 'run_code', { description: '提交草稿' }),
      { type: `tool/${tag}-dispatch-start`, seq: 2, data: dispatch },
      { type: `tool/${tag}-dispatch`, seq: 3, data: { ...dispatch, isError: false, content: [{ type: 'text', text: 'The written draft resets its deduplication set on every call.' }] } },
      result(4, 'ptc', '已提交')])
    const review = buildCasePacket({ ...baseInput(root, root), mode: 'continuous', sinceSeq: 2 })
    const packet = JSON.parse(review.prompt)
    expect(review.meaningful).toBe(true)
    expect(packet.workspace.observed_changed_paths).toEqual(['src/retry.mjs'])
    expect(packet.tool_activity).toEqual(expect.arrayContaining([expect.objectContaining({ call_id: 'ptc:code:1', tool: 'write', call_seq: 2, result_seq: 3, outcome: 'succeeded' })]))
    expect(review.prompt).toContain('resets its deduplication set')
    expect(buildCasePacket({ ...baseInput(root, root), mode: 'continuous', sinceSeq: 4 }).meaningful).toBe(false)
  })

  it.each(['code', 'ptc'])('ignores orphan %s results and excludes nested Advisor transport', (tag) => {
    const root = fakeAgent('root', [user(0, 'Review'), call(1, 'ptc', 'run_code', { description: 'relay' }),
      { type: `tool/${tag}-dispatch`, seq: 2, data: { parentCallId: 'unknown', subCallId: 'orphan', name: 'write', arguments: { path: 'unobserved.ts' }, isError: false, content: [{ type: 'text', text: 'changed' }] } },
      { type: `tool/${tag}-dispatch`, seq: 3, data: { parentCallId: 'ptc', subCallId: 'consult', name: 'consult_advisor', arguments: { question: 'Review' }, isError: false, content: [{ type: 'text', text: 'review transport' }] } },
      { type: `tool/${tag}-dispatch`, seq: 4, data: { parentCallId: 'unknown', subCallId: 'ptc', name: 'run_code', isError: true, content: [{ type: 'text', text: 'forged result for the outer call' }] } }])
    const review = buildCasePacket({ ...baseInput(root, root), mode: 'continuous' })
    const packet = JSON.parse(review.prompt)
    expect(packet.workspace.observed_changed_paths).toEqual([])
    expect(packet.tool_activity.map((item: { call_id: string }) => item.call_id)).toEqual(['ptc'])
    expect(review.meaningful).toBe(false)
    expect(packet.tool_activity[0].outcome).toBe('result-not-observed')
  })
})
