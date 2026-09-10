import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ADVISOR_REMOTE_DESCRIPTORS } from '../src/remote.js'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToString } = require('react-dom/server')

describe('Advisor Web companion', () => {
  it('mounts the strict Remote contract and renders a root-only permission action', async () => {
    let plugin: any
    runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load({ factory }: any) { plugin = factory(require) } } } })
    const renders = new Map<string, (props: object) => unknown>()
    const nodeRenders = new Map<string, (props: any) => unknown>()
    let messageDefinition: any
    const nativeEntries = ['context', 'steering'].map(key => ({ options: { key }, component: () => React.createElement('div', null, 'native ' + key), locale: 'chat' }))
    let contribution: any
    const ctx = new Context()
    const endpoints = { snapshot: () => 'catalog' }
    class FixtureRemote extends Service {
      constructor(context: Context) { super(context, 'remote' as any) }
      get advisor() { return (this.ctx as any)['remote.advisor'] }
      async $mount(value: unknown) {
        contribution = value
        return this.ctx.provide('remote.advisor' as any, endpoints)
      }
    }
    await ctx.plugin(FixtureRemote)
    for (const [name, value] of Object.entries({
      'remote.session': {}, 'remote.llm': {}, 'remote.commands': {},
      settingsScope: { bind: () => ({}) },
      slots: { inject: (_slot: unknown, fn: () => void) => fn(), register: (slot: any, render: any) => { renders.set(slot.name, render); if (slot.name === 'conversation.chat.node') nodeRenders.set(slot.key, render) }, entries: () => nativeEntries, subscribe: () => () => {} },
      uiConversation: { events: { register: (definition: unknown) => { messageDefinition = definition } } },
      sessions: { subagentAddress: (id: string) => id === 'root' ? undefined : { parentSessionId: 'root' }, binding: () => undefined },
      commandUi: { decorate: () => () => {} },
      locale: { bind: () => (key: string) => key },
    })) ctx.provide(name as any, value)
    try {
      await ctx.plugin(plugin)
      await ctx.fiber.await()
      const shape = (value: unknown) => JSON.stringify(value, (key, item) => key === 'schema' ? 'strict-string-parser' : item)
      expect(shape(contribution.descriptors)).toBe(shape(ADVISOR_REMOTE_DESCRIPTORS))
      expect(() => contribution.descriptors[0].parameters[0].codec.schema.parse(5)).toThrow('Expected string')
      const render = renders.get('conversation.session.header.actions')!
      const action = render({ sessionId: 'root' }) as { props: { ctx: any } }
      expect(action.props.ctx.remote.advisor.snapshot()).toBe('catalog')
      await ctx.plugin({ name: 'missing-remote-inject', inject: ['remote'], apply(unscoped: Context) {
        expect(() => (unscoped as any).remote.advisor).toThrow('without inject')
      } })
      expect(renderToString(render({ sessionId: 'root' }))).toContain('Advisor')
      expect(renderToString(render({ sessionId: 'worker' }))).toBe('')
      const event = { type: 'user/message', seq: 50, time: 1000, surfaceOp: 'append', data: { id: 'advice-message', source: { kind: 'plugin', plugin: 'dsh-escalation-advisor' }, content: [{ type: 'text', text: '[Strong advisor — escalation; severity=concern; child=advisor-child]\nCheck the gate\nFull review <script>alert(1)</script>' }] } }
      const match = messageDefinition.match(event)
      const state = messageDefinition.start({}, { event })
      const node = messageDefinition.buildViewNode({ key: 'advisor-chat-message:advice-message', id: match.id, state, matches: [{ location: { kind: 'session' } }] })
      expect(node.kind).toBe('steering') // Native compact mode keeps message nodes visible.
      expect(node.data.source).toEqual(event.data.source) // Presentation never promotes plugin text to human authority.
      const bubble = renderToString(React.createElement(nodeRenders.get('steering')!, { node }))
      expect(bubble).toContain('Advisor · 自动升级')
      expect(bubble).toContain('Check the gate')
      expect(bubble).toContain('&lt;script&gt;')
      expect(bubble).not.toContain('<details')
      expect(renderToString(React.createElement(nodeRenders.get('context')!, { node }))).toBe('')
      const unrelated = { node: { data: { source: { kind: 'plugin', plugin: 'other-plugin' } } } }
      expect(renderToString(React.createElement(nodeRenders.get('context')!, unrelated))).toContain('native context')
      expect(messageDefinition.match({ ...event, data: { ...event.data, source: { kind: 'user' } } })).toBeNull()
      const manual = { type: 'advisor/run', seq: 51, time: 1001, data: { id: 'manual-review', attempt: 1, mode: 'manual', status: 'delivered', childSessionId: 'manual-child', responseText: JSON.stringify({ severity: 'concern', summary: 'Compare designs before editing', diagnosis: 'Evidence is incomplete', next_actions: ['Check concurrency'] }) } }
      expect(messageDefinition.match(manual)).toMatchObject({ id: 'manual:manual-review:1' })
      const manualState = messageDefinition.start({}, { event: manual })
      const manualBubble = renderToString(React.createElement(nodeRenders.get('steering')!, { node: { data: manualState } }))
      expect(manualBubble).toContain('Advisor · 主动咨询')
      expect(manualBubble).toContain('Compare designs before editing')
    } finally { await ctx.fiber.dispose() }
  })
})

