// Browser companion: global Advisor defaults + per-session tool toggle panel.
window.__ModuleLoader__.load({
  id: 'dsh-escalation-advisor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const css = {
      card: { listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 12, padding: '14px 18px', margin: '8px 0', color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 12, lineHeight: 1.55, margin: '6px 0' },
      control: { width: '100%', padding: '9px 10px', marginTop: 6, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, #ddd)', color: 'inherit', background: 'var(--dsw-alias-background-l1, #fff)', font: 'inherit', boxSizing: 'border-box' },
      button: { cursor: 'pointer', marginTop: 10, padding: '7px 12px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, #ddd)', color: 'inherit', background: 'transparent' },
      row: { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' },
      toolGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginTop: 10 },
      toolToggle: { display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 8 },
      coverageGrid: { display: 'grid', gridTemplateColumns: 'minmax(130px,1fr) auto auto', gap: 8, alignItems: 'center', marginTop: 10 },
      headerRoot: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      headerButton: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 28, padding: '3px 6px', border: 0, borderRadius: 6, background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12 },
      dot: { width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: '#12b886' },
      panel: { position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 440, maxWidth: 'min(440px, 88vw)', boxSizing: 'border-box', maxHeight: '70vh', overflow: 'auto', zIndex: 1000, padding: 14, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 12, background: 'var(--dsw-alias-background-l1, #fff)', color: 'var(--dsw-alias-label-primary, inherit)', boxShadow: '0 12px 35px rgba(0,0,0,.18)' },
      toolRow: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 9, alignItems: 'start', padding: '9px 0', borderBottom: '1px solid var(--dsw-alias-border-l3, #eee)' },
      badge: { fontSize: 10, opacity: .72, whiteSpace: 'nowrap' },
      mini: { cursor: 'pointer', border: 0, background: 'transparent', color: 'inherit', opacity: .72, fontSize: 11, padding: 2 },
    }
    const WAIT = [['block', 'Block main session'], ['background', 'Run in background']]
    const MODE_LABELS = { manual: '仅主动咨询', escalate: '自动升级', continuous: '持续审阅' }
    const COMMON_TOOLS = [
      ['read', 'Read files'], ['read_image', 'Read images'], ['glob', 'List matching paths'], ['grep', 'Search file contents'],
      ['web_search', 'Web search'], ['web_fetch', 'Web fetch'],
      ['edit', 'Edit files'], ['write', 'Write/replace files'], ['bash', 'Shell (bash)'], ['pwsh', 'Shell (PowerShell)'],
    ]
    const SAFE_DEFAULTS = ['read', 'read_image', 'glob', 'grep']
    // Same strict string envelope as the Host's src/remote.ts contract.
    const stringCodec = { mode: 'strict', typeSymbol: 'string', schema: { parse(value) { if (typeof value !== 'string') throw new TypeError('Expected string'); return value } } }
    const advisorRemote = { package: 'dsh-escalation-advisor', descriptors: [
      { method: 'snapshot', args: ['sessionId'] }, { method: 'mutate', args: ['sessionId', 'action', 'tool', 'value'] },
      { method: 'selectModel', args: ['sessionId', 'selection'] },
      { method: 'validateModel', args: ['selection'] },
      { method: 'review', args: ['sessionId', 'runId'] },
    ].map(({ method, args }) => ({ id: `dsh-escalation-advisor:advisor/${method}`, service: 'advisor', namespace: 'advisor', method,
      invocation: { kind: 'direct' }, parameters: args.map(name => ({ name, wire: name, source: 'json', codec: stringCodec })), result: stringCodec })) }

    function uniqueTools(items) { return [...new Set((items ?? []).map(x => String(x).trim()).filter(Boolean))] }
    function validTimeout(value) { return Number.isSafeInteger(value) && value >= 1000 && value <= 3600000 }

    function isAdvisorMessage(data) { return data?.source?.kind === 'plugin' && data.source.plugin === 'dsh-escalation-advisor' }

    function manualAdviceText(run) {
      try {
        const reply = JSON.parse(run.responseText)
        const lines = [reply.summary, reply.disposition && '判断：' + reply.disposition, reply.diagnosis,
          ...(reply.next_actions ?? []).map((action, index) => (index + 1) + '. ' + action),
          reply.recommended_next_action && 'Recommended next action:\n' + reply.recommended_next_action,
          reply.evidence_used?.length && 'Evidence used:\n' + reply.evidence_used.map(item => item.kind + ': ' + item.reference).join('\n'),
          reply.assumptions?.length && 'Assumptions:\n' + reply.assumptions.join('\n'),
          reply.validation_plan?.length && 'Validation plan:\n' + reply.validation_plan.join('\n'),
          reply.changes_made?.length && 'Changes made:\n' + reply.changes_made.map(item => item.paths.join(', ') + ': ' + item.reason + '\n' + item.validation.join('\n')).join('\n'),
          typeof reply.needs_more_evidence === 'boolean' && '仍需补充证据：' + (reply.needs_more_evidence ? '是' : '否'),
          typeof reply.confidence === 'number' && '顾问信心：' + reply.confidence]
        return '[Strong advisor — manual; severity=' + reply.severity + '; child=' + run.childSessionId + ']\n' + lines.filter(Boolean).join('\n\n')
      } catch { return run.responseText }
    }

    function installChatMessages(ctx) {
      // Presentation only: durable provenance remains plugin-owned. A steering
      // node stays visible outside DSH's collapsed process group, like a message.
      ctx.uiConversation.events.register({
        kind: 'advisor-chat-message', target: 'chat',
        match: event => event.type === 'user/message' && event.surfaceOp === 'append' && isAdvisorMessage(event.data) ? { id: String(event.data.id), role: 'start' }
          : event.type === 'advisor/run' && event.data.mode === 'manual' && event.data.status === 'delivered' && typeof event.data.responseText === 'string' ? { id: 'manual:' + event.data.id + ':' + event.data.attempt, role: 'start' } : null,
        start: (_context, { event }) => ({ kind: 'steering', messageId: event.data.id, seq: event.seq, time: event.time,
          content: event.type === 'advisor/run' ? [{ type: 'text', text: manualAdviceText(event.data) }] : event.data.content,
          source: event.type === 'advisor/run' ? { kind: 'plugin', plugin: 'dsh-escalation-advisor' } : event.data.source }),
        update: context => context.state,
        buildViewNode: context => context.state === undefined ? null : { key: context.key, id: context.id, target: 'chat', kind: 'steering', anchorSeq: context.state.seq, location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: context.state },
      })
      const entries = () => ctx.slots.entries('conversation.chat.node')
      const useEntries = () => React.useSyncExternalStore(React.useCallback(fn => ctx.slots.subscribe('conversation.chat.node', fn), []), entries, entries)
      const fallback = (registered, key, own, props) => {
        const native = registered.find(entry => entry.options.key === key && entry.component !== own)
        return native ? h(native.component, { ...props, t: ctx.locale.bind(native.locale || 'chat') }) : null
      }
      function ContextNode(props) {
        const registered = useEntries()
        return isAdvisorMessage(props.node.data) ? null : fallback(registered, 'context', ContextNode, props)
      }
      function AdvisorMessageNode(props) {
        const registered = useEntries()
        const data = props.node.data
        if (!isAdvisorMessage(data)) return fallback(registered, 'steering', AdvisorMessageNode, props)
        const text = data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const header = text.match(/^\[Strong advisor — (\w+); severity=(\w+); child=[^\]\n]+\]\n/)
        const mode = { manual: '主动咨询', escalation: '自动升级', continuous: '持续审阅' }[header?.[1]] || '顾问消息'
        return h('article', { 'aria-label': 'Advisor 消息', 'data-advisor-chat-message': true, style: { display: 'flex', justifyContent: 'flex-end', margin: '16px 0', width: '100%' } },
          h('div', { style: { maxWidth: 'min(88%, 748px)', minWidth: 0 } },
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #667085)', marginBottom: 6 } }, h('span', { style: css.dot, 'aria-hidden': true }), 'Advisor · ' + mode),
            h('div', { style: { background: 'var(--dsw-specific-bubble, #edf2ff)', borderRadius: 20, padding: '12px 16px', fontSize: 'var(--dsh-content-font-size, 14px)', lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary, inherit)' } }, header ? text.slice(header[0].length) : text)))
      }
      ctx.slots.inject('conversation.chat.node', () => {
        ctx.slots.register({ name: 'conversation.chat.node', key: 'context', priority: -50 }, ContextNode)
        ctx.slots.register({ name: 'conversation.chat.node', key: 'steering', priority: -50 }, AdvisorMessageNode)
      })
    }

    function SettingsCard({ scope, remote, ctx }) {
      const snapshot = React.useSyncExternalStore(React.useCallback(fn => scope.subscribe(fn), [scope]), React.useCallback(() => scope.getSnapshot(), [scope]))
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [modelBusy, setModelBusy] = React.useState(false)

      const value = draft?.value ?? snapshot.value
      if (!value) return h('li', { style: css.card }, '正在读取 Escalation Advisor 设置…')
      const edit = (field, next) => { setNotice(''); setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), [field]: next } })) }
      const selectedModel = { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
      const selectDefaultModel = selected => { setNotice(''); setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), ...selected, reasoningEffort: selected.reasoningEffort || '' } })) }
      const dirty = draft !== null && JSON.stringify(value) !== JSON.stringify(snapshot.value)
      const conflicted = draft !== null && draft.revision !== snapshot.revision
      const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving || modelBusy
      const saveDisabled = disabled || conflicted || !dirty || !validTimeout(value.timeoutMs) || (value.enabled && (!value.provider.trim() || !value.model.trim()))
      const enabledDefaults = uniqueTools(value.defaultEnabledTools)
      const enabledSet = new Set(enabledDefaults)
      const commonNames = new Set(COMMON_TOOLS.map(([name]) => name))
      const extraDefaultTools = enabledDefaults.filter(name => !commonNames.has(name))
      const field = (label, control, hint) => h('div', { style: { margin: '14px 0' } }, h('label', null, label, control), hint && h('p', { style: css.hint }, hint))
      const check = (fieldName, label) => h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' } }, h('input', { type: 'checkbox', checked: !!value[fieldName], disabled, onChange: e => edit(fieldName, e.target.checked) }), label)
      const setDefaultTool = (name, on) => edit('defaultEnabledTools', on ? uniqueTools([...enabledDefaults, name]) : enabledDefaults.filter(item => item !== name))
      const save = async () => {
        if (saveDisabled) return
        setSaving(true); setNotice('')
        try {
          const desired = { ...value, provider: value.provider.trim(), model: value.model.trim(), defaultEnabledTools: uniqueTools(value.defaultEnabledTools) }
          if (desired.enabled) {
            const validation = await remote.advisor.validateModel(JSON.stringify(selectedModel))
            if (!validation.ok) throw new Error(validation.error.message)
          }
          await scope.mutate(Object.entries(desired).map(([field, entry]) => ({ op: 'set', path: [field], value: entry })), draft.revision)
          setDraft(null); setNotice('已保存全局默认。会话中显式设置的模型和工具继续使用各自的覆盖值。')
        } catch (error) { setNotice('保存失败：' + (error instanceof Error ? error.message : String(error))) }
        finally { setSaving(false) }
      }

      return h('li', { style: css.card, 'data-escalation-advisor-settings': true },
        h('h3', { style: { margin: '2px 0 8px' } }, 'DSH Escalation Advisor'),
        h('p', { style: { margin: '6px 0', lineHeight: 1.6 } }, 'Advisor 以可查看的 DSH 子会话运行。这里配置模型、覆盖范围、全局默认工具开关和等待策略。'),
        h('p', { style: css.hint }, '工具权限是“默认开/默认关”。当前 root 会话可在标题栏 Advisor 面板逐个覆盖；本地 subagent 只能在 root 允许范围与自身实际可见工具的交集中使用 Advisor 工具。'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 } }, h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: e => edit('enabled', e.target.checked) }), '启用 Advisor'),
        field('模式', h('select', { style: css.control, value: value.mode, disabled, onChange: e => edit('mode', e.target.value) }, h('option', { value: 'manual' }, 'manual'), h('option', { value: 'escalate' }, 'escalate（推荐）'), h('option', { value: 'continuous' }, 'continuous'))),
        h('div', { style: { margin: '14px 0' } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 7 } }, '全局默认顾问模型与思考等级'),
          h(AdvisorModelPicker, { ctx, sessionId: 'advisor-global-default', selection: selectedModel, disabled, onSelect: selectDefaultModel, onBusy: setModelBusy }),
          h('p', { style: css.hint }, '使用与主对话框相同的模型菜单。每个会话可以在标题栏 Advisor 中覆盖这里的默认选择。')),
        field('默认咨询超时（分钟）', h('input', { type: 'number', min: 1 / 60, max: 60, step: 'any', style: css.control, value: (value.timeoutMs ?? 600000) / 60000, disabled, onChange: event => edit('timeoutMs', Math.round(Number(event.target.value) * 60000)) }), '默认 10 分钟，可设为 1 秒至 60 分钟。这是单次尝试的总时限，含排队和生成；重试重新计时。'),
        !validTimeout(value.timeoutMs) && h('p', { role: 'alert', style: css.hint }, '请输入 1 秒至 60 分钟之间的超时。'),
        h('details', { style: { margin: '8px 0', fontSize: 12 } }, h('summary', { style: { cursor: 'pointer' } }, '手动填写未列出的模型'),
          h('div', { style: css.row },
            field('提供商 ID', h('input', { style: css.control, value: value.provider, disabled, onChange: event => selectDefaultModel({ provider: event.target.value, model: value.model }) })),
            field('模型 ID', h('input', { style: css.control, value: value.model, disabled, onChange: event => selectDefaultModel({ provider: value.provider, model: event.target.value }) })),
            field('思考等级 ID', h('input', { style: css.control, value: value.reasoningEffort || '', disabled, placeholder: '留空跟随模型默认', onChange: event => edit('reasoningEffort', event.target.value) })))),

        h('div', { style: { marginTop: 18 } },
          h('strong', null, 'Agent 覆盖范围'),
          h('p', { style: css.hint }, 'Manual 与自动 escalation 默认覆盖主 agent 和本地 DSH subagent；Continuous 默认只审主 agent，避免 N 个 worker 各自持续调用强模型。Advisor 自己永远不递归。'),
          h('div', { style: css.coverageGrid },
            h('strong', null, '模式'), h('strong', { style: { textAlign: 'center' } }, '主 agent'), h('strong', { style: { textAlign: 'center' } }, '本地 subagent'),
            h('span', null, 'Manual consultation'), check('manualMainAgent', '开'), check('manualLocalSubagents', '开'),
            h('span', null, 'Automatic escalation'), check('escalationMainAgent', '开'), check('escalationLocalSubagents', '开'),
            h('span', null, 'Continuous review'), check('continuousMainAgent', '开'), check('continuousLocalSubagents', '开')),
          h('p', { style: css.hint }, '本地 subagent 的自动 escalation / continuous 一旦启用会强制等待 Advisor 完成，避免 one-shot worker 先把旧结果交回父 agent。')),

        h('div', { style: { marginTop: 18 } },
          h('strong', null, '全局默认工具开关'),
          h('p', { style: css.hint }, '推荐只默认开启明确的检查能力。写文件、shell、MCP/插件工具默认保持关闭；它们可以在具体 root 会话里临时打开。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: css.button, disabled, onClick: () => edit('defaultEnabledTools', SAFE_DEFAULTS) }, '恢复安全默认'),
            h('button', { type: 'button', style: css.button, disabled, onClick: () => edit('defaultEnabledTools', uniqueTools([...SAFE_DEFAULTS, 'web_search', 'web_fetch'])) }, '检查 + 联网'),
            h('button', { type: 'button', style: css.button, disabled, onClick: () => edit('defaultEnabledTools', []) }, '全部默认关闭')),
          h('div', { style: css.toolGrid }, ...COMMON_TOOLS.map(([name, label]) => h('label', { key: name, style: css.toolToggle },
            h('input', { type: 'checkbox', checked: enabledSet.has(name), disabled, onChange: e => setDefaultTool(name, e.target.checked) }),
            h('span', null, h('div', { style: { fontWeight: 600 } }, name), h('div', { style: css.hint }, label))
          ))),
          field('其它默认开启工具', h('input', { type: 'text', style: css.control, value: extraDefaultTools.join(', '), disabled, placeholder: 'mcp__server__tool, custom_tool', onChange: e => edit('defaultEnabledTools', uniqueTools([...enabledDefaults.filter(name => commonNames.has(name)), ...e.target.value.split(/[\s,]+/)])) }), '用于 MCP 或其它插件工具的精确名称。没有显式加入这里的未知工具默认关闭。'),
          field('确认只读的自定义工具', h('input', { type: 'text', style: css.control, value: (value.readOnlyTools ?? []).join(', '), disabled, onChange: e => edit('readOnlyTools', uniqueTools(e.target.value.split(/[\s,]+/))) }), '仅列入不会修改文件或外部状态的工具。其它未知工具启用后会强制阻塞执行。'),
          field('可修改状态的工具', h('input', { type: 'text', style: css.control, value: (value.mutatingTools ?? []).join(', '), disabled, onChange: e => edit('mutatingTools', uniqueTools(e.target.value.split(/[\s,]+/))) })),
          field('额外委派工具（Advisor 禁用）', h('input', { type: 'text', style: css.control, value: (value.capabilityAmplifierTools ?? []).join(', '), disabled, onChange: e => edit('capabilityAmplifierTools', uniqueTools(e.target.value.split(/[\s,]+/))) }), 'DSH 内置委派工具的别名自动识别；在这里补充可创建远端 agent 或工作流的自定义/MCP 工具。')),

        h('div', { style: css.row },
          field('主 agent 自动 escalation', h('select', { style: css.control, value: value.escalationWait, disabled, onChange: e => edit('escalationWait', e.target.value) }, ...WAIT.map(([id, label]) => h('option', { key: id, value: id }, label)))),
          field('主 agent Continuous review', h('select', { style: css.control, value: value.continuousWait, disabled, onChange: e => edit('continuousWait', e.target.value) }, ...WAIT.map(([id, label]) => h('option', { key: id, value: id }, label))))),
        h('details', { style: { marginTop: 18 } }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '成本、预算与阈值'),
          h('div', { style: css.row },
            field('手动咨询 / agent（-1 = 无上限）', h('input', { type: 'number', min: -1, max: 100, style: css.control, value: value.maxManualConsultsPerSession, disabled, onChange: e => edit('maxManualConsultsPerSession', Number(e.target.value)) })),
            field('Task-tree 顾问总预算（-1 = 无上限）', h('input', { type: 'number', min: -1, max: 1000, style: css.control, value: value.maxAdvisorConsultsPerTask, disabled, onChange: e => edit('maxAdvisorConsultsPerTask', Number(e.target.value)) })),
            field('Task-tree 最大并发', h('input', { type: 'number', min: 1, max: 32, style: css.control, value: value.maxConcurrentAdvisorRuns, disabled, onChange: e => edit('maxConcurrentAdvisorRuns', Number(e.target.value)) })),
            field('自动升级阈值', h('input', { type: 'number', min: 1, max: 100, style: css.control, value: value.scoreThreshold, disabled, onChange: e => edit('scoreThreshold', Number(e.target.value)) }))),
          h('p', { style: css.hint }, '输入上下文与输出上限跟随所选模型的 DSH 配置；Advisor 不另设 token 限额。')),
        h('p', { style: css.hint }, '当前 root 会话标题栏的 Advisor 面板会枚举该会话实际可见的全部工具，并可逐个覆盖这里的默认开关。覆盖作为整棵本地 agent 树的权限 ceiling。'),
        conflicted && h('p', { role: 'alert', style: css.hint }, '设置已被其他页面修改，请放弃草稿后重试。'), notice && h('p', { role: 'status', style: css.hint }, notice),
        h('div', { style: { display: 'flex', gap: 10 } }, h('button', { type: 'button', style: { ...css.button, opacity: saveDisabled ? 0.55 : 1 }, disabled: saveDisabled, onClick: () => { void save() } }, saving ? '保存中…' : '保存'), h('button', { type: 'button', style: css.button, disabled: saving || modelBusy || !draft, onClick: () => { setDraft(null); setNotice('') } }, '放弃修改')))
    }

    async function advisorRequest(ctx, sessionId, mutation) {
      const result = mutation ? await ctx.remote.advisor.mutate(sessionId, ...mutation) : await ctx.remote.advisor.snapshot(sessionId)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    function parseCatalog(text) {
      const value = JSON.parse(text)
      if (!value || !Array.isArray(value.tools)) throw new Error('Invalid Advisor tool catalog')
      return value
    }

    const modelCatalogs = new WeakMap()
    function nativeModelCatalog(ctx, createSnapshotStore) {
      const cached = modelCatalogs.get(ctx.remote)
      if (cached) return cached
      const store = createSnapshotStore({ value: null, status: 'idle', error: null })
      let inflight, disposed = false
      const catalog = { store, load() {
        const current = store.getSnapshot()
        if (current.status === 'ready') return Promise.resolve(current.value)
        if (inflight) return inflight
        store.update(state => { state.status = 'loading'; state.error = null })
        inflight = ctx.remote.session.modelCatalog().then(result => {
          if (!result.ok) throw new Error(result.error.message)
          if (!disposed) store.set({ value: result.value, status: 'ready', error: null })
          return result.value
        }).catch(error => {
          if (!disposed) store.update(state => { state.status = 'error'; state.error = error.message })
          throw error
        }).finally(() => { inflight = undefined })
        return inflight
      } }
      const invalidate = () => store.update(state => { state.status = 'idle' })
      const off = [ctx.remote.$on('llm/adapters-updated', invalidate), ctx.remote.$on('settings/document-updated', invalidate)]
      ctx.effect(() => () => { disposed = true; off.forEach(dispose => dispose()); modelCatalogs.delete(ctx.remote) }, 'advisor: native model catalog')
      modelCatalogs.set(ctx.remote, catalog)
      return catalog
    }

    // Reuses DSH's actual ModelSelect component and ModelDirectory.select API.
    // Only its persistence face is routed to Advisor preferences: submitting the
    // root ID to the ordinary session endpoint would change the main model.
    function AdvisorModelPicker({ ctx, sessionId, selection, disabled, onSnapshot, onBusy, onSelect }) {
      const entries = React.useSyncExternalStore(
        React.useCallback(fn => ctx.slots.subscribe('conversation.input.model', fn), [ctx]),
        React.useCallback(() => ctx.slots.entries('conversation.input.model'), [ctx]))
      const native = entries.find(entry => entry.registrant === '@deepseek-ai/dsh-client-ui-model-selection' || entry.component?.name === 'ModelSelect')
      const [controller, setController] = React.useState(null)
      const callbacks = React.useRef({ onSnapshot, onBusy, onSelect })
      callbacks.current = { onSnapshot, onBusy, onSelect }
      React.useEffect(() => {
        const { ModelDirectory } = require('@deepseek-ai/dsh-client-ui-model-selection')
        const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
        const projected = createSnapshotStore({ next: selection })
        let live = true
        const directory = new ModelDirectory({
          async selectModel(request) {
            const { sessionId: target, ...model } = request
            callbacks.current.onBusy(true)
            try {
              if (callbacks.current.onSelect) {
                const result = await ctx.remote.advisor.validateModel(JSON.stringify(model))
                if (!result.ok) return result
                const selected = JSON.parse(result.value)
                if (live) { projected.set({ next: selected }); callbacks.current.onSelect(selected) }
                return { ok: true, value: { selected } }
              }
              const result = await ctx.remote.advisor.selectModel(target, JSON.stringify(model))
              if (!result.ok) return result
              const snapshot = parseCatalog(result.value)
              if (live) {
                projected.set({ next: snapshot.model })
                callbacks.current.onSnapshot(snapshot)
              }
              return { ok: true, value: { selected: snapshot.model } }
            } catch (error) {
              return { ok: false, error: { code: 'advisor/model-selection', message: error instanceof Error ? error.message : String(error) } }
            } finally { if (live) callbacks.current.onBusy(false) }
          },
        }, sessionId, () => live, nativeModelCatalog(ctx, createSnapshotStore), projected)
        setController({ directory, projected })
        directory.load().catch(() => {})
        return () => { live = false; directory.dispose() }
      }, [ctx, sessionId])
      React.useEffect(() => { controller?.projected.set({ next: selection }) }, [controller, selection])
      if (!native) return h('p', { role: 'status', style: css.hint }, '正在等待 DSH 原生模型选择器…')
      if (!controller) return h('p', { role: 'status', style: css.hint }, '正在读取模型…')
      return h('div', { 'data-advisor-model-picker': true, onKeyDown: event => { if (event.key === 'Escape' && event.defaultPrevented) event.stopPropagation() } },
        h('style', null, '[data-advisor-model-picker] [role="menu"]{position:static!important;width:100%!important;max-width:100%;margin-top:8px;box-sizing:border-box}[data-advisor-model-picker] button[aria-haspopup="menu"]{width:100%;max-width:100%;justify-content:space-between}[data-advisor-model-picker]>div{display:block}'),
        h(native.component, {
          locked: disabled, available: true, directory: controller.directory.store,
          load: () => { controller.directory.load().catch(() => {}) },
          select: next => controller.directory.select(next).then(() => true, () => false),
          t: ctx.locale.bind(native.locale || 'model'),
        }))
    }

    function AdvisorReview({ ctx, sessionId, run }) {
      const [open, setOpen] = React.useState(false)
      const [review, setReview] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      React.useEffect(() => {
        if (!open) return
        let active = true
        setLoading(true); setError('')
        ctx.remote.advisor.review(sessionId, run.id).then(result => {
          if (!result.ok) throw new Error(result.error.message)
          const value = JSON.parse(result.value)
          if (active) setReview(value)
        }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
          .finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [ctx, sessionId, run.id, run.status, open])
      const mode = { manual: '模型主动咨询', escalation: '失败信号触发', continuous: '持续审阅' }[run.mode] || run.mode
      const status = { reserved: '等待开始', started: '正在咨询', delivered: '已返回', stale: '结果已过期', 'failed-transient': '暂时失败', 'failed-permanent': '失败', cancelled: '已取消', skipped: '已跳过' }[run.status] || run.status
      return h('div', { 'data-advisor-review': run.id, style: { padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l3, #eee)' } },
        h('strong', null, '第 ' + run.turn + ' 轮 · ' + mode + ' · ' + status),
        run.score !== undefined && h('p', { style: css.hint }, '触发分数 ' + run.score + (run.step === undefined ? '' : ' · 第 ' + run.step + ' 步')),
        (run.summary || run.error) && h('p', { style: { ...css.hint, overflowWrap: 'anywhere' } }, run.summary || run.error),
        run.status === 'delivered' && h('button', { type: 'button', style: css.button, 'aria-expanded': open, onClick: () => setOpen(value => !value) }, open ? '收起完整内容' : run.mode === 'manual' ? '查看完整回复' : '查看完整回注'),
        open && h('div', { style: { marginTop: 10, overflowWrap: 'anywhere' } },
          loading ? h('p', { role: 'status', style: css.hint }, '正在读取回注记录…') : error ? h('p', { role: 'alert', style: css.hint }, '读取失败：' + error) : review && h(React.Fragment, null,
            review.question && h('p', { style: css.hint }, '咨询问题：' + review.question),
            h('p', { style: css.hint }, { context: '以下是实际注入该会话的完整原文。', 'tool-result': '以下是返回给模型的咨询工具回复。', report: '以下是顾问报告；当前尚未找到实际回注记录。', missing: '此历史记录没有保留完整报告。可在原会话的上下文注入或咨询工具结果中查看。' }[review.source]),
            review.text && h('div', { 'data-advisor-review-content': true, style: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap' } }, review.text))),
        h('p', { style: css.hint }, run.usage ? '输入 ' + run.usage.inputTokens + ' / 输出 ' + run.usage.outputTokens + ' tokens · 金额未提供' : '用量尚未提供'),
        run.childSessionId && h('p', { style: { ...css.hint, overflowWrap: 'anywhere' } }, '子会话 ' + run.childSessionId))
    }

    function SessionTimeoutControl({ catalog, disabled, onSave }) {
      const [draft, setDraft] = React.useState(null)
      const value = draft ?? String((catalog.timeoutMs ?? 600000) / 60000)
      const timeoutMs = Math.round(Number(value) * 60000)
      const valid = value.trim() !== '' && validTimeout(timeoutMs)
      const save = async value => { if (await onSave(value)) setDraft(null) }
      return h('div', { style: { marginTop: 12 } },
        h('label', { style: { display: 'block', fontSize: 13 } }, '单次咨询超时（分钟）',
          h('input', { type: 'number', min: 1 / 60, max: 60, step: 'any', style: css.control, value, disabled, onChange: event => setDraft(event.target.value) })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 } },
          h('button', { type: 'button', style: { ...css.button, marginTop: 0 }, disabled: disabled || draft === null || !valid, onClick: () => { void save(String(timeoutMs)) } }, '应用超时'),
          catalog.timeoutOverride !== undefined && catalog.timeoutOverride !== 'inherit'
            ? h('button', { type: 'button', style: css.mini, disabled, onClick: () => { void save('inherit') } }, '超时使用全局默认')
            : h('span', { style: css.badge }, '跟随全局默认（' + (catalog.timeoutDefaultMs ?? 600000) / 60000 + ' 分钟）')),
        draft !== null && !valid && h('p', { role: 'alert', style: css.hint }, '请输入 1 秒至 60 分钟之间的超时。'),
        h('p', { style: css.hint }, '单次尝试的总时限，重试重新计时。修改从下一次咨询生效。'))
    }

    // Runtime-only verification obligations. This section is a reminder, never a
    // gate, and a missing or empty record is never presented as an all-clear,
    // because a restart keeps no record at all.
    const OBLIGATION_KINDS = { 'validation-failure': '验证失败 validation-failure', 'claim-contradicted': '发布结论被反例推翻 claim-contradicted' }
    const OBLIGATION_DISPOSITIONS = { 'not-applicable': '不适用 not-applicable', 'accept-risk': '接受风险 accept-risk' }

    function AdvisorObligations({ obligations }) {
      if (!obligations) return h('p', { role: 'status', style: css.hint }, 'Host 未提供 obligation 记录，且 runtime-only 记录不跨重启保留：这不能视为验证全部通过。')
      const items = (Array.isArray(obligations.items) ? obligations.items : []).filter(item => item && item.state === 'open')
      const used = Number.isSafeInteger(obligations.remindersUsed) ? obligations.remindersUsed : 0
      const limit = Number.isSafeInteger(obligations.remindersLimit) ? obligations.remindersLimit : 0
      return h(React.Fragment, null,
        h('p', { style: css.hint }, '提醒（reminder），不是阻断：未完成的验证项不阻止继续执行，也不因预算、评分或冷却而消失。'),
        h('p', { style: css.hint }, '提醒预算 ' + used + ' / ' + limit + (obligations.exhausted ? (items.length ? ' · 提醒预算已用尽（reminders exhausted; still open）' : '（提醒预算已用尽，本轮没有未完成验证项）') : '')),
        h('p', { style: css.hint }, '记录保留 ' + String(obligations.retention || 'unknown') + '：' + String(obligations.note || '重启后不保留任何记录。')),
        items.length === 0
          ? h('p', { role: 'status', style: css.hint }, '本轮没有未完成验证的记录：runtime-only 记录不跨重启保留，空列表不代表验证全部通过。')
          : items.map(item => h('div', { key: String(item.id), style: css.toolRow },
            h('span', { style: css.badge }, String(item.id)),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, OBLIGATION_KINDS[item.kind] || String(item.kind)),
              h('div', { style: { ...css.hint, overflowWrap: 'anywhere' } }, String(item.summary || '')),
              item.disposition && h('span', { style: css.badge }, '处置：' + (OBLIGATION_DISPOSITIONS[item.disposition] || String(item.disposition)) + '（处置不关闭验证项）')),
            h('span', { style: css.badge }, '重复 ×' + (Number.isSafeInteger(item.repeatCount) ? item.repeatCount : 0)))))
    }

    function AdvisorSessionAction({ ctx, sessionId }) {
      const [open, setOpen] = React.useState(false)
      const [catalog, setCatalog] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [toolsExpanded, setToolsExpanded] = React.useState(false)
      const [panelPosition, setPanelPosition] = React.useState({ left: 8, top: 48 })
      const root = React.useRef(null)
      const isSubagent = ctx.sessions.subagentAddress(sessionId) !== undefined
      const load = React.useCallback(async () => {
        if (isSubagent) return
        setError('')
        try { setCatalog(parseCatalog(await advisorRequest(ctx, sessionId))) }
        catch (err) { setError(err instanceof Error ? err.message : String(err)) }
      }, [ctx, sessionId, isSubagent])

      React.useEffect(() => { if (open && !isSubagent) void load() }, [open, load, isSubagent])
      React.useEffect(() => {
        if (!open) { setToolsExpanded(false); setQuery(''); return }
        const close = event => { if (root.current && !root.current.contains(event.target)) setOpen(false) }
        const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented) { setOpen(false); root.current?.querySelector('button')?.focus() } }
        document.addEventListener('pointerdown', close)
        document.addEventListener('keydown', escape)
        return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
      }, [open])
      React.useEffect(() => {
        if (!open || isSubagent) return
        const align = () => {
          const anchor = root.current?.getBoundingClientRect()
          if (!anchor) return
          const width = Math.min(440, window.innerWidth * .88)
          const position = { left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)), top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - 88)) }
          setPanelPosition(previous => previous.left === position.left && previous.top === position.top ? previous : position)
        }
        align()
        window.addEventListener('resize', align)
        document.addEventListener('scroll', align, true)
        return () => { window.removeEventListener('resize', align); document.removeEventListener('scroll', align, true) }
      }, [open, isSubagent, sessionId, catalog])

      if (isSubagent) return null
      const mutate = async (key, mutation) => {
        setBusy(key); setError('')
        try { setCatalog(parseCatalog(await advisorRequest(ctx, sessionId, mutation))); return true }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); await load(); return false }
        finally { setBusy('') }
      }
      const inheritModel = async () => {
        setBusy('model'); setError('')
        try {
          const result = await ctx.remote.advisor.selectModel(sessionId, 'null')
          if (!result.ok) throw new Error(result.error.message)
          setCatalog(parseCatalog(result.value))
        } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
        finally { setBusy('') }
      }
      const tools = toolsExpanded ? (catalog?.tools ?? []).filter(tool => !query || (tool.name + ' ' + tool.description).toLowerCase().includes(query.toLowerCase())) : []
      const enabledCount = catalog?.tools?.filter(tool => tool.enabled).length ?? 0
      const wait = (label, field, inherited, override) => h('label', { style: { display: 'block', fontSize: 13 } }, label,
        h('select', { style: css.control, value: override || 'inherit', disabled: !!busy, onChange: event => mutate(field, [field, '', event.target.value]) },
          h('option', { value: 'inherit' }, '跟随全局默认（' + (inherited === 'block' ? '等待顾问完成' : '后台运行') + '）'), h('option', { value: 'block' }, '等待顾问完成'), h('option', { value: 'background' }, '后台运行')))

      return h('div', { ref: root, style: css.headerRoot },
        h('button', { type: 'button', style: css.headerButton, 'aria-label': 'Advisor 设置', 'aria-expanded': open, onClick: () => setOpen(value => !value), title: '配置此会话的 Advisor 模型、思考等级和工具' },
          h('span', { 'aria-hidden': true, style: { ...css.dot, ...(catalog?.guidance?.available === false ? { background: '#94a3b8' } : {}) } }), 'Advisor', catalog && h('span', null, '(' + enabledCount + ')')),
        open && h('div', { role: 'dialog', 'aria-label': 'Advisor 会话设置', style: { ...css.panel, position: 'fixed', right: 'auto', ...panelPosition, maxHeight: 'min(70vh, calc(100vh - ' + (panelPosition.top + 8) + 'px))' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 14 } },
            h('strong', null, 'Advisor · 当前会话'),
            h('button', { type: 'button', style: css.mini, disabled: !!busy, onClick: () => mutate('reset', ['reset', '', '']) }, '全部恢复默认')),
          error && h('p', { role: 'alert', style: { ...css.hint, color: 'var(--dsw-alias-label-error, #b42318)' } }, error),
          catalog && h(React.Fragment, null,
            h('div', { role: 'group', 'aria-label': '会话模式与等待策略', style: { padding: 12, marginBottom: 16, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 9 } },
            h('label', { style: { display: 'block', fontSize: 13, fontWeight: 600 } }, '当前会话模式',
              h('select', { style: css.control, value: catalog.modeOverride || 'inherit', disabled: !!busy, onChange: event => mutate('mode', ['mode', '', event.target.value]) },
                h('option', { value: 'inherit' }, '跟随全局默认（' + (MODE_LABELS[catalog.modeDefault] || catalog.modeDefault) + '）'),
                ...Object.entries(MODE_LABELS).map(([mode, label]) => h('option', { key: mode, value: mode }, label)))),
            h('p', { style: { ...css.hint, marginBottom: catalog.mode === 'manual' ? 0 : 12 } }, { manual: '由模型主动发起咨询并等待回复，无需设置自动等待策略。', escalate: '保留主动咨询，失败信号达到阈值时自动请顾问检查。', continuous: '保留主动咨询，在轮次结束时审阅新增工作。' }[catalog.mode], ' 适用于当前任务树，遵循各角色的覆盖范围。'),
            catalog.mode === 'escalate' && wait('自动升级的等待策略', 'escalationWait', catalog.escalationWaitDefault ?? catalog.escalationWait, catalog.escalationWaitOverride),
            catalog.mode === 'continuous' && wait('持续审阅的等待策略', 'continuousWait', catalog.continuousWaitDefault ?? catalog.continuousWait, catalog.continuousWaitOverride),
            h(SessionTimeoutControl, { key: sessionId, catalog, disabled: !!busy, onSave: value => mutate('timeoutMs', ['timeoutMs', '', value]) })),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, '顾问模型与思考等级'),
              catalog.modelOverridden
                ? h('button', { type: 'button', style: css.mini, disabled: !!busy, onClick: inheritModel }, '使用全局默认')
                : h('span', { style: css.badge }, '跟随全局默认')),
            h(AdvisorModelPicker, { key: sessionId, ctx, sessionId, selection: catalog.model, disabled: !!busy, onSnapshot: setCatalog, onBusy: value => setBusy(value ? 'model' : '') }),
            h('p', { style: css.hint }, '用于此会话及其本地子任务后续的 Advisor 咨询。'),
            h('details', { open: toolsExpanded, onToggle: event => setToolsExpanded(event.currentTarget.open), style: { borderTop: '1px solid var(--dsw-alias-border-l3, #eee)', paddingTop: 10 } },
              h('summary', { style: { cursor: 'pointer', fontSize: 13, fontWeight: 600 } }, '工具权限', h('span', { style: { ...css.badge, marginLeft: 8, fontWeight: 400 } }, enabledCount + ' / ' + catalog.tools.length + ' 已启用')),
              toolsExpanded && h(React.Fragment, null,
                h('p', { style: css.hint }, '这些开关限定整棵本地任务树的 Advisor 能力；子任务还需自身拥有对应工具。'),
                catalog.tools.some(tool => tool.enabled && tool.effect !== 'read-only') && h('p', { role: 'status', style: css.hint }, '已启用编辑能力或副作用未知的工具：Advisor 会等待完成并独占工作区。'),
                h('input', { type: 'search', style: css.control, placeholder: '搜索 ' + catalog.tools.length + ' 个工具…', value: query, onChange: event => setQuery(event.target.value) }),
                ...tools.map(tool => h('div', { key: tool.name, style: css.toolRow },
                  h('input', { type: 'checkbox', 'aria-label': 'Advisor 工具 ' + tool.name, checked: !!tool.enabled, disabled: !!busy || tool.reserved, onChange: event => mutate(tool.name, ['tool', tool.name, event.target.checked ? 'allow' : 'deny']) }),
                  h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, tool.name),
                    tool.description && h('div', { style: css.hint }, tool.description),
                    h('span', { style: css.badge }, tool.reserved ? '保留禁用 · 可创建执行作用域' : (tool.override === 'allow' ? '会话开启' : tool.override === 'deny' ? '会话关闭' : tool.defaultEnabled ? '默认开启' : '默认关闭') + ' · ' + ({ 'read-only': '只读', mutating: '可修改', unknown: '副作用未知' }[tool.effect] || '副作用未知'))),
                  tool.override !== 'inherit' && h('button', { type: 'button', style: css.mini, disabled: !!busy, onClick: () => mutate(tool.name, ['tool', tool.name, 'inherit']) }, '默认'))),
                tools.length === 0 && h('p', { style: css.hint }, '没有匹配的工具。'))),
            h('details', { style: { marginTop: 12, fontSize: 13 } },
              h('summary', { style: { cursor: 'pointer' } }, catalog.guidance?.reason || 'Advisor 使用指导'),
              h('p', { style: css.hint }, '指导位于系统提示词 Strong advisor；运行时上下文中的 advisor:guidance 也会显示使用说明。配置变更从下一次模型请求生效。'),
              catalog.guidance?.text && h('div', { style: { ...css.hint, whiteSpace: 'pre-wrap' } }, catalog.guidance.text)),
            h('details', { open: true, style: { marginTop: 12, fontSize: 13 } }, h('summary', { style: { cursor: 'pointer' } }, '咨询记录与回注（' + (catalog.runs?.length ?? 0) + '）'),
              h('p', { style: css.hint }, '预算占用 ' + (catalog.budget?.used ?? 0) + ' · 活跃 ' + (catalog.budget?.active ?? 0) + ' · 排队 ' + (catalog.budget?.queued ?? 0)),
              h('button', { type: 'button', style: css.mini, disabled: !!busy, onClick: load }, '刷新状态'),
              ...(catalog.runs ?? []).slice(-10).reverse().map(run => h(AdvisorReview, { key: sessionId + ':' + run.id + ':' + run.attempt, ctx, sessionId, run })))),
            catalog && h('details', { open: true, style: { marginTop: 12, fontSize: 13 } }, h('summary', { style: { cursor: 'pointer' } }, '未完成验证（提醒，非阻断）（' + (catalog.obligations?.openCount ?? 0) + '）'),
              h(AdvisorObligations, { obligations: catalog.obligations })),
          !catalog && !error && h('p', { style: css.hint }, '正在读取当前会话设置…')))
    }

    function installWaitPickers(ctx) {
      const command = ctx.get('commandUi')
      const sessionFor = session => ctx.sessions.binding(session.sessionId)?.session
      const decorate = (name, options) => ctx.effect(() => command.decorate({
        name,
        available: session => ctx.sessions.subagentAddress(session.sessionId) === undefined,
        ui: {
          kind: 'popupSelect',
          options: () => Promise.resolve(options.map(([id, label]) => ({ id, label }))),
          onSelect: async (option, session) => {
            const live = sessionFor(session)
            if (!live) throw new Error('session is not materialized')
            const result = await live.command(`/${name} ${option.id}`)
            if (!result.ok || !result.value.matched) throw new Error(`/${name} failed`)
          },
        },
      }), `escalation-advisor: /${name} picker`)
      decorate('advisor-escalation-wait', [['inherit', 'Inherit'], ['block', 'Block main session'], ['background', 'Run in background']])
      decorate('advisor-continuous-wait', [['inherit', 'Inherit'], ['block', 'Block main session'], ['background', 'Run in background']])
    }

    return {
      name: 'dsh-escalation-advisor-client',
      inject: ['slots', 'settingsScope', 'remote', 'remote.session', 'remote.llm', 'remote.commands', 'commandUi', 'sessions', 'locale', 'uiConversation'],
      async apply(ctx) {
        const unmountRemote = await ctx.remote.$mount(advisorRemote)
        ctx.effect(() => unmountRemote, 'advisor: Remote endpoints')
        const scope = ctx.settingsScope.bind({ namespace: 'escalation-advisor' })
        ctx.inject(['remote.advisor'], advisorCtx => {
          advisorCtx.slots.inject('settings.plugin.item', () => advisorCtx.slots.register({ name: 'settings.plugin.item', key: 'escalation-advisor' }, () => h(SettingsCard, { scope, remote: advisorCtx.remote, ctx: advisorCtx })))
          advisorCtx.slots.inject('conversation.session.header.actions', () => advisorCtx.slots.register({ name: 'conversation.session.header.actions', id: 'advisor-permissions', order: 35 }, props => h(AdvisorSessionAction, { ...props, ctx: advisorCtx })))
        })
        installWaitPickers(ctx)
        installChatMessages(ctx)
      },
    }
  },
})
