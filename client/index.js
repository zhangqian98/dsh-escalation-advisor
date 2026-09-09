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
      headerButton: { cursor: 'pointer', padding: '4px 8px', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit' },
      panel: { position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 440, maxWidth: 'min(440px, 88vw)', maxHeight: '70vh', overflow: 'auto', zIndex: 1000, padding: 14, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 12, background: 'var(--dsw-alias-background-l1, #fff)', color: 'var(--dsw-alias-label-primary, inherit)', boxShadow: '0 12px 35px rgba(0,0,0,.18)' },
      toolRow: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 9, alignItems: 'start', padding: '9px 0', borderBottom: '1px solid var(--dsw-alias-border-l3, #eee)' },
      badge: { fontSize: 10, opacity: .72, whiteSpace: 'nowrap' },
      mini: { cursor: 'pointer', border: 0, background: 'transparent', color: 'inherit', opacity: .72, fontSize: 11, padding: 2 },
    }
    const WAIT = [['block', 'Block main session'], ['background', 'Run in background']]
    const COMMON_TOOLS = [
      ['read', 'Read files'], ['read_image', 'Read images'], ['glob', 'List matching paths'], ['grep', 'Search file contents'],
      ['web_search', 'Web search'], ['web_fetch', 'Web fetch'],
      ['edit', 'Edit files'], ['write', 'Write/replace files'], ['bash', 'Shell (bash)'], ['pwsh', 'Shell (PowerShell)'],
    ]
    const SAFE_DEFAULTS = ['read', 'read_image', 'glob', 'grep']

    function uniqueTools(items) { return [...new Set((items ?? []).map(x => String(x).trim()).filter(Boolean))] }

    function SettingsCard({ scope, remote }) {
      const snapshot = React.useSyncExternalStore(React.useCallback(fn => scope.subscribe(fn), [scope]), React.useCallback(() => scope.getSnapshot(), [scope]))
      const [draft, setDraft] = React.useState(null)
      const [manualModel, setManualModel] = React.useState(false)
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [], groups: [], partial: false })
      const [notice, setNotice] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [reload, setReload] = React.useState(0)

      React.useEffect(() => {
        let live = true, generation = 0
        const load = async () => {
          const run = ++generation
          setCatalog(previous => ({ ...previous, status: 'loading' }))
          try {
            const [models, providers] = await Promise.all([remote.session.modelCatalog(), remote.llm.listConfigurableProviders()])
            if (!live || run !== generation) return
            if (!models.ok || !providers.ok) throw new Error('catalog unavailable')
            const routable = new Set(models.value.routableProviders)
            setCatalog({ status: 'ready', providers: providers.value.filter(item => routable.has(item.provider)), groups: models.value.groups, partial: models.value.failures.length > 0 })
          } catch { if (live && run === generation) setCatalog(previous => ({ ...previous, status: 'error' })) }
        }
        void load()
        const off = [remote.$on('llm/adapters-updated', () => { void load() }), remote.$on('settings/document-updated', () => { void load() })]
        return () => { live = false; off.forEach(dispose => dispose()) }
      }, [remote, reload])

      const value = draft?.value ?? snapshot.value
      if (!value) return h('li', { style: css.card }, '正在读取 Escalation Advisor 设置…')
      const edit = (field, next) => { setNotice(''); setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), [field]: next } })) }
      const provider = catalog.providers.find(item => item.provider === value.provider)
      const models = catalog.groups.find(group => group.id === value.provider)?.models ?? []
      const knownModel = models.some(model => model.id === value.model)
      const customModel = manualModel || (!!value.model && !knownModel)
      const dirty = draft !== null && JSON.stringify(value) !== JSON.stringify(snapshot.value)
      const conflicted = draft !== null && draft.revision !== snapshot.revision
      const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving
      const saveDisabled = disabled || conflicted || !dirty || (value.enabled && (!value.provider.trim() || !value.model.trim()))
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
          await scope.mutate(Object.entries(desired).map(([field, entry]) => ({ op: 'set', path: [field], value: entry })), draft.revision)
          setDraft(null); setNotice('已保存全局默认。当前会话只有手动改过的工具会继续覆盖这些默认值。')
        } catch { setNotice('保存失败；可能有其他页面同时修改了设置。') }
        finally { setSaving(false) }
      }

      return h('li', { style: css.card, 'data-escalation-advisor-settings': true },
        h('h3', { style: { margin: '2px 0 8px' } }, 'DSH Escalation Advisor'),
        h('p', { style: { margin: '6px 0', lineHeight: 1.6 } }, 'Advisor 以可查看的 DSH 子会话运行。这里配置模型、覆盖范围、全局默认工具开关和等待策略。'),
        h('p', { style: css.hint }, '工具权限是“默认开/默认关”。当前 root 会话可在标题栏 Advisor 面板逐个覆盖；本地 subagent 只能在 root 允许范围与自身实际可见工具的交集中使用 Advisor 工具。'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 } }, h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: e => edit('enabled', e.target.checked) }), '启用 Advisor'),
        field('模式', h('select', { style: css.control, value: value.mode, disabled, onChange: e => edit('mode', e.target.value) }, h('option', { value: 'manual' }, 'manual'), h('option', { value: 'escalate' }, 'escalate（推荐）'), h('option', { value: 'continuous' }, 'continuous'))),
        h('div', { style: css.row },
          field('模型服务', h('select', { style: css.control, value: value.provider, disabled, onChange: e => { setManualModel(false); setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), provider: e.target.value, model: '' } })) } }, h('option', { value: '' }, '请选择'), value.provider && !provider && h('option', { value: value.provider, disabled: true }, value.provider), ...catalog.providers.map(item => h('option', { key: item.provider, value: item.provider }, `${item.displayName ?? item.provider} · ${item.provider}`)))),
          field('顾问模型', h('select', { style: css.control, value: customModel ? '__custom__' : value.model, disabled: disabled || !value.provider, onChange: e => { const custom = e.target.value === '__custom__'; setManualModel(custom); edit('model', custom ? '' : e.target.value) } }, h('option', { value: '' }, '请选择'), ...models.map(model => h('option', { key: model.id, value: model.id }, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)), h('option', { value: '__custom__' }, '手动填写…')))),
        customModel && field('模型 ID', h('input', { type: 'text', style: css.control, value: value.model, disabled, onChange: e => edit('model', e.target.value) })),

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
          field('其它默认开启工具', h('input', { type: 'text', style: css.control, value: extraDefaultTools.join(', '), disabled, placeholder: 'mcp__server__tool, custom_tool', onChange: e => edit('defaultEnabledTools', uniqueTools([...enabledDefaults.filter(name => commonNames.has(name)), ...e.target.value.split(/[\s,]+/)])) }), '用于 MCP 或其它插件工具的精确名称。没有显式加入这里的未知工具默认关闭。')),

        h('div', { style: css.row },
          field('主 agent 自动 escalation', h('select', { style: css.control, value: value.escalationWait, disabled, onChange: e => edit('escalationWait', e.target.value) }, ...WAIT.map(([id, label]) => h('option', { key: id, value: id }, label)))),
          field('主 agent Continuous review', h('select', { style: css.control, value: value.continuousWait, disabled, onChange: e => edit('continuousWait', e.target.value) }, ...WAIT.map(([id, label]) => h('option', { key: id, value: id }, label))))),
        h('details', { style: { marginTop: 18 } }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '成本、预算与阈值'),
          h('div', { style: css.row },
            field('手动咨询 / agent', h('input', { type: 'number', min: 0, max: 100, style: css.control, value: value.maxManualConsultsPerSession, disabled, onChange: e => edit('maxManualConsultsPerSession', Number(e.target.value)) })),
            field('Task-tree 顾问总预算', h('input', { type: 'number', min: 0, max: 1000, style: css.control, value: value.maxAdvisorConsultsPerTask, disabled, onChange: e => edit('maxAdvisorConsultsPerTask', Number(e.target.value)) })),
            field('Task-tree 最大并发', h('input', { type: 'number', min: 1, max: 32, style: css.control, value: value.maxConcurrentAdvisorRuns, disabled, onChange: e => edit('maxConcurrentAdvisorRuns', Number(e.target.value)) })),
            field('自动升级阈值', h('input', { type: 'number', min: 1, max: 100, style: css.control, value: value.scoreThreshold, disabled, onChange: e => edit('scoreThreshold', Number(e.target.value)) })),
            field('顾问最大输出 tokens', h('input', { type: 'number', min: 128, max: 32768, style: css.control, value: value.maxOutputTokens, disabled, onChange: e => edit('maxOutputTokens', Number(e.target.value)) })))),
        h('button', { type: 'button', style: css.button, disabled: catalog.status === 'loading', onClick: () => setReload(n => n + 1) }, catalog.status === 'loading' ? '正在读取模型列表…' : '刷新模型列表'),
        catalog.status === 'error' && h('p', { style: css.hint }, '模型目录读取失败；请先确认 DSH Models 可用。'),
        catalog.partial && h('p', { style: css.hint }, '部分 provider 未完整返回模型目录，可手动填写模型 ID。'),
        h('p', { style: css.hint }, '当前 root 会话标题栏的 Advisor 面板会枚举该会话实际可见的全部工具，并可逐个覆盖这里的默认开关。覆盖作为整棵本地 agent 树的权限 ceiling。'),
        conflicted && h('p', { role: 'alert', style: css.hint }, '设置已被其他页面修改，请放弃草稿后重试。'), notice && h('p', { role: 'status', style: css.hint }, notice),
        h('div', { style: { display: 'flex', gap: 10 } }, h('button', { type: 'button', style: { ...css.button, opacity: saveDisabled ? 0.55 : 1 }, disabled: saveDisabled, onClick: () => { void save() } }, saving ? '保存中…' : '保存'), h('button', { type: 'button', style: css.button, disabled: saving || !draft, onClick: () => { setDraft(null); setManualModel(false); setNotice('') } }, '放弃修改')))
    }

    async function runCommand(ctx, sessionId, line) {
      const result = await ctx.remote.commands.execute(sessionId, line, [])
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (result.value === undefined) throw new Error(`Command not available: ${line}`)
      if (result.value.result.kind !== 'success') throw new Error(result.value.result.text || `Command failed: ${line}`)
      return result.value.result.text ?? ''
    }
    function parseCatalog(text) {
      const value = JSON.parse(text)
      if (!value || !Array.isArray(value.tools)) throw new Error('Invalid Advisor tool catalog')
      return value
    }

    function AdvisorSessionAction({ ctx, sessionId }) {
      const [open, setOpen] = React.useState(false)
      const [catalog, setCatalog] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [query, setQuery] = React.useState('')
      const root = React.useRef(null)
      const isSubagent = ctx.sessions.subagentAddress(sessionId) !== undefined

      const load = React.useCallback(async () => {
        if (isSubagent) return
        setError('')
        try { setCatalog(parseCatalog(await runCommand(ctx, sessionId, '/advisor catalog'))) }
        catch (err) { setError(err instanceof Error ? err.message : String(err)) }
      }, [ctx, sessionId, isSubagent])
      React.useEffect(() => { if (open && !isSubagent) void load() }, [open, load, isSubagent])
      React.useEffect(() => {
        if (!open) return
        const close = event => { if (root.current && !root.current.contains(event.target)) setOpen(false) }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
      }, [open])

      if (isSubagent) return null
      const mutate = async (key, line) => {
        setBusy(key); setError('')
        try { setCatalog(parseCatalog(await runCommand(ctx, sessionId, line))) }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); await load() }
        finally { setBusy('') }
      }
      const tools = (catalog?.tools ?? []).filter(tool => !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
      const enabledCount = catalog?.tools?.filter(tool => tool.enabled).length ?? 0

      return h('div', { ref: root, style: css.headerRoot },
        h('button', { type: 'button', style: css.headerButton, 'aria-expanded': open, onClick: () => setOpen(v => !v) }, catalog ? `Advisor · ${enabledCount}` : 'Advisor'),
        open && h('div', { style: css.panel },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
            h('strong', null, 'Advisor 权限 · 当前 root 会话'),
            h('button', { type: 'button', style: css.mini, disabled: !!busy, onClick: () => mutate('reset', '/advisor reset').then(load) }, '全部恢复默认')),
          h('p', { style: css.hint }, '这个 allowlist 是整棵本地 agent 树的上限。subagent 还必须自己能看到对应工具，Advisor 才能使用。'),
          error && h('p', { role: 'alert', style: { ...css.hint, color: 'var(--dsw-alias-label-error, #b42318)' } }, error),
          catalog && h(React.Fragment, null,
            h('div', { style: css.row },
              h('label', null, 'Root escalation', h('select', { style: css.control, value: catalog.escalationWaitOverride ?? 'inherit', disabled: !!busy, onChange: e => mutate('wait-e', `/advisor-escalation-wait ${e.target.value}`) }, h('option', { value: 'inherit' }, `跟随默认 (${catalog.escalationWait})`), h('option', { value: 'block' }, '阻塞主会话'), h('option', { value: 'background' }, '后台运行'))),
              h('label', null, 'Root continuous', h('select', { style: css.control, value: catalog.continuousWaitOverride ?? 'inherit', disabled: !!busy, onChange: e => mutate('wait-c', `/advisor-continuous-wait ${e.target.value}`) }, h('option', { value: 'inherit' }, `跟随默认 (${catalog.continuousWait})`), h('option', { value: 'block' }, '阻塞主会话'), h('option', { value: 'background' }, '后台运行')))),
            h('input', { type: 'search', style: css.control, placeholder: `搜索 ${catalog.tools.length} 个工具…`, value: query, onChange: e => setQuery(e.target.value) }),
            h('div', { style: { marginTop: 8 } }, ...tools.map(tool => {
              const overridden = tool.override !== 'inherit'
              const status = overridden ? (tool.override === 'allow' ? '会话开启' : '会话关闭') : (tool.defaultEnabled ? '默认开启' : '默认关闭')
              return h('div', { key: tool.name, style: css.toolRow },
                h('input', { type: 'checkbox', checked: !!tool.enabled, disabled: !!busy, onChange: e => mutate(tool.name, `/advisor-tool ${tool.name} ${e.target.checked ? 'on' : 'off'}`) }),
                h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, tool.name), tool.description && h('div', { style: css.hint }, tool.description), h('span', { style: css.badge }, status)),
                overridden && h('button', { type: 'button', style: css.mini, disabled: !!busy, title: '恢复这个工具的全局默认', onClick: () => mutate(tool.name, `/advisor-tool ${tool.name} inherit`) }, '默认'))
            }))),
            tools.length === 0 && h('p', { style: css.hint }, '没有匹配的工具。')),
          !catalog && !error && h('p', { style: css.hint }, '正在读取当前会话工具…')))
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
      inject: ['slots', 'settingsScope', 'remote', 'remote.session', 'remote.llm', 'remote.commands', 'commandUi', 'sessions'],
      apply(ctx) {
        const scope = ctx.settingsScope.bind({ namespace: 'escalation-advisor' })
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: 'escalation-advisor' }, () => h(SettingsCard, { scope, remote: ctx.remote })))
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'advisor-permissions', order: 35 }, props => h(AdvisorSessionAction, { ...props, ctx })))
        installWaitPickers(ctx)
      },
    }
  },
})
