import { afterEach, describe, expect, it } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createIntegrationHarness, textResponse, toolCallResponse, advisorVerdictResponse, type IntegrationHarness } from './harness.js'

describe('Advisor Remote policy API', () => {
  let harness: IntegrationHarness | undefined
  afterEach(async () => { await harness?.ctx.fiber.dispose() })
  it('reads through the real strict gateway without writing command/session events; mutations append versioned policy', async () => {
    harness = await createIntegrationHarness({})
    const { ctx, root } = harness
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'Read a file', parameters: {}, async execute() { return [] } }))
    const before = root.session.seq
    for (let read = 0; read < 3; read++) {
      const raw = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'snapshot', args: { sessionId: String(root.id) } })
      expect(JSON.parse(String(raw)).tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read' })]))
    }
    expect(root.session.seq).toBe(before)
    await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'mutate', args: { sessionId: String(root.id), action: 'tool', tool: 'read', value: 'allow' } })
    const appended = root.session.snapshotEvents().slice(before)
    expect(appended.map(event => event.type)).toEqual(['advisor/policy'])
    expect(appended[0]?.data).toMatchObject({ version: 2, allowTools: ['read'] })
    await expect(ctx.typertGateway.invoke({ namespace: 'advisor', method: 'snapshot', args: { sessionId: 5 } })).rejects.toThrow()
  })
  it('rejects child reads and policy mutation on the host', async () => {
    harness = await createIntegrationHarness({ worker: [textResponse('done')] })
    const run = await harness.spawnWorker()
    await run.result
    expect(() => harness!.ctx.advisor.snapshot(String(run.id))).toThrow('root session')
    expect(() => harness!.ctx.advisor.mutate(String(run.id), 'reset', '', '')).toThrow('root session')
    await run.dispose()
  })

  it('validates and persists model selection through the strict gateway', async () => {
    harness = await createIntegrationHarness({})
    const { ctx, root } = harness
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    const value = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'selectModel', args: {
      sessionId: String(root.id), selection: JSON.stringify({ provider: 'mock', model: 'selected-advisor' }),
    } })
    expect(JSON.parse(String(value))).toMatchObject({ model: { provider: 'mock', model: 'selected-advisor' }, modelOverridden: true })
    expect(root.options.model).toBe('weak')
  })

  it('sets and resets the session mode through the strict gateway without changing global defaults', async () => {
    harness = await createIntegrationHarness({})
    const { ctx, root } = harness
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    for (const mode of ['escalate', 'continuous', 'manual', 'inherit']) {
      const before = root.session.seq
      const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'mutate', args: { sessionId: String(root.id), action: 'mode', tool: '', value: mode } })
      expect(JSON.parse(String(result))).toMatchObject({ mode: mode === 'inherit' ? 'manual' : mode, modeDefault: 'manual', modeOverride: mode })
      expect(root.session.snapshotEvents().slice(before).map(e => e.type)).toEqual(['advisor/policy'])
    }
    const before = root.session.seq
    expect(() => ctx.advisor.mutate(String(root.id), 'mode', '', 'invalid')).toThrow('Expected inherit')
    expect(root.session.seq).toBe(before)
  })

  it('validates timeout overrides, preserves them across mode changes, and restores inheritance', async () => {
    harness = await createIntegrationHarness({}, { timeoutMs: 600000 })
    const { ctx, root } = harness
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'mutate', args: { sessionId: String(root.id), action: 'timeoutMs', tool: '', value: '180000' } })
    expect(JSON.parse(String(result))).toMatchObject({ timeoutMs: 180000, timeoutDefaultMs: 600000, timeoutOverride: 180000 })
    expect(JSON.parse(ctx.advisor.mutate(String(root.id), 'mode', '', 'continuous')).timeoutMs).toBe(180000)
    const before = root.session.seq
    for (const invalid of ['0', '999', '3600001', 'NaN', '', '-1000', '1.5']) expect(() => ctx.advisor.mutate(String(root.id), 'timeoutMs', '', invalid)).toThrow('Timeout must')
    expect(root.session.seq).toBe(before)
    expect(JSON.parse(ctx.advisor.mutate(String(root.id), 'timeoutMs', '', 'inherit'))).toMatchObject({ timeoutMs: 600000, timeoutOverride: 'inherit' })
    ctx.advisor.mutate(String(root.id), 'timeoutMs', '', '300000')
    expect(JSON.parse(ctx.advisor.mutate(String(root.id), 'reset', '', ''))).toMatchObject({ timeoutMs: 600000, timeoutOverride: 'inherit' })
  })

  it('reads exact legacy injections without writing events or accepting another task ID', async () => {
    harness = await createIntegrationHarness({})
    const { ctx, root } = harness
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    root.session.append('advisor/run', { version: 1, id: 'legacy-review', requesterId: String(root.id), mode: 'escalation', turn: 42, taskRevision: 'task', attempt: 1, status: 'delivered', timestamp: new Date().toISOString(), childSessionId: 'advisor-child', summary: 'Check the gate' })
    const text = '[Strong advisor — escalation; severity=concern; child=advisor-child]\nCheck the gate\n\nFull diagnosis and validation, including <script>literal text</script>.'
    root.session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-escalation-advisor' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    const before = root.session.seq
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'review', args: { sessionId: String(root.id), runId: 'legacy-review' } })
    expect(JSON.parse(String(result))).toMatchObject({ source: 'context', text })
    expect(root.session.seq).toBe(before)
    expect(() => ctx.advisor.review(String(root.id), 'another-task-review')).toThrow('does not belong')
  })

  it('keeps a complete manual reply available without inflating the snapshot', async () => {
    harness = await createIntegrationHarness({ weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Does this assumption hold?' }), textResponse('done')], advisor: [advisorVerdictResponse()] })
    await harness.runRoot('Review this design')
    const { ctx, root } = harness
    const snapshot = JSON.parse(ctx.advisor.snapshot(String(root.id)))
    const run = snapshot.runs[0]
    expect(run.mode).toBe('manual')
    expect(run.responseText).toBeUndefined()
    const before = root.session.seq
    const report = JSON.parse(ctx.advisor.review(String(root.id), run.id))
    expect(report.source).toBe('tool-result')
    expect(report.question).toBe('Does this assumption hold?')
    expect(JSON.parse(report.text)).toMatchObject({ status: 'ok', child_session_id: run.childSessionId })
    expect(root.session.seq).toBe(before)
  })
})
