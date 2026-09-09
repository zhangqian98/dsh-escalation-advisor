// Lightweight browser companion for the DSH plugin settings page.
// React and DSH client services are supplied by the host module loader.
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

    function num(value, fallback) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    function SettingsCard({ scope, remote }) {
      const snapshot = React.useSyncExternalStore(
        React.useCallback(fn => scope.subscribe(fn), [scope]),
        React.useCallback(() => scope.getSnapshot(), [scope]),
      )
      const [draft, setDraft] = React.useState(null)
      const [manualModel, setManualModel] = React.useState(false)
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [], groups: [], partial: false })
      const [notice, setNotice] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [reload, setReload] = React.useState(0)

      React.useEffect(() => {
        let live = true
        let generation = 0
        const load = async () => {
          const run = ++generation
          setCatalog(previous => ({ ...previous, status: 'loading' }))
          try {
            const [models, providers] = await Promise.all([
              remote.session.modelCatalog(),
              remote.llm.listConfigurableProviders(),
            ])
            if (!live || run !== generation) return
            if (!models.ok || !providers.ok) throw new Error('catalog unavailable')
            const routable = new Set(models.value.routableProviders)
            setCatalog({
              status: 'ready',
              providers: providers.value.filter(item => routable.has(item.provider)),
              groups: models.value.groups,
              partial: models.value.failures.length > 0,
            })
          } catch {
            if (live && run === generation) setCatalog(previous => ({ ...previous, status: 'error' }))
          }
        }
        void load()
        const off = [
          remote.$on('llm/adapters-updated', () => { void load() }),
          remote.$on('settings/document-updated', () => { void load() }),
        ]
        return () => { live = false; off.forEach(dispose => dispose()) }
      }, [remote, reload])

      const value = draft?.value ?? snapshot.value
      if (!value) return h('li', { style: css.card }, snapshot.status === 'unavailable' ? 'Escalation Advisor 设置暂不可用。' : '正在读取 Escalation Advisor 设置…')

      const edit = (field, next) => {
        setNotice('')
        setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), [field]: next } }))
      }
      const provider = catalog.providers.find(item => item.provider === value.provider)
      const models = catalog.groups.find(group => group.id === value.provider)?.models ?? []
      const knownModel = models.some(model => model.id === value.model)
      const customModel = manualModel || (!!value.model && !knownModel)
      const dirty = draft !== null && JSON.stringify(value) !== JSON.stringify(snapshot.value)
      const conflicted = draft !== null && draft.revision !== snapshot.revision
      const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving

      let validation = ''
      if (value.enabled && !value.provider.trim()) validation = '请先选择已接入 DSH 的模型服务。'
      else if (value.enabled && !value.model.trim()) validation = '请先选择或填写顾问模型。'
      else if (!Number.isInteger(value.maxManualConsultsPerSession) || value.maxManualConsultsPerSession < 0) validation = '手动咨询预算必须是非负整数。'
      else if (!Number.isInteger(value.scoreThreshold) || value.scoreThreshold < 1) validation = '自动升级阈值必须是正整数。'
      else if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 128) validation = '顾问最大输出必须至少为 128 tokens。'
      const saveDisabled = disabled || conflicted || !dirty

      const save = async () => {
        if (saveDisabled || validation) return
        setSaving(true); setNotice('')
        try {
          const desired = { ...value, provider: value.provider.trim(), model: value.model.trim() }
          await scope.mutate(Object.entries(desired).map(([field, entry]) => ({ op: 'set', path: [field], value: entry })), draft.revision)
          setDraft(null)
          setNotice('已保存。后续咨询和自动升级立即使用这套配置；不会保存新的 API key。')
        } catch {
          setNotice('保存失败。可能有另一页面刚修改过设置；请放弃修改后重新编辑。')
        } finally { setSaving(false) }
      }

      const field = (label, control, hint) => h('div', { style: { margin: '14px 0' } }, h('label', null, label, control), hint && h('p', { style: css.hint }, hint))
      const numeric = (label, key, min, max, hint) => field(label, h('input', {
        type: 'number', min, max, step: 1, style: css.control, value: value[key], disabled,
        onChange: event => edit(key, num(event.target.value, value[key])),
      }), hint)

      return h('li', { style: css.card, 'data-escalation-advisor-settings': true },
        h('h3', { style: { margin: '2px 0 8px' } }, 'DSH Escalation Advisor'),
        h('p', { style: { margin: '6px 0', lineHeight: 1.6 } }, '平时让便宜模型执行；按需、异常升级或持续审查时，让一个更强的 DSH 模型提供只读建议。'),
        h('p', { style: css.hint }, '顾问复用“模型 / Models”里已有的 provider 和认证。此插件只保存 provider/model ID 与策略，不读取或复制密钥。'),

        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 } },
          h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: event => edit('enabled', event.target.checked) }),
          '启用 Escalation Advisor'),

        field('模式', h('select', { style: css.control, value: value.mode, disabled, onChange: event => edit('mode', event.target.value) },
          h('option', { value: 'manual' }, 'manual · 仅主动咨询'),
          h('option', { value: 'escalate' }, 'escalate · 异常时自动升级（推荐）'),
          h('option', { value: 'continuous' }, 'continuous · 每轮影子审查')),
          value.mode === 'manual' ? '强模型只在主模型调用 consult_advisor 时运行。' : value.mode === 'continuous' ? '每个自然 turn 都会产生强模型审查成本。' : '根据失败轨迹打分，达到阈值才自动咨询。'),

        h('div', { style: css.row },
          field('模型服务', h('select', {
            style: css.control, value: value.provider, disabled,
            onChange: event => {
              setManualModel(false); setNotice('')
              setDraft(previous => ({ revision: previous?.revision ?? snapshot.revision, value: { ...(previous?.value ?? snapshot.value), provider: event.target.value, model: '' } }))
            },
          },
            h('option', { value: '' }, '请选择 DSH 中已有服务'),
            value.provider && !provider && h('option', { value: value.provider, disabled: true }, `${value.provider}（当前不可用）`),
            ...catalog.providers.map(item => h('option', { key: item.provider, value: item.provider }, `${item.displayName ?? item.provider} · ${item.provider}`)))),
          field('顾问模型', h('select', {
            style: css.control, value: customModel ? '__custom__' : value.model, disabled: disabled || !value.provider,
            onChange: event => { const custom = event.target.value === '__custom__'; setManualModel(custom); edit('model', custom ? '' : event.target.value) },
          },
            h('option', { value: '' }, '请选择模型'),
            ...models.map(model => h('option', { key: model.id, value: model.id }, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)),
            h('option', { value: '__custom__' }, '手动填写模型 ID…')))),
        customModel && field('模型 ID', h('input', { type: 'text', style: css.control, maxLength: 200, value: value.model, disabled, onChange: event => edit('model', event.target.value) }), '适用于 provider 可以调用、但 DSH 模型目录没有列出的模型。'),

        h('button', { type: 'button', style: css.button, disabled: catalog.status === 'loading', onClick: () => setReload(value => value + 1) }, catalog.status === 'loading' ? '正在读取模型列表…' : '刷新模型列表'),
        catalog.status === 'error' && h('p', { role: 'status', style: css.hint }, '模型列表读取失败。可刷新重试，或先到“模型 / Models”确认 provider 可用。'),
        catalog.partial && h('p', { style: css.hint }, '部分 provider 的模型目录未完整返回；仍可手动填写模型 ID。'),

        h('details', { style: { marginTop: 18 } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '成本与升级策略'),
          h('div', { style: css.row },
            numeric('手动咨询 / session', 'maxManualConsultsPerSession', 0, 100, '限制弱模型主动调用强顾问的总次数。'),
            numeric('自动升级分数阈值', 'scoreThreshold', 1, 100, '默认 4；同一错误重复两次通常会达到阈值。'),
            numeric('同一问题最多自动咨询', 'maxAutoConsultsPerProblem', 0, 10, '默认 1，避免同一失败循环持续烧强模型。'),
            numeric('自动升级冷却 turns', 'cooldownTurns', 0, 100, '刚咨询完后，至少隔多少 turn 才允许新问题再次升级。')),
          h('div', { style: css.row },
            numeric('工具错误权重', 'toolErrorWeight', 0, 20),
            numeric('重复失败权重', 'repeatedFailureWeight', 0, 20),
            numeric('非零退出权重', 'nonZeroExitWeight', 0, 20),
            numeric('重复修改权重', 'repeatedMutationWeight', 0, 20)),
          h('div', { style: css.row },
            numeric('重复修改触发次数', 'repeatedMutationCount', 2, 20),
            numeric('顾问最大输出 tokens', 'maxOutputTokens', 128, 32768)),
          field('Continuous 中断级别', h('select', { style: css.control, value: value.continuousMinSeverity, disabled, onChange: event => edit('continuousMinSeverity', event.target.value) },
            h('option', { value: 'nit' }, 'nit'), h('option', { value: 'concern' }, 'concern'), h('option', { value: 'blocker' }, 'blocker')), '达到该级别时用 steer 让主模型继续处理；更低级别可只 inject 到后续上下文。'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' } }, h('input', { type: 'checkbox', checked: value.injectNits, disabled, onChange: event => edit('injectNits', event.target.checked) }), 'Continuous：低于中断级别的建议也注入后续上下文')),

        !snapshot.writable && h('p', { role: 'status', style: css.hint }, '当前客户端连接不可写；请在允许修改设置的本机 DSH Web 界面操作。'),
        conflicted && h('p', { role: 'alert', style: css.hint }, '设置已被其他页面修改。放弃当前草稿后重新编辑，避免覆盖新值。'),
        validation && h('p', { role: 'alert', style: { ...css.hint, color: 'var(--dsw-alias-label-error, #b42318)' } }, validation),
        notice && h('p', { role: 'status', style: css.hint }, notice),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: { ...css.button, opacity: saveDisabled || validation ? 0.55 : 1 }, disabled: saveDisabled || !!validation, onClick: () => { void save() } }, saving ? '保存中…' : '保存'),
          h('button', { type: 'button', style: css.button, disabled: saving || !draft, onClick: () => { setDraft(null); setManualModel(false); setNotice('') } }, '放弃修改')))
    }

    return {
      name: 'dsh-escalation-advisor-client',
      inject: ['slots', 'settingsScope', 'remote', 'remote.session', 'remote.llm'],
      apply(ctx) {
        const scope = ctx.settingsScope.bind({ namespace: 'escalation-advisor' })
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'escalation-advisor',
        }, () => h(SettingsCard, { scope, remote: ctx.remote })))
      },
    }
  },
})
