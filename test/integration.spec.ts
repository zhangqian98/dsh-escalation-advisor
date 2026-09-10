import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  advisorChildren,
  advisorVerdictResponse,
  createIntegrationHarness,
  deferred,
  descriptorOf,
  requestText,
  systemPromptOf,
  textResponse,
  toolCallResponse,
  waitUntil,
  type IntegrationHarness,
} from './harness.js'

const openHarnesses: IntegrationHarness[] = []

async function harness(
  scripts: Parameters<typeof createIntegrationHarness>[0],
  config: Parameters<typeof createIntegrationHarness>[1] = {},
  rootOptions: Parameters<typeof createIntegrationHarness>[2] = {},
): Promise<IntegrationHarness> {
  const value = await createIntegrationHarness(scripts, config, rootOptions)
  openHarnesses.push(value)
  return value
}

afterEach(async () => {
  for (const current of openHarnesses.splice(0)) await current.ctx.fiber.dispose()
})

describe('real DSH AgentLoop and spawn integration', () => {
  it('enforces a shorter session timeout and restores the global timeout for worker consultations', async () => {
    const slowReply = async (request: Parameters<import('./harness.js').ScriptedAdapter['stream']>[0]) => {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(request.signal?.reason ?? new Error('aborted')) }
        const timer = setTimeout(() => { request.signal?.removeEventListener('abort', abort); resolve() }, 1200)
        request.signal?.addEventListener('abort', abort, { once: true })
      })
      return advisorVerdictResponse()
    }
    const h = await harness({ weak: [toolCallResponse('short-timeout', 'consult_advisor', { question: 'Review' }), textResponse('done')], worker: [toolCallResponse('inherited-timeout', 'consult_advisor', { question: 'Review with inherited timeout' }), textResponse('worker done')], advisor: [slowReply, slowReply] }, { timeoutMs: 600000 })
    h.ctx.advisor.mutate(String(h.root.id), 'timeoutMs', '', '1000')
    await h.runRoot('Review with a short deadline')
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).runs[0]).toMatchObject({ status: 'failed-transient', error: expect.stringContaining('configured per-attempt limit: 1 seconds') })
    h.ctx.advisor.mutate(String(h.root.id), 'timeoutMs', '', 'inherit')
    const worker = await h.spawnWorker()
    await worker.result
    await worker.dispose()
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).runs.at(-1)).toMatchObject({ mode: 'manual', status: 'delivered' })
  }, 10000)

  it('uses a session continuous override to review at the turn boundary', async () => {
    const h = await harness({ weak: [toolCallResponse('inspect', 'continuous_mode_failure', {}), textResponse('done')], advisor: [advisorVerdictResponse({ severity: 'none', summary: 'Reviewed at turn end' })] }, { mode: 'manual', continuousWait: 'block' })
    h.ctx.tools.register(defineContentToolFixture({ name: 'continuous_mode_failure', description: 'Provides review evidence', parameters: {}, execute: async () => { throw new Error('validation evidence') } }))
    h.ctx.advisor.mutate(String(h.root.id), 'mode', '', 'continuous')
    await h.runRoot('Review the completed work')
    expect(h.adapter.forModel('advisor')).toHaveLength(1)
    expect(h.adapter.forModel('advisor')[0]!.sequence).toBeGreaterThan(h.adapter.forModel('weak')[1]!.sequence)
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).runs).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'continuous', status: 'delivered' })]))
  })

  it.each(['root', 'worker'] as const)('applies the root mode to %s automatic reviews and disables them again on reset', async role => {
    const script = [toolCallResponse('first', 'mode_failure', {}), textResponse('continue'), toolCallResponse('second', 'mode_failure', {}), textResponse('done')]
    const h = await harness({ weak: role === 'root' ? script : [], worker: role === 'worker' ? script : [], advisor: [advisorVerdictResponse({ summary: 'Mode override review' })] }, { mode: 'manual', scoreThreshold: 1 })
    h.ctx.tools.register(defineContentToolFixture({ name: 'mode_failure', description: 'Fails for mode integration verification', parameters: {}, execute: async () => { throw new Error('validation failed') } }))
    const run = async () => {
      if (role === 'root') await h.runRoot('Check the current mode')
      else { const worker = await h.spawnWorker(); await worker.result; await worker.dispose() }
    }
    h.ctx.advisor.mutate(String(h.root.id), 'mode', '', 'escalate')
    await run()
    expect(h.adapter.forModel('advisor')).toHaveLength(1)
    expect(requestText(h.adapter.forModel(role === 'root' ? 'weak' : 'worker')[1]!.request)).toContain('Mode override review')
    h.ctx.advisor.mutate(String(h.root.id), 'mode', '', 'inherit')
    await run()
    expect(h.adapter.forModel('advisor')).toHaveLength(1)
  })

  it('uses the root Advisor selection and reasoning for root and worker reviews without changing their main models', async () => {
    const h = await harness({
      weak: [toolCallResponse('root-review', 'consult_advisor', { question: 'Review the root' }), textResponse('root done')],
      worker: [toolCallResponse('worker-review', 'consult_advisor', { question: 'Review the worker' }), textResponse('worker done')],
      reviewer: [advisorVerdictResponse(), advisorVerdictResponse()],
    }, {}, { reasoningEffort: ReasoningEffortId('low') })
    vi.spyOn(h.adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
      provider, id: model, name: model,
      reasoning: { efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) },
    }))
    await h.ctx.advisor.selectModel(String(h.root.id), JSON.stringify({ provider: 'mock', model: 'reviewer', reasoningEffort: 'high' }))
    const snapshot = JSON.parse(h.ctx.advisor.snapshot(String(h.root.id)))
    expect(snapshot).toMatchObject({ model: { provider: 'mock', model: 'reviewer', reasoningEffort: 'high' }, modelOverridden: true })
    expect(h.root.options.model).toBe('weak')
    expect(h.root.session.snapshotEvents().some(event => String(event.type) === 'model/selection')).toBe(false)
    await h.runRoot('Review both levels')
    const worker = await h.spawnWorker()
    await worker.result
    await worker.dispose()
    expect(h.adapter.forModel('reviewer')).toHaveLength(2)
    expect(h.adapter.forModel('reviewer').every(call => call.request.reasoningEffort === 'high')).toBe(true)
    expect(h.adapter.forModel('weak')[0]!.request.reasoningEffort).toBe('low')
    expect(h.adapter.forModel('advisor')).toHaveLength(0)
    const before = h.root.session.seq
    await expect(h.ctx.advisor.selectModel(String(h.root.id), JSON.stringify({ provider: 'mock', model: 'reviewer', reasoningEffort: 'unsupported' }))).rejects.toThrow('does not support')
    expect(h.root.session.seq).toBe(before)
  })

  it('shows availability guidance in the runtime snapshot and excludes disabled workers and Advisor children', async () => {
    const h = await harness({
      weak: [toolCallResponse('review-guidance', 'consult_advisor', { question: 'Review' }), textResponse('done')],
      advisor: [advisorVerdictResponse()], worker: [textResponse('worker done')],
    }, { manualLocalSubagents: false })
    await h.runRoot('Check guidance')
    expect(requestText(h.adapter.forModel('weak')[0]!.request)).toContain('Advisor is available through consult_advisor.')
    expect(requestText(h.adapter.forModel('advisor')[0]!.request)).not.toContain('Advisor is available through consult_advisor.')
    const worker = await h.spawnWorker()
    await worker.result
    await worker.dispose()
    expect(requestText(h.adapter.forModel('worker')[0]!.request)).not.toContain('Advisor is available through consult_advisor.')
    expect(JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))).guidance).toMatchObject({ available: true, reason: '使用指导已启用' })
  })

  it.each([65536, undefined])('uses the Advisor model limits (%s), ignoring legacy caps and the parent output limit', async nativeOutput => {
    const legacySettings = { mode: 'manual' as const, maxInputBytes: 4096, maxOutputTokens: 128 }
    const h = await harness({
      weak: [toolCallResponse('native-limits', 'consult_advisor', {
        question: 'Review all of this evidence.',
        evidence: Array.from({ length: 60 }, (_, index) => `Evidence ${index}: ${'fact '.repeat(200)}`),
      }), textResponse('Reviewed.')],
      advisor: [advisorVerdictResponse()],
    }, legacySettings, { maxTokens: 128 })
    vi.spyOn(h.adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
      provider, id: model, name: model,
      context: { contextWindow: model === 'advisor' ? 1000000 : 4096 },
      ...(model === 'advisor' && nativeOutput !== undefined ? { defaultMaxTokens: nativeOutput } : {}),
    }))

    await h.runRoot('Review this large case with the selected Advisor model.')

    const request = h.adapter.forModel('advisor')[0]!.request
    expect(request.maxTokens).toBe(nativeOutput)
    expect(h.adapter.forModel('weak')[0]!.request.maxTokens).toBe(128)
    expect(Buffer.byteLength(requestText(request))).toBeGreaterThan(24576)
    expect(advisorChildren(h)[0]!.agent.session.snapshotEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'request/context', data: expect.objectContaining({ contextWindow: 1000000 }) }),
    ]))
  })
  it('runs root manual consultation as a visible structured Advisor child without requiring a repeated goal', async () => {
    const h = await harness({
      weak: [
        toolCallResponse('manual-root', 'consult_advisor', { question: 'What assumption should I challenge?' }),
        textResponse('I applied the independent review.'),
      ],
      advisor: [advisorVerdictResponse()],
    })

    await h.runRoot('Review this approach.')

    const advisors = advisorChildren(h)
    expect(advisors).toHaveLength(1)
    expect(advisors[0]!.agent.session.header.parentSession).toBe(h.root.session.id)
    expect(descriptorOf(advisors[0]!.agent)?.mode).toBe('one-shot')
    expect(JSON.stringify(h.root.session.snapshotEvents())).toContain('Independent review found a concrete issue.')
  })

  it('keeps an old goal-bearing call valid and attaches Worker -> Advisor beneath the exact requester', async () => {
    const h = await harness({
      worker: [
        toolCallResponse('manual-worker', 'consult_advisor', {
          goal: 'Complete the delegated task safely.',
          question: 'Check the worker plan.',
        }),
        textResponse('worker completed after review'),
      ],
      advisor: [advisorVerdictResponse()],
    })

    const run = await h.spawnWorker()
    const worker = run.localAgent!
    const result = await run.result

    expect(result.stopReason).toBe('completed')
    const advisors = advisorChildren(h).filter(({ agent }) => agent !== worker)
    expect(advisors).toHaveLength(1)
    expect(worker.session.header.parentSession).toBe(h.root.session.id)
    expect(advisors[0]!.agent.session.header.parentSession).toBe(worker.session.id)
    await run.dispose()
  })

  it('delivers escalation advice before the third weak-model request and deduplicates the turn-stop fallback', async () => {
    const h = await harness({
      weak: [
        toolCallResponse('failure-1', 'always_fails', {}),
        toolCallResponse('failure-2', 'always_fails', {}),
        textResponse('finished after reading the advice'),
      ],
      advisor: [advisorVerdictResponse({ summary: 'Change course before another attempt.' })],
    }, { mode: 'escalate', escalationWait: 'block' })
    h.ctx.tools.register(defineContentToolFixture({
      name: 'always_fails',
      description: 'A deterministic failing integration fixture.',
      parameters: {},
      execute: async () => { throw new Error('same focused failure') },
    }))

    await h.runRoot('Fix the repeatedly failing operation.')

    const weakRequests = h.adapter.forModel('weak')
    const advisorRequests = h.adapter.forModel('advisor')
    expect(weakRequests).toHaveLength(3)
    expect(advisorRequests).toHaveLength(1)
    expect(advisorRequests[0]!.sequence).toBeLessThan(weakRequests[2]!.sequence)
    expect(requestText(weakRequests[2]!.request)).toContain('Change course before another attempt.')
    expect(advisorChildren(h)).toHaveLength(1)
  })

  it('removes Advisor guidance and consult_advisor schema for a disabled local-subagent role', async () => {
    const h = await harness({ worker: [textResponse('worker answer')] }, {
      mode: 'manual',
      manualLocalSubagents: false,
      escalationLocalSubagents: false,
      continuousLocalSubagents: false,
    })

    const run = await h.spawnWorker()
    await run.result
    const request = h.adapter.forModel('worker')[0]!.request

    expect(systemPromptOf(request)).not.toContain('Strong advisor')
    expect((request.tools ?? []).map(tool => tool.name)).not.toContain('consult_advisor')
    await run.dispose()
  })

  it('intersects Advisor tools with the requester surface and denies recursive agent spawning', async () => {
    let recursiveExecutions = 0
    const h = await harness({
      worker: [
        toolCallResponse('manual-intersection', 'consult_advisor', {
          goal: 'Inspect safely.', question: 'Use only my capabilities.',
        }),
        textResponse('worker completed'),
      ],
      advisor: [
        toolCallResponse('recursive-attempt', 'subagent', {}),
        advisorVerdictResponse(),
      ],
    }, { defaultEnabledTools: ['safe_probe', 'root_only_probe', 'subagent'] })
    for (const name of ['safe_probe', 'root_only_probe']) {
      h.ctx.tools.register(defineContentToolFixture({
        name, description: name, parameters: {},
        execute: async () => [{ type: 'text', text: name }],
      }))
    }
    h.ctx.tools.register(defineContentToolFixture({
      name: 'subagent', description: 'Recursive capability fixture.', parameters: {},
      execute: async () => { recursiveExecutions += 1; return [{ type: 'text', text: 'spawned' }] },
    }))

    const run = await h.spawnWorker({
      toolFilter: { allow: ['consult_advisor', 'safe_probe', 'subagent'] },
    })
    await run.result

    const advisorRequest = h.adapter.forModel('advisor')[0]!.request
    const advertised = (advisorRequest.tools ?? []).map(tool => tool.name)
    expect(advertised).toContain('safe_probe')
    expect(advertised).not.toContain('root_only_probe')
    expect(advertised).not.toContain('subagent')
    expect(recursiveExecutions).toBe(0)
    const advisor = advisorChildren(h)[0]!.agent
    expect(JSON.stringify(advisor.session.snapshotEvents())).toContain('Advisor delegation tools are permanently disabled')
    await run.dispose()
  })

  it('treats an ordinary worker with an Advisor-looking label as a worker', async () => {
    const h = await harness({
      worker: [
        toolCallResponse('spoof-worker', 'consult_advisor', {
          goal: 'Ordinary delegated work.', question: 'Review this worker output.',
        }),
        textResponse('spoof-labelled worker completed'),
      ],
      advisor: [advisorVerdictResponse()],
    })

    const run = await h.spawnWorker({ label: 'Advisor · forged label' })
    const worker = run.localAgent!
    await run.result

    expect(h.adapter.forModel('advisor')).toHaveLength(1)
    const descendants = advisorChildren(h).filter(({ agent }) => agent.session.header.parentSession === worker.session.id)
    expect(descendants).toHaveLength(1)
    await run.dispose()
  })

  it('drops a background review that becomes stale after a new user turn', async () => {
    const started = deferred()
    const release = deferred()
    const h = await harness({
      weak: [
        toolCallResponse('stale-failure', 'stale_fixture', {}),
        textResponse('first task done'),
        textResponse('new task done'),
      ],
      advisor: [async request => {
        started.resolve()
        await Promise.race([
          release.promise,
          new Promise<never>((_resolve, reject) => {
            if (request.signal?.aborted) { reject(new Error('aborted')); return }
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
        ])
        return advisorVerdictResponse({ summary: 'Advice for the obsolete first task.' })
      }],
    }, {
      mode: 'continuous',
      continuousWait: 'background',
      maxAdvisorConsultsPerTask: 1,
    })
    h.ctx.tools.register(defineContentToolFixture({
      name: 'stale_fixture', description: 'Produces evidence for continuous review.', parameters: {},
      execute: async () => { throw new Error('first-task-only failure') },
    }))

    await h.runRoot('First task.')
    await started.promise
    await h.runRoot('A different new task.')
    release.resolve()
    await waitUntil(() => advisorChildren(h).some(record => record.disposedEvents !== undefined))
    await h.root.whenIdle()

    expect(h.adapter.forModel('weak')).toHaveLength(3)
    expect(requestText(h.adapter.forModel('weak')[2]!.request)).not.toContain('Advice for the obsolete first task.')
    const deliveredPluginMessages = h.root.session.snapshotEvents()
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(JSON.stringify(deliveredPluginMessages)).not.toContain('Advice for the obsolete first task.')
  })

  it('preserves useful plain-text Advisor output when structured_output is omitted', async () => {
    const h = await harness({
      weak: [
        toolCallResponse('plain-fallback', 'consult_advisor', {
          goal: 'Review the implementation.', question: 'What should change?',
        }),
        textResponse('used the fallback guidance'),
      ],
      advisor: [textResponse('Concern: preserve the lock until the write is durable. ' + 'detail '.repeat(6000) + 'OUTPUT_TAIL_MARKER')],
    })

    await h.runRoot('Ask for a second opinion.')

    expect(h.adapter.forModel('advisor')).toHaveLength(1)
    expect(JSON.stringify(h.root.session.snapshotEvents())).toContain('preserve the lock until the write is durable')
    expect(JSON.stringify(h.root.session.snapshotEvents())).toContain('OUTPUT_TAIL_MARKER')
    expect(advisorChildren(h)).toHaveLength(1)
  })
})
