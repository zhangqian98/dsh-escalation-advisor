// Browser companion: global Advisor defaults + per-session command pickers.
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
    }
    const PRESETS = [
      ['none', 'None · no tools'],
      ['inspect', 'Inspect · read / image / glob / grep'],
      ['research', 'Research · Inspect + web search/fetch'],
      ['edit', 'Edit · Inspect + edit/write'],
      ['custom', 'Custom allowlist'],
    ]
    const WAIT = [['block', 'Block main session'], ['background', 'Run in background']]

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
      const field = (label, control, hint) => h('div', { style: { margin: '14px 0' } }, h('label', null, label, control), hint && h('p', { style: css.hint }, hint))
      const save = async () => {
        if (saveDisabled) return
        setSaving(true); setNotice('')
        try {
          const desired = { ...value, provider: value.provider.trim(), model: value.model.trim(), defaultCustomTools: Array.isArray(value.defaultCustomTools) ? value.defaultCustomTools : [] }
          await scope.mutate(Object.entries(desired).map(([field, entry]) => ({ op: 'set', path: [field], value: entry })), draft.revision)
          setDraft(null); setNotice('已保存全局默认。已有会话的 /advisor 覆盖不会被改变。')
        } catch { setNotice('保存失败；可能有其他页面同时修改了设置。') }
        finally { setSaving(false) }
      }
      const customToolsText = (value.defaultCustomTools ?? []).join(', ')

      return h('li', { style: css.card, 'data-escalation-advisor-settings': true },
        h('h3', { style: { margin: '2px 0 8px' } }, 'DSH Escalation Advisor'),
        h('p', { style: { margin: '6px 0', lineHeight: 1.6 } }, 'Advisor 以可查看的 DSH 子会话运行。这里设置新/未覆盖会话的默认模型、工具权限和等待策略。'),
        h('p', { style: css.hint }, '模型认证完全复用 “Models” 中的 DSH provider。工具权限由 child toolFilter 强制执行；不是提示词约定。'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 } }, h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: e => edit('enabled', e.target.checked) }), '启用 Advisor'),
        field('模式', h('select', { style: css.control, value: value.mode, disabled, onChange: e => edit('mode', e.target.value) }, h('option', { value: 'manual' }, 'manual'), h('option', { value: 'escalate' }, 'escalate（推荐）'), h('option', { value: 'continuous' }, 'continuous'))),
        h('div', { style: css.row },
          field('模型服务', h('select', { style: css.control, value: value.provider, disabled, onChange: e => { setManualModel(false); setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), provider: e.target.value, model: '' } })) } }, h('option', { value: '' }, '请选择'), value.provider && !provider && h('option', { value: value.provider, disabled: true }, value.provider), ...catalog.providers.map(item => h('option', { key: item.provider, value: item.provider }, `${item.displayName ?? item.provider} · ${item.provider}`)))),
          field('顾问模型', h('select', { style: css.control, value: customModel ? '__custom__' : value.model, disabled: disabled || !value.provider, onChange: e => { const custom = e.target.value === '__custom__'; setManualModel(custom); edit('model', custom ? '' : e.target.value) } }, h('option', { value: '' }, '请选择'), ...models.map(model => h('option', { key: model.id, value: model.id }, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)), h('option', { value: '__custom__' }, '手动填写…')))),
        customModel && field('模型 ID', h('input', { type: 'text', style: css.control, value: value.model, disabled, onChange: e => edit('model', e.target.value) })),
        h('div', { style: css.row },
          field('默认 Advisor 工具权限', h('select', { style: css.control, value: value.defaultToolPreset, disabled, onChange: e => edit('defaultToolPreset', e.target.value) }, ...PRESETS.map(([id, label]) => h('option', { key: id, value: id }, label))), 'Inspect 是默认；Edit 会真实修改 workspace。DSH 暂无可信的通用工具副作用元数据，因此预设使用显式白名单。'),
          field('自动 escalation', h('select', { style: css.control, value: value.escalationWait, disabled, onChange: e => edit('escalationWait', e.target.value) }, ...WAIT.map(([id, label]) => h('option', { key: id, value: id }, label)))),
          field('Continuous review', h('select', { style: css.control, value: value.continuousWait, disabled, onChange: e => edit('continuousWait', e.target.value) }, ...WAIT.map(([id, label]) => h('option', { key: id, value: id }, label))))),
        value.defaultToolPreset === 'custom' && field('默认自定义工具 allowlist', h('input', { type: 'text', style: css.control, value: customToolsText, disabled, placeholder: 'read, grep, glob, bash', onChange: e => edit('defaultCustomTools', e.target.value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean)) }), '这是精确工具名白名单。加入 bash/pwsh 等工具意味着 Advisor 可能产生副作用。'),
        h('details', { style: { marginTop: 18 } }, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '成本与阈值'),
          h('div', { style: css.row },
            field('手动咨询 / session', h('input', { type: 'number', min: 0, max: 100, style: css.control, value: value.maxManualConsultsPerSession, disabled, onChange: e => edit('maxManualConsultsPerSession', Number(e.target.value)) })),
            field('自动升级阈值', h('input', { type: 'number', min: 1, max: 100, style: css.control, value: value.scoreThreshold, disabled, onChange: e => edit('scoreThreshold', Number(e.target.value)) })),
            field('顾问最大输出 tokens', h('input', { type: 'number', min: 128, max: 32768, style: css.control, value: value.maxOutputTokens, disabled, onChange: e => edit('maxOutputTokens', Number(e.target.value)) })))),
        h('button', { type: 'button', style: css.button, disabled: catalog.status === 'loading', onClick: () => setReload(n => n + 1) }, catalog.status === 'loading' ? '正在读取模型列表…' : '刷新模型列表'),
        catalog.status === 'error' && h('p', { style: css.hint }, '模型目录读取失败；请先确认 DSH Models 可用。'),
        catalog.partial && h('p', { style: css.hint }, '部分 provider 未完整返回模型目录，可手动填写模型 ID。'),
        h('p', { style: css.hint }, '当前会话可使用 /advisor-permission、/advisor-escalation-wait、/advisor-continuous-wait 和 /advisor-tools 覆盖这些默认值。/advisor 查看当前有效策略。'),
        conflicted && h('p', { role: 'alert', style: css.hint }, '设置已被其他页面修改，请放弃草稿后重试。'), notice && h('p', { role: 'status', style: css.hint }, notice),
        h('div', { style: { display: 'flex', gap: 10 } }, h('button', { type: 'button', style: { ...css.button, opacity: saveDisabled ? 0.55 : 1 }, disabled: saveDisabled, onClick: () => { void save() } }, saving ? '保存中…' : '保存'), h('button', { type: 'button', style: css.button, disabled: saving || !draft, onClick: () => { setDraft(null); setManualModel(false); setNotice('') } }, '放弃修改')))
    }

    function installSessionPickers(ctx) {
      const command = ctx.get('commandUi')
      const sessionFor = session => ctx.sessions.binding(session.sessionId)?.session
      const decorate = (name, options) => ctx.effect(() => command.decorate({
        name,
        available: () => true,
        ui: {
          kind: 'popupSelect',
          options: () => Promise.resolve(options.map(([id, label, detail]) => ({ id, label, ...(detail ? { detail } : {}) }))),
          onSelect: async (option, session) => {
            const live = sessionFor(session)
            if (!live) throw new Error('session is not materialized')
            const result = await live.command(`/${name} ${option.id}`)
            if (!result.ok || !result.value.matched) throw new Error(`/${name} failed`)
          },
        },
      }), `escalation-advisor: /${name} picker`)
      decorate('advisor-permission', [
        ['inherit', 'Inherit global default'], ['none', 'No tools'], ['inspect', 'Inspect'], ['research', 'Research'], ['edit', 'Edit workspace'],
      ])
      decorate('advisor-escalation-wait', [['inherit', 'Inherit'], ['block', 'Block main session'], ['background', 'Run in background']])
      decorate('advisor-continuous-wait', [['inherit', 'Inherit'], ['block', 'Block main session'], ['background', 'Run in background']])
    }

    return {
      name: 'dsh-escalation-advisor-client',
      inject: ['slots', 'settingsScope', 'remote', 'remote.session', 'remote.llm', 'commandUi', 'sessions'],
      apply(ctx) {
        const scope = ctx.settingsScope.bind({ namespace: 'escalation-advisor' })
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: 'escalation-advisor' }, () => h(SettingsCard, { scope, remote: ctx.remote })))
        installSessionPickers(ctx)
      },
    }
  },
})
