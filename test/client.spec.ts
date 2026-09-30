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
  it.each([false, true])('mounts the strict Remote contract and a root-only permission action (modern settings=%s)', async modern => {
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
      ...(modern ? { configForms: {
        get: (entryId: string) => { expect(entryId).toBe('escalation-advisor'); return {} },
        whileServed: (ids: string[], register: () => void) => { expect(ids).toEqual(['escalation-advisor']); register(); return () => {} },
      } } : { settingsScope: { bind: () => ({}) } }),
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
      expect(contribution.descriptors[0].parameters[0].codec.create().parse('root')).toBe('root')
      expect(() => contribution.descriptors[0].parameters[0].codec.create().parse(5)).toThrow('Expected string')
      const render = renders.get('conversation.session.header.actions')!
      const action = render({ sessionId: 'root' }) as { props: { ctx: any } }
      expect(action.props.ctx.remote.advisor.snapshot()).toBe('catalog')
      await ctx.plugin({ name: 'missing-remote-inject', inject: ['remote'], apply(unscoped: Context) {
        expect(() => (unscoped as any).remote.advisor).toThrow('without inject')
      } })
      expect(renderToString(render({ sessionId: 'root' }))).toContain('Advisor')
      expect(renderToString(render({ sessionId: 'worker' }))).toBe('')
      expect(renders.has(modern ? 'plugins.item' : 'settings.plugin.item')).toBe(true)
      if (modern) expect(renders.get('plugins.item')!({ view: 'summary' })).toContain('顾问模型')
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
      const currentEvent = { ...event, data: { ...event.data, source: { kind: 'plugin:dsh-escalation-advisor' } } }
      expect(messageDefinition.match(currentEvent)).toMatchObject({ id: 'advice-message' })
      const currentState = messageDefinition.start({}, { event: currentEvent })
      expect(currentState.source).toEqual(currentEvent.data.source)
      expect(renderToString(React.createElement(nodeRenders.get('steering')!, { node: { data: currentState } }))).toContain('Check the gate')
      const manual = { type: 'advisor/run', seq: 51, time: 1001, data: { id: 'manual-review', turn: 1, attempt: 1, timestamp: '2026-01-01T00:00:00Z', collectorId: 'manual-review#0.1', turns: 1, mode: 'manual', status: 'delivered', childSessionId: 'manual-child', responseText: JSON.stringify({ severity: 'concern', summary: 'Compare designs before editing', diagnosis: 'Evidence is incomplete', next_actions: ['Check concurrency'] }) } }
      expect(messageDefinition.match(manual)).toMatchObject({ id: 'manual:manual-review#0.1' })
      // A second turn of the same consultation shares `id` and `attempt`, so the
      // message identity must come from the per-turn collector id instead.
      const turnTwo = { ...manual, seq: 52, time: 1002, data: { ...manual.data, collectorId: 'manual-review#1.1', turns: 2 } }
      expect(messageDefinition.match(turnTwo)).toMatchObject({ id: 'manual:manual-review#1.1' })
      // Records written before collector ids existed fall back to a composite key.
      const legacy = { ...manual, data: { ...manual.data, collectorId: undefined, turns: undefined } }
      expect(messageDefinition.match(legacy)).toMatchObject({ id: 'manual:manual-review:1:1:2026-01-01T00:00:00Z' })
      const manualState = messageDefinition.start({}, { event: manual })
      const manualBubble = renderToString(React.createElement(nodeRenders.get('steering')!, { node: { data: manualState } }))
      expect(manualBubble).toContain('Advisor · 主动咨询')
      expect(manualBubble).toContain('Compare designs before editing')
      const rich = { ...manual, data: { ...manual.data, id: 'manual-rich', collectorId: 'manual-rich#0.1', responseText: JSON.stringify({ severity: 'concern', summary: 'S', diagnosis: 'D', next_actions: [], validation_plan: ['Rerun the check'], changes_made: [{ paths: ['a.ts'], reason: 'R', validation: ['V'] }] }) } }
      const richBubble = renderToString(React.createElement(nodeRenders.get('steering')!, { node: { data: messageDefinition.start({}, { event: rich }) } }))
      expect(richBubble).toContain('验证计划：')
      expect(richBubble).toContain('已做修改：')
      expect(richBubble).not.toContain('Validation plan:')
      expect(richBubble).not.toContain('Changes made:')
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

// A hook-driven companion fixture exercises the adapter through the registered
// settings page without requiring a browser or copying native UI components.
function companionAdapterFixture({ modern = true, result = { ok: true, value: undefined } as any, mutate = async () => true, upstreamDirectory = '' } = {}) {
  const renders = new Map<string, (props: any) => any>()
  const events = new Map<string, () => void>()
  const disposers: (() => void)[] = []
  const hooks = new Map<Function, any[]>()
  let active: any[] = [], cursor = 0
  let pending: (() => void)[] = []
  const makeStore = (value: any) => {
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      set(next: any) { value = next; for (const fn of listeners) fn() },
      update(fn: (draft: any) => void) { const next = { ...value }; fn(next); this.set(next) },
    }
  }
  const hookReact = {
    ...React,
    useState(initial: any) { const index = cursor++, cells = active; if (!(index in cells)) cells[index] = initial; return [cells[index], (value: any) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] },
    useRef(initial: any) { const index = cursor++; return active[index] ??= { current: initial } },
    useCallback: (fn: any) => fn,
    useSyncExternalStore: (_subscribe: any, getSnapshot: () => any) => getSnapshot(),
    useEffect(fn: () => void | (() => void), deps: unknown[]) {
      const index = cursor++, previous = active[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        active[index] = deps
        pending.push(() => { const off = fn(); if (off) disposers.push(off) })
      }
    },
  }
  const initialSelection = { provider: 'fixture', model: 'reviewer', reasoningEffort: 'high' }
  const reasoning = { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] }
  let catalogValue: any = { default: initialSelection, routableProviders: ['fixture'], groups: [{ id: 'fixture', models: [{ id: 'reviewer', reasoning }] }], failures: [] }
  const scope = {
    getSnapshot: () => ({ value: { ...initialSelection, enabled: false, mode: 'manual', timeoutMs: 600000, defaultEnabledTools: [] }, status: 'ready', revision: 7, writable: true }),
    subscribe: () => () => {}, mutate,
  }
  let directory: any
  class FixtureModelDirectory {
    store = makeStore({ current: initialSelection })
    constructor(readonly sessions: any, readonly id: string, _available: any, readonly catalog: any, readonly projected: any, isBlank: () => boolean) {
      directory = this
      if (modern) {
        // DSH 0.2 calls this while constructing, before the catalog has loaded.
        expect(catalog.reasoningFor(initialSelection)).toBeUndefined()
        expect(isBlank()).toBe(false)
      }
    }
    load() { return this.catalog.load() }
    async select(selection: any) {
      const response = await this.sessions.selectModel({ sessionId: this.id, ...selection })
      if (modern) return response.ok ? { ok: true, value: undefined } : response
      if (!response.ok) throw new Error(response.error.message)
    }
    dispose() {}
  }
  let ModelDirectory: any = FixtureModelDirectory
  if (upstreamDirectory) {
    // The upstream class has one runtime import (the snapshot-store API).
    // Compile the exact checkout source, without copying it into our fixtures.
    const ts = require('typescript')
    const compiled = ts.transpileModule(readFileSync(upstreamDirectory, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const exports: any = {}
    runInNewContext(compiled, { exports, require: (name: string) => {
      if (name !== '@deepseek-ai/dsh-client-store') throw new Error('Unexpected ModelDirectory runtime import: ' + name)
      return { createSnapshotStore: makeStore }
    } })
    ModelDirectory = class extends exports.ModelDirectory {
      constructor(...args: any[]) { super(...args); directory = this }
    }
  }
  const native = { registrant: '@deepseek-ai/dsh-client-ui-model-selection', locale: 'model', component: function ModelSelect() {} }
  const ctx: any = {
    remote: {
      advisor: { validateModel: async () => result.ok ? { ok: true, value: JSON.stringify(initialSelection) } : result },
      session: { modelCatalog: async () => ({ ok: true, value: catalogValue }) },
      $mount: async () => () => {},
      $on: (name: string, fn: () => void) => { events.set(name, fn); return () => { events.delete(name) } },
    },
    slots: {
      inject: (_slot: string, fn: () => any) => fn(),
      register: (slot: any, render: any) => { renders.set(slot.name, render); return () => { renders.delete(slot.name) } },
      entries: () => [native], subscribe: () => () => {},
    },
    locale: { bind: () => (key: string) => key },
    uiConversation: { events: { register: () => {} } },
    sessions: { subagentAddress: () => undefined },
    commandUi: { decorate: () => () => {} },
    effect: (fn: () => (() => void) | undefined) => { const off = fn(); if (off) disposers.push(off) },
    get(name: string) { return this[name] },
    inject(names: string[], fn: (context: any) => void) { if (names.every(name => name === 'remote.advisor' || this[name])) fn(this) },
    ...(modern
      ? { configForms: { get: (id: string) => { expect(id).toBe('escalation-advisor'); return scope }, whileServed: (names: string[], register: () => () => void) => { expect(names).toEqual(['escalation-advisor']); return register() } } }
      : { settingsScope: { bind: (spec: any) => { expect(spec.namespace).toBe('escalation-advisor'); return scope } } }),
  }
  let plugin: any
  const moduleRequire = (name: string) => name === 'react' ? hookReact
    : name === '@deepseek-ai/dsh-client-store' ? { createSnapshotStore: makeStore }
      : name === '@deepseek-ai/dsh-client-ui-model-selection' ? { ModelDirectory }
        : require(name)
  runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load({ factory }: any) { plugin = factory(moduleRequire) } } } })
  const render = (element: any) => {
    active = hooks.get(element.type) ?? []; hooks.set(element.type, active); cursor = 0; pending = []
    const tree = element.type(element.props)
    const effects = pending; pending = []; effects.forEach(effect => effect())
    return tree
  }
  return {
    plugin, ctx, renders, events, render, native, initialSelection, reasoning,
    get directory() { return directory },
    setCatalog(value: any) { catalogValue = value },
    dispose() { for (const off of disposers.reverse()) off() },
  }
}