// The obligations reminder section is a SIBLING of the `catalog && h(React.Fragment, ...)` block,
// so its arguments are evaluated on every open-panel render — including the first one, which
// happens while the async load() is still in flight and `catalog` is still null.
describe('Advisor session header action — null catalog safety', () => {
  const CONVERSATION_HEADER_SLOT = 'conversation.session.header.actions'
  const GUARDED = "            catalog && h('details', { open: true, style: { marginTop: 12, fontSize: 13 } }, h('summary'"
  const UNGUARDED = "            h('details', { open: true, style: { marginTop: 12, fontSize: 13 } }, h('summary'"
  // Verbatim pre-fix text: the same two lines with the `catalog && ` guard deleted.
  const PRE_FIX_BLOCK = "            h('details', { open: true, style: { marginTop: 12, fontSize: 13 } }, h('summary', { style: { cursor: 'pointer' } }, '未完成验证（提醒，非阻断）（' + (catalog.obligations?.openCount ?? 0) + '）'),\n              h(AdvisorObligations, { obligations: catalog.obligations })),"

  const readClientSource = () => readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

  // Same fixture as the test above: the plugin registers one render function for the
  // conversation session header slot, and 'root' is a root (non-subagent) session.
  async function mountCompanion(source: string) {
    let plugin: any
    runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }: any) { plugin = factory(require) } } } })
    const renders = new Map<string, (props: any) => unknown>()
    const nativeEntries = ['context', 'steering'].map(key => ({ options: { key }, component: () => React.createElement('div', null, 'native ' + key), locale: 'chat' }))
    const ctx = new Context()
    const endpoints = { snapshot: () => 'catalog' }
    class FixtureRemote extends Service {
      constructor(context: Context) { super(context, 'remote' as any) }
      get advisor() { return (this.ctx as any)['remote.advisor'] }
      async $mount() { return this.ctx.provide('remote.advisor' as any, endpoints) }
    }
    await ctx.plugin(FixtureRemote)
    for (const [name, value] of Object.entries({
      'remote.session': {}, 'remote.llm': {}, 'remote.commands': {},
      settingsScope: { bind: () => ({}) },
      slots: { inject: (_slot: unknown, fn: () => void) => fn(), register: (slot: any, render: any) => { renders.set(slot.name, render) }, entries: () => nativeEntries, subscribe: () => () => {} },
      uiConversation: { events: { register: () => {} } },
      sessions: { subagentAddress: (id: string) => id === 'root' ? undefined : { parentSessionId: 'root' }, binding: () => undefined },
      commandUi: { decorate: () => () => {} },
      locale: { bind: () => (key: string) => key },
    })) ctx.provide(name as any, value)
    await ctx.plugin(plugin)
    await ctx.fiber.await()
    return { ctx, render: renders.get(CONVERSATION_HEADER_SLOT)! }
  }

  // `open` and `catalog` are internal state, so the only way to reach the open-with-null-catalog
  // render is to answer the component's first two React.useState calls directly. Every later call,
  // and every other React export, is the real implementation; both patches are restored in finally.
  function renderWithForcedState(render: (props: object) => unknown, states: unknown[], { stubExternalStore = false } = {}) {
    const mutable = React as unknown as {
      useState: (initial: unknown) => [unknown, () => void]
      useSyncExternalStore: (subscribe: () => void, getSnapshot: () => unknown) => unknown
    }
    const realUseState = mutable.useState
    const realUseSyncExternalStore = mutable.useSyncExternalStore
    let calls = 0
    mutable.useState = initial => {
      calls += 1
      if (calls <= states.length) return [states[calls - 1], () => {}]
      return realUseState.call(React, initial)
    }
    // AdvisorModelPicker (rendered only once the catalog is truthy) calls useSyncExternalStore
    // without a getServerSnapshot, which react-dom/server rejects; the real DSH client runtime is
    // not present here, so read the snapshot directly for this render.
    if (stubExternalStore) mutable.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
    try { return renderToString(render({ sessionId: 'root' }) as any) }
    finally { mutable.useState = realUseState; mutable.useSyncExternalStore = realUseSyncExternalStore }
  }

  it('keeps the header control mounted when the panel opens before the catalog has loaded', async () => {
    const mounted = await mountCompanion(readClientSource())
    try {
      const html = renderWithForcedState(mounted.render, [true])
      expect(html).toContain('Advisor')
      expect(html).toContain('正在读取当前会话设置…')
      expect(html).not.toContain('未完成验证')
    } finally { await mounted.ctx.fiber.dispose() }
  })

  it('pins the crash the guard prevents: the pre-fix text dereferences a null catalog', async () => {
    const source = readClientSource()
    expect(source).toContain(GUARDED)
    const preFix = source.replace(GUARDED, UNGUARDED)
    expect(preFix).not.toBe(source)
    expect(preFix).toContain(PRE_FIX_BLOCK)
    const mounted = await mountCompanion(preFix)
    try {
      // Exactly the body of the first test, run against the pre-fix text: the render throws before
      // any assertion is reached. That a real client root then drops the subtree (which is what hid
      // the button) follows from React's no-error-boundary behaviour and is NOT executed here.
      expect(() => {
        const html = renderWithForcedState(mounted.render, [true])
        expect(html).toContain('正在读取当前会话设置…')
      }).toThrowError(new TypeError("Cannot read properties of null (reading 'obligations')"))
    } finally { await mounted.ctx.fiber.dispose() }
  })

  it('renders the obligations reminder with the open item when the catalog carries a payload', async () => {
    const catalog = {
      tools: [], mode: 'manual', modelOverridden: false, model: null,
      obligations: {
        openCount: 1, remindersUsed: 2, remindersLimit: 5, exhausted: false, retention: 'runtime-only', note: '重启后不保留任何记录。',
        items: [{ id: 'ob-1', state: 'open', kind: 'validation-failure', summary: 'Need to prove the crash', repeatCount: 3 }],
      },
    }
    const mounted = await mountCompanion(readClientSource())
    try {
      const html = renderWithForcedState(mounted.render, [true, catalog], { stubExternalStore: true })
      expect(html).toContain('未完成验证（提醒，非阻断）（1）')
      expect(html).toContain('ob-1')
      expect(html).toContain('提醒预算 2 / 5')
      expect(html).toContain('记录保留 runtime-only')
      expect(html).not.toContain('正在读取当前会话设置…')
    } finally { await mounted.ctx.fiber.dispose() }
  })
})
