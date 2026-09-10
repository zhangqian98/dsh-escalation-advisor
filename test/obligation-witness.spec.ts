import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_AUTO_REMINDERS_PER_TASK } from '../src/obligations.js'
import { mutationKey } from '../src/state.js'
import { createIntegrationHarness, textResponse, toolCallResponse, type IntegrationHarness } from './harness.js'

const FAILURE_OUTPUT = 'npm test: 2 of 12 tests failed in test/auth.spec.ts'
const PASS_OUTPUT = 'npm test: 12 of 12 tests passed'
const TYPECHECK_FAILURE = "src/index.ts(83,300): error TS2339: Property 'structuredFallback' does not exist on type 'AdvisorRunResult'."
const SUITE_FAILURE = 'FAIL test/integration.spec.ts > real DSH AgentLoop and spawn integration\nAssertionError: expected 1 to be 2'

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

function registerShellFixture(h: IntegrationHarness, outcomes: Map<string, CommandOutcome[]>, toolName = 'bash'): string[] {
  const executed: string[] = []
  h.ctx.tools.register(defineTool({
    name: toolName,
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
      if (!outcome) throw new Error('No scripted outcome left for command: ' + JSON.stringify(args.command))
      return { exitCode: outcome.exitCode, output: outcome.output }
    },
  }))
  return executed
}

function registerEditFixture(h: IntegrationHarness): string[] {
  const written: string[] = []
  h.ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Applies one scripted file change and reports the path it wrote.',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: 'wrote ' + value.path }],
    },
    execute: async (args) => {
      written.push(args.file_path)
      return { path: args.file_path }
    },
  }))
  return written
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

function obligationSnapshot(h: IntegrationHarness): ObligationSnapshot {
  const parsed = JSON.parse(h.ctx.advisor.snapshot(String(h.root.id))) as { obligations: ObligationSnapshot }
  return parsed.obligations
}

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

function toolResultText(agent: Agent, callId: string): string {
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    if (String(block.toolCallId) !== callId) continue
    return block.content.flatMap(inner => inner.type === 'text' ? [inner.text] : []).join('\n')
  }
  return ''
}