function findElement(tree: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(tree)) return tree.map(node => findElement(node, predicate)).find(Boolean)
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  return findElement(tree.props?.children, predicate)
}

describe('Advisor native model and settings adapters', () => {
  it.skipIf(!process.env.DSH_MODEL_DIRECTORY_SOURCE)('uses the actual upstream ModelDirectory for construction, loading, and selection outcomes', async () => {
    const modern = process.env.DSH_MODEL_DIRECTORY_LEGACY !== '1'
    for (const result of [{ ok: true, value: undefined }, { ok: false, error: { code: 'session/writer-held', message: 'Held' } }]) {
      const fixture = companionAdapterFixture({ modern, result, upstreamDirectory: process.env.DSH_MODEL_DIRECTORY_SOURCE })
      try {
        await fixture.plugin.apply(fixture.ctx)
        const tree = fixture.render(fixture.renders.get(modern ? 'plugins.item' : 'settings.plugin.item')!({ view: 'page' }))
        const picker = findElement(tree, node => node.type?.name === 'AdvisorModelPicker')
        fixture.render(picker)
        await fixture.directory.load()
        expect(fixture.directory.store.getSnapshot()).toMatchObject({ current: fixture.initialSelection, routable: true })
        if (modern) expect(fixture.directory.store.getSnapshot().retainedEffort).toBe('High')
        const selector = findElement(fixture.render(picker), node => node.type === fixture.native.component)
        expect(await selector.props.select(fixture.initialSelection)).toEqual(modern ? result : result.ok)
        expect(fixture.directory.store.getSnapshot().status).toBe(result.ok ? 'ready' : 'error')
        fixture.setCatalog({ default: fixture.initialSelection, routableProviders: [], groups: [], failures: [] })
        fixture.events.get('llm/adapters-updated')!()
        await fixture.directory.load()
        expect(fixture.directory.store.getSnapshot()).toMatchObject({ current: fixture.initialSelection, routable: false })
        if (modern) expect(fixture.directory.store.getSnapshot().retainedEffort).toBe('High')
      } finally { fixture.dispose() }
    }
  })

  it.each([true, false])('opens the settings page and preserves native model selection results (modern=%s)', async modern => {
    const fixture = companionAdapterFixture({ modern })
    try {
      expect(fixture.plugin.inject).not.toContain('settingsScope')
      await fixture.plugin.apply(fixture.ctx)
      const page = fixture.renders.get(modern ? 'plugins.item' : 'settings.plugin.item')!
      expect(page).toBeTypeOf('function')
      if (modern) expect(page({ view: 'summary' })).toContain('顾问模型')
      const card = page({ view: 'page' })
      const tree = fixture.render(card)
      expect(tree.type).toBe(modern ? 'div' : 'li')
      const picker = findElement(tree, node => node.type?.name === 'AdvisorModelPicker')
      fixture.render(picker)
      await fixture.directory.load()
      expect(fixture.directory.catalog.reasoningFor(fixture.initialSelection)).toEqual(fixture.reasoning)
      const selector = findElement(fixture.render(picker), node => node.type === fixture.native.component)
      expect(await selector.props.select(fixture.initialSelection)).toEqual(modern ? { ok: true, value: undefined } : true)
      expect(fixture.directory.projected.getSnapshot()).toEqual({ next: fixture.initialSelection })
      // The Host can stop advertising a model while its saved effort stays visible.
      fixture.setCatalog({ default: fixture.initialSelection, groups: [], failures: [] })
      fixture.events.get('llm/adapters-updated')!()
      await fixture.directory.load()
      expect(fixture.directory.catalog.reasoningFor(fixture.initialSelection)).toEqual(fixture.reasoning)
    } finally { fixture.dispose() }
  })

  it.each([true, false])('preserves model-selection refusal instead of reporting success (modern=%s)', async modern => {
    const failure = { ok: false, error: { code: 'session/writer-held', message: 'Held by another writer' } }
    const fixture = companionAdapterFixture({ modern, result: failure })
    try {
      await fixture.plugin.apply(fixture.ctx)
      const tree = fixture.render(fixture.renders.get(modern ? 'plugins.item' : 'settings.plugin.item')!({ view: 'page' }))
      const picker = findElement(tree, node => node.type?.name === 'AdvisorModelPicker')
      fixture.render(picker)
      await fixture.directory.load()
      const selector = findElement(fixture.render(picker), node => node.type === fixture.native.component)
      expect(await selector.props.select(fixture.initialSelection)).toEqual(modern ? failure : false)
    } finally { fixture.dispose() }
  })

  it('keeps a rejected settings draft and shows failure after the new form returns false', async () => {
    let writes = 0
    const fixture = companionAdapterFixture({ mutate: async () => { writes += 1; return false } })
    try {
      await fixture.plugin.apply(fixture.ctx)
      const card = fixture.renders.get('plugins.item')!({ view: 'page' })
      const tree = fixture.render(card)
      findElement(tree, node => node.type === 'select' && node.props.value === 'manual').props.onChange({ target: { value: 'continuous' } })
      const changed = fixture.render(card)
      const save = findElement(changed, node => node.type === 'button' && node.props.children === '保存')
      expect(save.props.disabled).toBe(false)
      save.props.onClick()
      await new Promise(resolve => setImmediate(resolve))
      expect(writes).toBe(1)
      const settled = fixture.render(card)
      expect(findElement(settled, node => node.props?.role === 'status').props.children).toContain('保存失败')
      expect(findElement(settled, node => node.type === 'button' && node.props.children === '放弃修改').props.disabled).toBe(false)
    } finally { fixture.dispose() }
  })
})
