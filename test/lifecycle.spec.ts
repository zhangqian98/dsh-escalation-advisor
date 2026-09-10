import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { advisorRunHistory } from '../src/telemetry.js'
import { advisorScript, advisorVerdictResponse, createIntegrationHarness, deferred, textResponse, toolCallResponse, waitUntil, type IntegrationHarness } from './harness.js'

const opened: IntegrationHarness[] = []
afterEach(async () => { for (const h of opened.splice(0)) await h.ctx.fiber.dispose() })
async function harness(...args: Parameters<typeof createIntegrationHarness>) { const h = await createIntegrationHarness(...args); opened.push(h); return h }
function failingTool(h: IntegrationHarness) {
  h.ctx.tools.register(defineContentToolFixture({ name: 'fails', description: 'Fixture failure', parameters: {}, async execute() { throw new Error('same test failure') } }))
}

describe('Advisor lifecycle accounting and delivery', () => {
  it('delivers actual Advisor changes even when the verdict has no remaining concern', async () => {
    const h = await harness({ weak: [toolCallResponse('changed', 'write', {}), textResponse('Implemented the task.'), textResponse('Verified the Advisor changes.')], advisor: advisorScript(advisorVerdictResponse({ severity: 'none', changes_made: [{ paths: ['auth.ts'], reason: 'Corrected the guard', validation: ['auth test passed'] }] })) }, { mode: 'continuous', defaultEnabledTools: ['write'] })
    h.ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Fixture mutation', parameters: {}, async execute() { return [{ type: 'text', text: 'changed' }] } }))
    await h.runRoot('Implement and review')
    expect(h.adapter.forModel('weak')).toHaveLength(3)
    expect(JSON.stringify(h.adapter.forModel('weak')[2]!.request.messages)).toContain('Corrected the guard')
  })
  it('reports an ancestor lease conflict without deadlocking or spending model budget', async () => {
    const h = await harness({ weak: [toolCallResponse('outer', 'dispatch_child', {}), textResponse('done')], worker: [toolCallResponse('ask', 'consult_advisor', { question: 'Review with editing permission' }), textResponse('worker completed')] }, { defaultEnabledTools: ['write'] })
    h.ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Fixture mutation', parameters: {}, async execute() { return [] } }))
    h.ctx.tools.register(defineContentToolFixture({ name: 'dispatch_child', description: 'Unknown wrapper', parameters: {}, async execute() {
      const child = await h.spawnWorker()
      const result = await child.result
      await child.dispose()
      return result.output
    } }))
    await h.runRoot('Run the wrapper')
    expect(h.adapter.forModel('advisor')).toHaveLength(0)
    expect(advisorRunHistory(h.root).at(-1)?.error).toContain('ancestor')
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).budget.used).toBe(0)
  }, 1500)
  it('prevents model dispatch in descendants created by an unrecognized delegation wrapper', async () => {
    let shellCalls = 0
    const h = await harness({ weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review' }), textResponse('done')], advisor: [toolCallResponse('relay', 'relay', {}), ...advisorScript(advisorVerdictResponse())], escape: [toolCallResponse('escape-bash', 'bash', {}), textResponse('denied')] }, { defaultEnabledTools: ['relay'] })
    h.ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'A forbidden shell', parameters: {}, async execute() { shellCalls++; return [] } }))
    h.ctx.tools.register(defineContentToolFixture({ name: 'relay', description: 'Custom wrapper', parameters: {}, async execute(_args, exec) {
      const child = await h.ctx.subagents.start('spawn', { parent: exec.agent!, signal: exec.signal, prompt: [{ type: 'text', text: 'Try the shell' }], agentOptions: { model: 'escape' } })
      const result = await child.result
      await child.dispose()
      return result.output
    } }))
    await h.runRoot('Inspect within the permitted boundary')
    expect(shellCalls).toBe(0)
    expect(h.adapter.forModel('escape')).toHaveLength(0)
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).budget.used).toBe(1)
  })
  it('denies delegation tool aliases from trusted plugin configuration', async () => {
    let dispatches = 0
    const h = await harness({ weak: [toolCallResponse('ask', 'consult_advisor', { question: 'Review' }), textResponse('done')], advisor: [toolCallResponse('alias', 'delegate', {}), ...advisorScript(advisorVerdictResponse())] }, { defaultEnabledTools: ['delegate', 'orchestrate'] })
    for (const [pluginName, toolName] of [['tool-subagent', 'delegate'], ['tool-workflow', 'orchestrate']]) {
      await h.ctx.plugin({ name: pluginName, inject: ['tools'], apply(ctx: Context, config: { toolName: string }) { ctx.tools.register(defineContentToolFixture({ name: config.toolName, description: 'Delegating fixture', parameters: {}, async execute() { dispatches++; return [] } })) } }, { toolName: toolName! })
    }
    await h.runRoot('Review within the budget')
    expect(dispatches).toBe(0)
    expect(h.adapter.forModel('advisor')[0]!.request.tools?.some(tool => ['delegate', 'orchestrate'].includes(tool.name))).toBe(false)
    const catalog = JSON.parse(h.ctx.advisor.snapshot(String(h.root.id)))
    expect(catalog.tools.filter((tool: { reserved: boolean }) => tool.reserved)).toHaveLength(2)
  })
  it('refunds pre-dispatch authentication failures for both manual and task budgets', async () => {
    const h = await harness({ weak: [toolCallResponse('first', 'consult_advisor', { question: 'Review once' }), toolCallResponse('second', 'consult_advisor', { question: 'Retry after auth repair' }), textResponse('done')], advisor: advisorScript(advisorVerdictResponse()) }, { maxManualConsultsPerSession: 1, maxAdvisorConsultsPerTask: 1 })
    const prepare = h.adapter.prepareCall.bind(h.adapter)
    let rejectOnce = true
    vi.spyOn(h.adapter, 'prepareCall').mockImplementation(async (provider, model, signal) => {
      if (model === 'advisor' && rejectOnce) { rejectOnce = false; throw new Error('Authentication configuration missing') }
      return prepare(provider, model, signal)
    })
    await h.runRoot('Review the current task')
    const history = advisorRunHistory(h.root)
    expect(history.map(run => run.status)).toEqual(['failed-transient', 'delivered'])
    expect(h.adapter.forModel('advisor')).toHaveLength(2)
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).budget.used).toBe(1)
  })

  it('retries a transient automatic failure once and only deduplicates after delivery', async () => {
    let retryableFailures = 0
    const h = await harness({ weak: [toolCallResponse('f1', 'fails', {}), toolCallResponse('f2', 'fails', {}), textResponse('done')], advisor: [() => { retryableFailures += 1; throw new Error('provider timeout') }, ...advisorScript(advisorVerdictResponse())] }, { mode: 'escalate', retryDelayMs: 0 })
    failingTool(h)
    await h.runRoot('Fix the failures')
    expect(retryableFailures).toBe(1)
    // One failed attempt, then the retry child's verdict call and closing response.
    expect(h.adapter.forModel('advisor')).toHaveLength(3)
    expect(advisorRunHistory(h.root).map(run => run.status)).toEqual(['failed-transient', 'delivered'])
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).budget.used).toBe(2)
    expect(h.adapter.forModel('weak')).toHaveLength(3)
  })
  it('keeps automatic retry eligibility after refunded auth startup failures', async () => {
    let authenticated = false, preparations = 0
    const h = await harness({ weak: [toolCallResponse('f1', 'fails', {}), toolCallResponse('f2', 'fails', {}), () => { authenticated = true; return textResponse('The credentials have been repaired.') }, textResponse('Applied the Advisor result.')], advisor: advisorScript(advisorVerdictResponse()) }, { mode: 'escalate', retryDelayMs: 0, maxAdvisorConsultsPerTask: 1 })
    failingTool(h)
    const prepare = h.adapter.prepareCall.bind(h.adapter)
    vi.spyOn(h.adapter, 'prepareCall').mockImplementation(async (provider, model, signal) => {
      if (model === 'advisor') { preparations++; if (!authenticated) throw new Error('Authentication credentials temporarily unavailable') }
      return prepare(provider, model, signal)
    })
    await h.runRoot('Fix this problem')
    expect(preparations).toBeGreaterThanOrEqual(2)
    expect(h.adapter.forModel('advisor')).toHaveLength(2)
    expect(advisorRunHistory(h.root).at(-1)?.status).toBe('delivered')
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).budget.used).toBe(1)
  })

  it('retains a nit for future root context without waking the finished turn', async () => {
    const h = await harness({ weak: [toolCallResponse('f1', 'fails', {}), textResponse('The validation failed because the fixture is unavailable.'), textResponse('Continuing the current task.')], advisor: advisorScript(advisorVerdictResponse({ severity: 'nit' }), advisorVerdictResponse({ severity: 'none' })) }, { mode: 'continuous', continuousWait: 'block' })
    failingTool(h)
    await h.runRoot('Review this task')
    expect(h.adapter.forModel('weak')).toHaveLength(2)
    expect(advisorRunHistory(h.root).at(-1)).toMatchObject({ status: 'delivered', severity: 'nit' })
    await h.runRoot('Continue the task with the next check')
    expect(JSON.stringify(h.adapter.forModel('weak')[2]!.request.messages)).toContain('Historical optional Advisor note')
  })
  it('defers a pre-step escalation nit until a later natural step', async () => {
    const h = await harness({ weak: [toolCallResponse('f1', 'fails', {}), toolCallResponse('f2', 'fails', {}), textResponse('Finished this attempt.'), textResponse('Continued normally.')], advisor: advisorScript(advisorVerdictResponse({ severity: 'nit', summary: 'Optional follow-up improvement' })) }, { mode: 'escalate' })
    failingTool(h)
    await h.runRoot('Inspect the failure')
    expect(JSON.stringify(h.adapter.forModel('weak')[2]!.request.messages)).not.toContain('Optional follow-up improvement')
    await h.runRoot('Continue with the next check')
    expect(JSON.stringify(h.adapter.forModel('weak')[3]!.request.messages)).toContain('Historical optional Advisor note')
  })

  it('forces editing reviews to block and excludes concurrent worker writes', async () => {
    const gate = deferred(), advisorStarted = deferred(), writes: string[] = []
    const h = await harness({
      weak: [toolCallResponse('root-edit', 'write', { path: 'root.txt' }), textResponse('Implemented the root change.')],
      worker: [toolCallResponse('worker-edit', 'write', { path: 'worker.txt' }), textResponse('worker done')],
      advisor: advisorScript(async () => { advisorStarted.resolve(); await gate.promise; return advisorVerdictResponse({ severity: 'none' }) }),
    }, { mode: 'continuous', continuousWait: 'background', defaultEnabledTools: ['write'] })
    h.ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Fixture write', parameters: { path: { type: 'string' } }, async execute(args) { writes.push(String(args.path)); return [{ type: 'text', text: 'written' }] } }))
    let rootFinished = false
    const rootRun = h.runRoot('Edit and review').then(() => { rootFinished = true })
    await advisorStarted.promise
    const worker = await h.spawnWorker()
    await waitUntil(() => h.adapter.forModel('worker').length > 0)
    expect(rootFinished).toBe(false)
    expect(writes).toEqual(['root.txt'])
    gate.resolve()
    await Promise.all([rootRun, worker.result])
    expect(writes).toEqual(['root.txt', 'worker.txt'])
    await worker.dispose()
  })
})
