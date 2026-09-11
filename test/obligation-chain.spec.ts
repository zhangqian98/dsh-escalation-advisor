import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_AUTO_REMINDERS_PER_TASK, type Obligation } from '../src/obligations.js'
import { classifyToolOutcome } from '../src/state.js'
import {
  createIntegrationHarness,
  requestText,
  textResponse,
  toolCallResponse,
  type IntegrationHarness,
} from './harness.js'

/**
 * Verification obligations are wired from `src/index.ts` listeners rather than
 * exposed as a service, so these tests drive the real chain: a scripted model
 * issues a real tool call, the tool runtime produces a real result, and the
 * plugin's `tools/execute` / `tools/result` / `agent/pre-step` /
 * `agent/turn-stopping` listeners do the recording, injection and reminding.
 */

const FAILURE_OUTPUT = 'npm test: 2 of 12 tests failed in test/auth.spec.ts'
const PASS_OUTPUT = 'npm test: 12 of 12 tests passed'

const openHarnesses: IntegrationHarness[] = []

async function harness(
  scripts: Parameters<typeof createIntegrationHarness>[0],
  config: Parameters<typeof createIntegrationHarness>[1] = {},
): Promise<IntegrationHarness> {
  const value = await createIntegrationHarness(scripts, config)
  openHarnesses.push(value)
  return value
}

afterEach(async () => {
  for (const current of openHarnesses.splice(0)) await current.ctx.fiber.dispose()
})

interface CommandOutcome {
  readonly exitCode: number
  readonly output: string
}

/**
 * The plugin derives a validation identity only from a tool whose NAME matches
 * `bash|pwsh|shell|exec|terminal|command`, and `mutationKey` must not fire for it,
 * so `bash` is the smallest faithful stand-in for a real shell tool.
 *
 * Every command consumes its scripted outcomes in order, which lets one and the
 * same command fail first and pass later inside a single task.
 */
function registerShellFixture(h: IntegrationHarness, outcomes: Map<string, CommandOutcome[]>): string[] {
  const executed: string[] = []
  h.ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Runs one scripted shell command and reports its exit code and captured output.',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        exitCode: { type: 'integer', required: true },
        output: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    execute: async (args) => {
      executed.push(args.command)
      const outcome = outcomes.get(args.command)?.shift()
      if (!outcome) throw new Error('No scripted outcome left for command: ' + args.command)
      return { exitCode: outcome.exitCode, output: outcome.output }
    },
  }))
  return executed
}

interface ObligationView {
  readonly id: string
  readonly kind: string
  readonly state: string
  readonly summary: string
  readonly repeatCount: number
  readonly resolution?: string
}

interface ObligationSnapshot {
  readonly taskStartSeq: number
  readonly remindersUsed: number
  readonly remindersLimit: number
  readonly exhausted: boolean
  readonly openCount: number
  readonly items: readonly ObligationView[]
}

/** The plugin's own read-only view of the CURRENT root task. */
function obligationSnapshot(h: IntegrationHarness): ObligationSnapshot {
  const parsed = JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))) as { obligations: ObligationSnapshot }
  return parsed.obligations
}

/**
 * The plugin exposes obligations only for the task that is current at call time:
 * once a new user turn moves `taskStarts` forward, the earlier task's record is
 * invisible to `ctx.advisor.snapshot` and to `advisor_obligation` alike. Reaching
 * the store instance the plugin itself wrote to is the only way to assert the
 * earlier task's state; a shape change fails loudly instead of passing silently.
 */
interface ReachedObligations {
  open(sessionId: string, taskStartSeq: number): Obligation[]
}

function reachedObligations(h: IntegrationHarness): ReachedObligations {
  const service = h.ctx.advisor as unknown as { config?: { obligations?: { store?: ReachedObligations } } }
  const obligations = service.config?.obligations?.store
  if (!obligations) throw new Error('AdvisorRemoteService no longer exposes its obligation store')
  return obligations
}

/** Every obligation notice the plugin delivered to this agent, in order. */
function obligationNotices(agent: Agent): string[] {
  const notices: string[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'plugin' || event.data.source.plugin !== 'dsh-escalation-advisor') continue
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (text.includes('[Advisor obligations')) notices.push(text)
  }
  return notices
}

