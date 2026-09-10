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