describe('obligation witnesses after a real repair', () => {
  it('confirms the edit fixture is a mutation tool under the plugin classifier', () => {
    expect(mutationKey('edit', { file_path: 'src/auth.ts', content: 'fixed' })).toBeDefined()
    expect(mutationKey('bash', { command: 'npm test' })).toBeUndefined()
  })

  it('closes the obligation when the repair is a real file change followed by a passing re-run', async () => {
    const h = await harness({ weak: [
      toolCallResponse('repair-fail', 'bash', { command: 'npm test' }),
      toolCallResponse('repair-edit', 'edit', { file_path: 'src/auth.ts', content: 'export const ok = true' }),
      toolCallResponse('repair-pass', 'bash', { command: 'npm test' }),
      toolCallResponse('repair-list', 'advisor_obligation', { action: 'list' }),
      textResponse('The repair is verified.'),
      textResponse('Nothing else to do.'),
    ] })
    const executed = registerShellFixture(h, new Map([
      ['npm test', [{ exitCode: 1, output: FAILURE_OUTPUT }, { exitCode: 0, output: PASS_OUTPUT }]],
    ]))
    const written = registerEditFixture(h)

    await h.runRoot('Fix the suite and prove it.')

    expect(executed).toEqual(['npm test', 'npm test'])
    expect(written).toEqual(['src/auth.ts'])

    const requests = h.adapter.forModel('weak')
    const noticeText = requests.map(entry => entry.request).flatMap(request => request.messages)
      .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const match = /- (R[0-9a-f]{6}) \[validation-failure/.exec(noticeText)
    expect(match).not.toBeNull()
    const id = match![1]!

    const snapshot = obligationSnapshot(h)
    expect(snapshot.items.map(item => item.id)).toEqual([id])
    expect(snapshot.openCount).toBe(0)
    expect(snapshot.items[0]).toMatchObject({ state: 'resolved', resolution: 'reverified' })
    expect(toolResultText(h.root, 'repair-list')).toContain(id + ' [validation-failure/resolved')
    expect(obligationNotices(h.root).length).toBeLessThanOrEqual(1 + MAX_AUTO_REMINDERS_PER_TASK)
  })

  it('closes the obligation when the model re-runs the failing command with different output plumbing', async () => {
    // Reproduced from a live session: the failing typecheck was piped to
    // `Select-Object -First 40`, and the repair was verified again with
    // `-First 30`, with a `; "TSC_EXIT=$LASTEXITCODE"` suffix, and bare. Four
    // command texts, one logical check, and the obligation stayed open forever.
    const BARE = 'npx tsc -p tsconfig.json --noEmit'
    const SELECT_FIRST_SHORT = BARE + ' 2>&1 | Select-Object -First 30'
    const SELECT_FIRST_LONG = BARE + ' 2>&1 | Select-Object -First 40'
    const WITH_SUFFIX = BARE + '; "TSC_EXIT=$LASTEXITCODE"'

    const h = await harness({ weak: [
      toolCallResponse('plumb-fail', 'pwsh', { command: SELECT_FIRST_LONG }),
      toolCallResponse('plumb-edit', 'edit', { file_path: 'src/index.ts', content: 'export const fixed = true' }),
      toolCallResponse('plumb-pass-1', 'pwsh', { command: BARE }),
      toolCallResponse('plumb-pass-2', 'pwsh', { command: SELECT_FIRST_SHORT }),
      toolCallResponse('plumb-pass-3', 'pwsh', { command: WITH_SUFFIX }),
      textResponse('The typecheck passes now.'),
      textResponse('Nothing else to do.'),
    ] })
    const executed = registerShellFixture(h, new Map([
      [SELECT_FIRST_LONG, [{ exitCode: 1, output: TYPECHECK_FAILURE }]],
      [SELECT_FIRST_SHORT, [{ exitCode: 0, output: '' }]],
      [BARE, [{ exitCode: 0, output: '' }]],
      [WITH_SUFFIX, [{ exitCode: 0, output: 'TSC_EXIT=0' }]],
    ]), 'pwsh')
    registerEditFixture(h)

    await h.runRoot('Fix the typecheck and verify it.')

    expect(executed).toEqual([SELECT_FIRST_LONG, BARE, SELECT_FIRST_SHORT, WITH_SUFFIX])
    const requests = h.adapter.forModel('weak')
    const noticeText = requests.map(entry => entry.request).flatMap(request => request.messages)
      .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const id = /- (R[0-9a-f]{6}) \[validation-failure/.exec(noticeText)?.[1]
    expect(id).toBeDefined()

    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(0)
    expect(snapshot.items.map(item => item.id)).toEqual([id])
    expect(snapshot.items[0]).toMatchObject({ state: 'resolved', resolution: 'reverified' })
  })

  it('closes the obligation when the passing re-run is embedded in a larger shell call', async () => {
    const CHECK = 'npx vitest run --config vitest.runtime.config.ts'
    const FAILING = CHECK + " 2>&1 | Select-String -Pattern 'FAIL|Test Files|Tests  ' | Select-Object -First 40"
    const PASSING = '$env:DSH_RUNTIME_PACKAGE_JSON = "package.json"\n'
      + CHECK + ' 2>&1 | Select-Object -First 8\n"ISOLATED_EXIT=$LASTEXITCODE"'
    expect(FAILING).not.toBe(PASSING)

    const h = await harness({ weak: [
      toolCallResponse('embed-fail', 'pwsh', { command: FAILING }),
      toolCallResponse('embed-pass', 'pwsh', { command: PASSING }),
      textResponse('The suite passes.'),
      textResponse('Nothing else to do.'),
    ] })
    const executed = registerShellFixture(h, new Map([
      [FAILING, [{ exitCode: 1, output: SUITE_FAILURE }]],
      [PASSING, [{ exitCode: 0, output: 'Test Files  20 passed (20)' }]],
    ]), 'pwsh')

    await h.runRoot('Prove the suite passes.')

    expect(executed).toEqual([FAILING, PASSING])
    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(0)
    expect(snapshot.items[0]).toMatchObject({ state: 'resolved', resolution: 'reverified' })
  })

  it('keeps the obligation open when the later pass is a different validation target', async () => {
    // A single-file run proves nothing about the whole suite, so the identity
    // must survive: target text after the command word stays significant.
    const FAILING = 'npx vitest run 2>&1 | Select-Object -Last 40'
    const OTHER_TARGET = 'npx vitest run test/other.spec.ts'

    const h = await harness({ weak: [
      toolCallResponse('target-fail', 'pwsh', { command: FAILING }),
      toolCallResponse('target-other', 'pwsh', { command: OTHER_TARGET }),
      toolCallResponse('target-list', 'advisor_obligation', { action: 'list' }),
      textResponse('One file passes.'),
      textResponse('Nothing else to do.'),
    ] })
    const executed = registerShellFixture(h, new Map([
      [FAILING, [{ exitCode: 1, output: SUITE_FAILURE }]],
      [OTHER_TARGET, [{ exitCode: 0, output: 'Test Files  1 passed (1)' }]],
    ]), 'pwsh')

    await h.runRoot('Check one file.')

    expect(executed).toEqual([FAILING, OTHER_TARGET])
    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(1)
    expect(snapshot.items[0]).toMatchObject({ state: 'open' })
    expect(toolResultText(h.root, 'target-list')).toContain('[validation-failure/open')
  })

  it('reopens the obligation when a real change follows the closing pass', async () => {
    const COMMAND = 'npx tsc -p tsconfig.json --noEmit'
    const h = await harness({ weak: [
      toolCallResponse('reopen-fail', 'pwsh', { command: COMMAND }),
      toolCallResponse('reopen-pass', 'pwsh', { command: COMMAND }),
      toolCallResponse('reopen-edit', 'edit', { file_path: 'src/state.ts', content: 'export const later = true' }),
      textResponse('Verified, then changed again.'),
      textResponse('Nothing else to do.'),
    ] })
    const executed = registerShellFixture(h, new Map([
      [COMMAND, [{ exitCode: 1, output: TYPECHECK_FAILURE }, { exitCode: 0, output: '' }]],
    ]), 'pwsh')
    const written = registerEditFixture(h)

    await h.runRoot('Fix it, verify it, then keep changing it.')

    expect(executed).toEqual([COMMAND, COMMAND])
    expect(written).toEqual(['src/state.ts'])
    const snapshot = obligationSnapshot(h)
    expect(snapshot.openCount).toBe(1)
    expect(snapshot.items[0]).toMatchObject({ state: 'open' })
    expect(snapshot.items[0]!.resolution).toBeUndefined()
  })
})