/** The model-visible text of one completed tool call. */
function toolResultText(agent: Agent, callId: string): string {
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    if (String(block.toolCallId) !== callId) continue
    return block.content.flatMap(inner => inner.type === 'text' ? [inner.text] : []).join('\n')
  }
  return ''
}

/**
 * Supplemental: the plugin's own classifier applied to the same tool name, the same
 * arguments and the same exit code the fixture produces below (only the scope, which
 * belongs to the live task, is stand-in). It records what the chain classified, so a
 * chain assertion cannot pass merely because nothing was ever recognisable.
 */
function classified(command: string, exitCode: number): { class: string; exitCode?: number; validationKey?: string } {
  return classifyToolOutcome({
    callId: 'classification-probe', name: 'bash', arguments: { command }, isError: false,
    scope: 'task:probe:1', value: { exitCode, output: 'probe' }, contentText: 'probe',
  })
}

function failureThenPass(): Map<string, CommandOutcome[]> {
  return new Map([['npm test', [{ exitCode: 1, output: FAILURE_OUTPUT }, { exitCode: 0, output: PASS_OUTPUT }]]])
}

describe('verification obligations through the real plugin chain', () => {
  it('opens an obligation for a definite validation failure and names it in the next pre-step', async () => {
    const h = await harness({ weak: [
      toolCallResponse('obligation-fail', 'bash', { command: 'npm test' }),
      toolCallResponse('obligation-list', 'advisor_obligation', { action: 'list' }),
      textResponse('Finished for now.'),
      textResponse('Nothing else to do.'),
    ] })
    const executed = registerShellFixture(h, new Map([['npm test', [{ exitCode: 1, output: FAILURE_OUTPUT }]]]))

    await h.runRoot('Make the suite pass.')

    expect(executed).toEqual(['npm test'])
    const requests = h.adapter.forModel('weak')
    // The failure is dispatched in step 1; the notice therefore arrives with the
    // next pre-step, which is the request carrying the inspection call.
    const noticeText = requestText(requests[1]!.request)
    expect(noticeText).toContain('[Advisor obligations')
    expect(noticeText).toContain(FAILURE_OUTPUT)
    // The item carries a validation identity, so the failing command was recognised
    // as a validation family rather than merely having failed.
    expect(noticeText).toContain('a later pass of the same command in this scope with no related change since')
    expect(classified('npm test', 1)).toMatchObject({ class: 'validation-failure', exitCode: 1 })
    const match = /- (R[0-9a-f]{6}) \[validation-failure, seen 1x\]/.exec(noticeText)
    expect(match).not.toBeNull()
    const id = match![1]!

    // The id the model was told about is the store's own obligation for this task.
    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(1)
    expect(snapshot.items.map(item => item.id)).toEqual([id])
    expect(snapshot.items[0]).toMatchObject({ kind: 'validation-failure', state: 'open', repeatCount: 1, summary: FAILURE_OUTPUT })
    // And the plugin's inspection tool reports the same record to the model.
    expect(toolResultText(h.root, 'obligation-list')).toContain(id + ' [validation-failure/open')

    const notices = obligationNotices(h.root)
    expect(notices).toHaveLength(2)
    expect(notices.every(text => text.includes(id))).toBe(true)
  })

  it('keeps the obligation open when only an explanation follows the failure', async () => {
    const h = await harness({ weak: [
      toolCallResponse('explained-fail', 'bash', { command: 'npm test' }),
      textResponse('The failing assertion is explained by a stale fixture; no re-run happened.'),
      toolCallResponse('explained-list', 'advisor_obligation', { action: 'list' }),
      textResponse('Reported.'),
    ] })
    const executed = registerShellFixture(h, new Map([['npm test', [{ exitCode: 1, output: FAILURE_OUTPUT }]]]))

    await h.runRoot('Explain the failing suite.')

    // No second validation ran, so the only possible closer is missing.
    expect(executed).toEqual(['npm test'])
    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(1)
    const item = snapshot.items[0]!
    expect(item.state).toBe('open')
    expect(item.resolution).toBeUndefined()
    // The inspection call happens after the explanation and still lists it as open.
    const listed = toolResultText(h.root, 'explained-list')
    expect(listed).toContain(item.id + ' [validation-failure/open')
    expect(listed).not.toContain('resolved')
  })

  it('closes the obligation when the same validation later passes in the same task', async () => {
    const h = await harness({ weak: [
      toolCallResponse('witness-fail', 'bash', { command: 'npm test' }),
      textResponse('The fixture was stale; re-running the same command now.'),
      toolCallResponse('witness-pass', 'bash', { command: 'npm test' }),
      toolCallResponse('witness-list', 'advisor_obligation', { action: 'list' }),
      textResponse('The re-run passed.'),
    ] })
    const executed = registerShellFixture(h, failureThenPass())

    await h.runRoot('Fix the suite and prove it.')

    // One task, one command, first a failure and then a success.
    expect(executed).toEqual(['npm test', 'npm test'])
    const requests = h.adapter.forModel('weak')
    const noticeText = requestText(requests[1]!.request)
    expect(noticeText).toContain('[Advisor obligations')
    const match = /- (R[0-9a-f]{6}) \[validation-failure/.exec(noticeText)
    expect(match).not.toBeNull()
    const id = match![1]!

    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(0)
    expect(snapshot.items.map(item => item.id)).toEqual([id])
    expect(snapshot.items[0]).toMatchObject({ state: 'resolved', resolution: 'reverified' })
    // The witness step itself still carried the open item: nothing had closed it
    // before that run, and the whole chain stayed inside one user turn.
    expect(requestText(requests[2]!.request)).toContain('[Advisor obligations')
    expect(requestText(requests[2]!.request)).toContain(id)
    expect(h.root.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    // Both notices predate the witness: the item was never pushed again once resolved.
    expect(obligationNotices(h.root)).toHaveLength(2)
    const listed = toolResultText(h.root, 'witness-list')
    expect(listed).toContain(id + ' [validation-failure/resolved')
    expect(listed).toContain('resolved=reverified')
    expect(listed).not.toContain('[validation-failure/open')
  })

  it('does not close an earlier obligation from a successful run in a different task', async () => {
    const h = await harness({ weak: [
      toolCallResponse('task-one-fail', 'bash', { command: 'npm test' }),
      toolCallResponse('task-one-list', 'advisor_obligation', { action: 'list' }),
      textResponse('Task one recorded the failure.'),
      textResponse('Task one continues.'),
      toolCallResponse('task-two-pass', 'bash', { command: 'npm test' }),
      toolCallResponse('task-two-list', 'advisor_obligation', { action: 'list' }),
      textResponse('Task two re-ran the suite successfully.'),
      textResponse('Task two continues.'),
    ] })
    const executed = registerShellFixture(h, failureThenPass())

    await h.runRoot('Task one: reproduce the failure.')
    const first = obligationSnapshot(h)
    expect(first.openCount).toBe(1)
    const id = first.items[0]!.id

    await h.runRoot('Task two: re-run the suite from a new turn.')

    // Both calls ran the same command, and only the second one passed.
    expect(executed).toEqual(['npm test', 'npm test'])
    const second = obligationSnapshot(h)
    expect(second.taskStartSeq).toBeGreaterThan(first.taskStartSeq)
    expect(second.items).toEqual([])
    expect(second.openCount).toBe(0)
    expect(toolResultText(h.root, 'task-two-list')).toContain('No current-run obligation record.')

    // The earlier task's obligation is untouched: still open, still unresolved.
    const earlier = reachedObligations(h).open(String(h.root.id), first.taskStartSeq)
    expect(earlier.map(item => item.id)).toEqual([id])
    expect(earlier[0]!.state).toBe('open')
    expect(earlier[0]!.resolution).toBeUndefined()
  })

  it('never fires more than MAX_AUTO_REMINDERS_PER_TASK turn-stopping reminders', async () => {
    const scriptedRounds = 6
    const script = Array.from({ length: scriptedRounds }, (_, index) => [
      toolCallResponse('cap-fail-' + index, 'bash', { command: 'npm test' }),
      textResponse('Round ' + index + ' only explains the failure again.'),
    ]).flat()
    const h = await harness({ weak: script })
    registerShellFixture(h, new Map([['npm test', Array.from({ length: scriptedRounds }, () => ({ exitCode: 1, output: FAILURE_OUTPUT }))]]))

    await h.runRoot('Keep working without a passing re-run.')

    // Every round is two requests (the failing call, then the explanation). The
    // budget allows the first round plus MAX reminders, so exactly that many rounds
    // ran and the remaining scripted rounds were never requested.
    const requests = h.adapter.forModel('weak')
    expect(requests).toHaveLength((1 + MAX_AUTO_REMINDERS_PER_TASK) * 2)
    expect(h.root.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

    const snapshot = obligationSnapshot(h)
    expect(snapshot.remindersLimit).toBe(MAX_AUTO_REMINDERS_PER_TASK)
    expect(snapshot.remindersUsed).toBe(MAX_AUTO_REMINDERS_PER_TASK)
    expect(snapshot.exhausted).toBe(true)
    // Exhaustion stops the reminders without hiding or closing the record.
    expect(snapshot.openCount).toBe(1)
    expect(snapshot.items[0]).toMatchObject({ state: 'open', repeatCount: 4 })

    // One injection per obligation revision (4 recurrences) plus one reminder per
    // granted continuation (MAX): no fourth reminder was ever delivered.
    expect(obligationNotices(h.root)).toHaveLength(4 + MAX_AUTO_REMINDERS_PER_TASK)
  }, 10000)

  it('does not open an obligation for an expected-negative exit', async () => {
    // `grep -c "npm test" notes.txt` searches for the TEXT of a check; it does not
    // run one, so it now mints no validation identity at all. The expected-negative
    // class still applies, but it is no longer the ONLY thing standing between this
    // command and a bogus obligation - the identity is absent too. Stated plainly
    // because it changes what this test proves: it once demonstrated the exclusion
    // working against a PRESENT identity, and that combination is no longer
    // constructible now that a mention is rejected by position.
    const command = 'grep -c "npm test" notes.txt'
    const outcome = classified(command, 1)
    expect(outcome).toMatchObject({ class: 'expected-negative', exitCode: 1 })
    expect(outcome.validationKey).toBeUndefined()
    const h = await harness({ weak: [
      toolCallResponse('expected-negative', 'bash', { command }),
      toolCallResponse('expected-negative-list', 'advisor_obligation', { action: 'list' }),
      textResponse('No matches is the expected result.'),
      textResponse('Nothing to verify.'),
    ] })
    const executed = registerShellFixture(h, new Map([[command, [{ exitCode: 1, output: '0' }]]]))

    await h.runRoot('Check whether the notes mention the suite.')

    expect(executed).toEqual([command])
    const snapshot = obligationSnapshot(h)
    expect(snapshot.items).toEqual([])
    expect(snapshot.openCount).toBe(0)
    expect(obligationNotices(h.root)).toEqual([])
    // Three requests: nothing was injected and no reminder continued the turn.
    const requests = h.adapter.forModel('weak')
    expect(requests).toHaveLength(3)
    expect(requests.some(entry => requestText(entry.request).includes('[Advisor obligations'))).toBe(false)
    expect(toolResultText(h.root, 'expected-negative-list')).toContain('No current-run obligation record.')
  })
  it('does not let a command that merely MENTIONS a check clear the obligation', async () => {
    // The sharpest form of the defect: the mentioning command FAILS. If it carried
    // an identity it would open a bogus obligation of its own, and a succeeding
    // mention would close the genuine one - the mechanism could accuse an innocent
    // command and then absolve a check that never ran.
    const check = 'npm test'
    const mention = 'git commit -m "notes; npm test"'
    const h = await harness({ weak: [
      toolCallResponse('mention-fail', 'bash', { command: check }),
      toolCallResponse('mention-prose', 'bash', { command: mention }),
      textResponse('Committed the notes.'),
      textResponse('Nothing else to verify.'),
    ] })
    const executed = registerShellFixture(h, new Map([
      [check, [{ exitCode: 1, output: FAILURE_OUTPUT }]],
      [mention, [{ exitCode: 1, output: 'nothing to commit' }]],
    ]))

    await h.runRoot('Make the suite pass.')

    expect(executed).toEqual([check, mention])
    // No identity, so the failing commit cannot open a second obligation...
    const mentionOutcome = classified(mention, 1)
    expect(mentionOutcome.validationKey).toBeUndefined()
    expect(mentionOutcome.class).toBe('unknown-failure')
    // ...and the check it merely named is still open, exactly once.
    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(1)
    expect(snapshot.items[0]).toMatchObject({ state: 'open' })
  }, 10000)
})
