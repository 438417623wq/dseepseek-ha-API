/**
 * dsh-model-bridge — browser half.
 *
 * Contributes one settings section (`settings.section`, id `model-bridge`) that
 * owns the local gateway: its on/off switch, the base URL and bearer key an
 * external tool needs, and the model roster with per-model tick boxes.
 *
 * The roster is the same idea as the harness's own model picker — models grouped
 * by provider, one row each, a tick for the current selection — adapted to a
 * settings page, where the job is choosing a set rather than choosing one. The
 * visual language (design tokens, row metrics, hover and focus treatment) is
 * taken from `@deepseek-ai/dsh-client-ui-model-selection` so the two surfaces
 * read as one product.
 *
 * Data comes from this plugin's own same-origin `/api/dsh-model-bridge/*` routes
 * rather than a typed Remote binding, because those routes are served by the same
 * host process on every kernel line this plugin targets.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-bridge',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'settings.modelBridge'
    const inject = ['slots', 'locale']
    const API = '/api/dsh-model-bridge'

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: 'Model Bridge',
        title: 'Model Bridge',
        subtitle: '把 DSH 能调用的模型，以本地 OpenAI / Anthropic 接口开放给其它开发工具',
        loading: '正在读取本地数据…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        running: '运行中',
        stopped: '已停止',
        'section.gateway': '网关',
        'section.gatewayHint': '随 DSH 一起启停；这里可以随时开关，选择会被记住。',
        'switch.label': '启用本地网关',
        'section.connect': '接入信息',
        'section.connectHint': '在其它开发工具里填这三项即可。',
        'field.openai': 'OpenAI 兼容 Base URL',
        'field.anthropic': 'Anthropic Base URL',
        'field.key': 'API Key',
        'field.keyPath': '密钥文件',
        'copy': '复制',
        'copied': '已复制',
        'reveal': '显示',
        'hide': '隐藏',
        'section.models': '暴露的模型',
        'section.modelsHint': '取消勾选后，该模型不会出现在 /v1/models 中，也无法被调用。',
        'search': '搜索模型…',
        'selectAll': '全选',
        'selectNone': '全不选',
        'copyAll': '复制全部',
        'copyModel': '复制模型名',
        'copyAllHint': '复制的是「已勾选」的模型名，每行一个，可直接粘到配置里。',
        'copyEmpty': '没有已勾选的模型',
        'selected': '已选 {n} / {total}',
        'all': '全部',
        'noModels': '当前没有可用模型。',
        'noMatch': '没有匹配的模型。',
        'saveFailed': '保存失败',
        'startFailed': '启动失败',
        'tag.vision': '视觉',
        'tag.text': '纯文本',
        'tag.thinking': '可调思考',
        'tag.context': '上下文',
        'tag.output': '最长输出',
        'group.other': '其它',
      },
      en: {
        nav: 'Model Bridge',
        title: 'Model Bridge',
        subtitle: 'Expose the models DSH can call over a local OpenAI / Anthropic API for other dev tools',
        loading: 'Reading local data…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        running: 'Running',
        stopped: 'Stopped',
        'section.gateway': 'Gateway',
        'section.gatewayHint': 'Starts and stops with DSH; the switch here works at any time and is remembered.',
        'switch.label': 'Enable the local gateway',
        'section.connect': 'Connection',
        'section.connectHint': 'Fill these three into any other development tool.',
        'field.openai': 'OpenAI-compatible Base URL',
        'field.anthropic': 'Anthropic Base URL',
        'field.key': 'API Key',
        'field.keyPath': 'Key file',
        'copy': 'Copy',
        'copied': 'Copied',
        'reveal': 'Show',
        'hide': 'Hide',
        'section.models': 'Exposed models',
        'section.modelsHint': 'An unticked model is absent from /v1/models and cannot be called.',
        'search': 'Search models…',
        'selectAll': 'Select all',
        'selectNone': 'Select none',
        'copyAll': 'Copy all',
        'copyModel': 'Copy model id',
        'copyAllHint': 'Copies the TICKED model ids, one per line, ready to paste into a config.',
        'copyEmpty': 'No model is ticked',
        'selected': '{n} / {total} selected',
        'all': 'All',
        'noModels': 'No model is currently available.',
        'noMatch': 'No model matches.',
        'saveFailed': 'Save failed',
        'startFailed': 'Start failed',
        'tag.vision': 'Vision',
        'tag.text': 'Text',
        'tag.thinking': 'Reasoning',
        'tag.context': 'Context',
        'tag.output': 'Max output',
        'group.other': 'Other',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Tokens and row metrics mirror @deepseek-ai/dsh-client-ui-model-selection.
    const CSS = `
.dmb_root{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dmb_head{display:flex;flex-direction:column;gap:4px}
.dmb_title{font-size:15px;font-weight:600;line-height:22px}
.dmb_sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dmb_section{display:flex;flex-direction:column;gap:8px}
.dmb_sectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dmb_sectionTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dmb_sectionHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dmb_card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-module-platform)}
.dmb_row{display:flex;align-items:center;gap:8px;min-height:28px}
.dmb_rowTop{align-items:flex-start}
.dmb_label{color:var(--dsw-alias-label-tertiary);flex:0 0 132px;font-size:12px;line-height:18px}
.dmb_value{flex:1;min-width:0;display:flex;align-items:center;gap:6px}
.dmb_code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm);padding:3px 6px;overflow-wrap:anywhere;user-select:all}
.dmb_codeWrap{flex:1;min-width:0}
.dmb_btn{border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);height:26px;padding:0 9px;font-size:12px;line-height:18px;cursor:pointer;flex:none;white-space:nowrap}
.dmb_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dmb_btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dmb_btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dmb_state{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:none}
.dmb_dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-dimmed)}
.dmb_dotOn{background:var(--dsw-alias-state-business-primary)}
.dmb_switch{position:relative;width:34px;height:20px;border-radius:10px;border:none;padding:0;cursor:pointer;flex:none;background:var(--dsw-alias-interactive-bg-hover);transition:background .12s}
.dmb_switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dmb_switchOn{background:var(--dsw-alias-state-business-primary)}
.dmb_switch:disabled{cursor:default;opacity:.6}
.dmb_thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .12s}
.dmb_switchOn .dmb_thumb{transform:translateX(14px)}
.dmb_toolbar{display:flex;align-items:center;gap:8px}
.dmb_search{flex:1;min-width:0;height:28px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-primary);padding:0 8px;font-size:13px;line-height:20px;outline:none}
.dmb_search:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dmb_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none;white-space:nowrap}
.dmb_list{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);max-height:min(420px,60vh);overflow-y:auto;padding:4px}
.dmb_group+.dmb_group{margin-top:3px}
.dmb_groupTitle{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;line-height:16px;padding:4px 7px 2px}
.dmb_option{box-sizing:border-box;width:100%;min-height:34px;display:flex;align-items:center;gap:8px;padding:5px 7px;border:none;background:0 0;border-radius:var(--dsw-radius-md);color:inherit;text-align:left;outline:none}
.dmb_option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmb_optionOn{background:var(--dsw-alias-interactive-bg-hover)}
.dmb_tick{flex:none;display:grid;place-items:center;width:22px;height:22px;padding:0;border:none;background:0 0;color:inherit;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.dmb_tick:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dmb_tick:disabled{cursor:default}
.dmb_box{flex:0 0 14px;width:14px;height:14px;border-radius:3px;border:1px solid var(--dsw-alias-border-l1);display:grid;place-items:center;color:#fff}
.dmb_boxOn{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.dmb_box svg{width:10px;height:10px}
.dmb_copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dmb_name{font-size:13px;font-weight:500;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.dmb_name:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
/* Selectable on purpose: the model id is the thing users copy into a config. */
.dmb_id{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text;cursor:text}
.dmb_tags{display:flex;gap:4px;flex:none;align-items:center}
.dmb_tag{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm);padding:1px 5px;white-space:nowrap}
/* The per-row copy control stays out of the way until the row is pointed at. */
.dmb_rowCopy{opacity:0;transition:opacity .1s}
.dmb_option:hover .dmb_rowCopy,.dmb_option:focus-within .dmb_rowCopy{opacity:1}
.dmb_rowCopy:focus-visible{opacity:1}
.dmb_empty{color:var(--dsw-alias-label-tertiary);padding:10px 8px;font-size:12px;line-height:18px}
.dmb_error{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);padding:8px;font-size:12px;line-height:18px;display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.dmb_ok{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    async function api(path, options) {
      // An 8s ceiling: a route that never answers must not hang the settings
      // page forever, and a hung fetch would hold a same-origin connection.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      try {
        const response = await fetch(`${API}${path}`, { ...options, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    /** Render a token count the way a model list usually does (200K, 1M). */
    function shortTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined
      if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`
      if (n >= 1000) return `${Math.round(n / 1000)}K`
      return String(n)
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
      } catch { /* fall through to the legacy path */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch { return false }
    }

    function Check({ on }) {
      return h('span', { className: on ? 'dmb_box dmb_boxOn' : 'dmb_box' },
        on ? h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: 'M3 8.5l3.2 3.2L13 5', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' })) : null)
    }

    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: checked ? 'dmb_switch dmb_switchOn' : 'dmb_switch',
        'aria-checked': checked,
        'aria-label': label,
        disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dmb_thumb' }))
    }

    /**
     * A copy control that confirms itself.
     *
     * The confirmation is local to the button, so several copies on screen can be
     * pending at once without a shared "which one just fired" flag. The timer is
     * cleared on unmount so a copy followed by closing the section cannot set
     * state on a gone component.
     */
    function CopyButton({ value, label, doneLabel, className = 'dmb_btn', title, disabled = false }) {
      const [done, setDone] = useState(false)
      const timer = useRef(undefined)
      useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
      return h('button', {
        type: 'button',
        className,
        title: title ?? label,
        'aria-label': title ?? label,
        disabled,
        onClick: async event => {
          // The row itself toggles on click; copying must not also untick it.
          event.stopPropagation()
          if (await copyText(value)) {
            setDone(true)
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => setDone(false), 1400)
          }
        },
      }, done ? doneLabel : label)
    }

    function Field({ label, value, t, mono = true }) {
      const [shown, setShown] = useState(false)
      const secret = label === t('field.key')
      const text = secret && !shown ? `${'•'.repeat(24)}${String(value).slice(-6)}` : String(value)
      return h('div', { className: 'dmb_row' },
        h('span', { className: 'dmb_label' }, label),
        h('span', { className: 'dmb_value' },
          h('span', { className: mono ? 'dmb_code dmb_codeWrap' : 'dmb_codeWrap' }, h('code', { className: mono ? 'dmb_code' : '' }, text)),
          secret ? h('button', { type: 'button', className: 'dmb_btn', onClick: () => setShown(v => !v) }, shown ? t('hide') : t('reveal')) : null,
          h(CopyButton, { value: String(value), label: t('copy'), doneLabel: t('copied') })))
    }

    // ── the page ──────────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const t = props.t
      const [state, setState] = useState({ status: 'loading' })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [allowed, setAllowed] = useState(null)
      const [enabled, setEnabled] = useState(true)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const data = await api('/state')
          if (!alive.current) return
          setState({ status: 'ready', data })
          setAllowed(data.allowed ?? null)
          setEnabled(data.enabled !== false)
          setError(data.startError ? `${t('startFailed')}: ${data.startError}` : '')
        } catch (err) {
          if (!alive.current) return
          setState({ status: 'error', error: String(err?.message ?? err) })
        }
      }, [t])

      useEffect(() => {
        alive.current = true
        load()
        return () => { alive.current = false }
      }, [load])

      // Apply a settings change. The selection is applied immediately rather
      // than behind a Save button: the gateway's answer is the confirmation, and
      // an unsaved checkbox would misrepresent what is actually exposed.
      const apply = useCallback(async patch => {
        setBusy(true)
        setError('')
        try {
          const result = await post('/settings', patch)
          if (!alive.current) return
          setEnabled(result.enabled !== false)
          setAllowed(result.allowed ?? null)
          setState(prev => prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, running: result.running, enabled: result.enabled } } : prev)
        } catch (err) {
          if (!alive.current) return
          setError(`${t('saveFailed')}: ${String(err?.message ?? err)}`)
          load()
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [load, t])

      const models = state.status === 'ready' ? state.data.models ?? [] : []
      const selected = useMemo(() => {
        if (allowed === null) return new Set(models.map(m => m.id))
        return new Set(allowed)
      }, [allowed, models])

      const groups = useMemo(() => {
        const q = query.trim().toLowerCase()
        const visible = q === ''
          ? models
          : models.filter(m => `${m.name} ${m.id} ${m.provider} ${m.providerName ?? ''} ${m.description ?? ''}`.toLowerCase().includes(q))
        const byProvider = new Map()
        for (const m of visible) {
          const key = m.provider
          if (!byProvider.has(key)) byProvider.set(key, { provider: key, name: m.providerName ?? m.provider, rows: [] })
          byProvider.get(key).rows.push(m)
        }
        return [...byProvider.values()]
      }, [models, query])

      const toggleModel = id => {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        // An empty selection is meaningful (expose nothing), so it is sent as an
        // array rather than collapsed to `null`.
        apply({ allowed: [...next] })
      }

      if (state.status === 'loading') {
        return h('div', { className: 'dmb_root' }, h('div', { className: 'dmb_empty' }, t('loading')))
      }
      if (state.status === 'error') {
        return h('div', { className: 'dmb_root' },
          h('div', { className: 'dmb_error' },
            h('span', null, `${t('loadFailed')}: ${state.error}`),
            h('button', { type: 'button', className: 'dmb_btn', onClick: load }, t('retry'))))
      }

      const data = state.data
      const total = models.length
      const chosen = selected.size
      const allSelected = total > 0 && chosen === total
      // What the gateway actually advertises, in catalog order — the same set the
      // roster ticks, so "copy all" can never paste a model that is not exposed.
      const exposedIds = models.filter(m => selected.has(m.id)).map(m => m.id)

      const renderRow = m => {
        const on = selected.has(m.id)
        const window_ = shortTokens(m.contextWindow)
        const out = shortTokens(m.maxTokens)
        const vision = Array.isArray(m.inputModalities) && m.inputModalities.includes('image')
        // The row is a div, not a button: a button makes its own text
        // unselectable, and it cannot legally contain the per-row copy button.
        // The tick is its own control, so clicking the row body is still the
        // cheap way to toggle while the text stays selectable.
        return h('div', {
          key: m.id,
          className: on ? 'dmb_option dmb_optionOn' : 'dmb_option',
          title: m.description ?? m.id,
        },
          h('button', {
            type: 'button',
            className: 'dmb_tick',
            role: 'checkbox',
            'aria-checked': on,
            'aria-label': m.id,
            disabled: busy,
            onClick: () => toggleModel(m.id),
          }, h(Check, { on })),
          // Only the display name toggles on click. The id below it is left as
          // plain selectable text, because a click handler there would fight
          // drag-to-select — and selecting the id is the point.
          h('span', { className: 'dmb_copy' },
            h('span', {
              className: 'dmb_name',
              onClick: () => { if (!busy) toggleModel(m.id) },
            }, m.name ?? m.model),
            h('span', { className: 'dmb_id', title: m.id }, m.id)),
          h('span', { className: 'dmb_tags' },
            vision ? h('span', { className: 'dmb_tag' }, t('tag.vision')) : null,
            m.reasoning === true ? h('span', { className: 'dmb_tag' }, t('tag.thinking')) : null,
            window_ !== undefined ? h('span', { className: 'dmb_tag' }, `${t('tag.context')} ${window_}`) : null,
            out !== undefined ? h('span', { className: 'dmb_tag' }, `${t('tag.output')} ${out}`) : null),
          h(CopyButton, { value: m.id, label: t('copy'), doneLabel: t('copied'), className: 'dmb_btn dmb_rowCopy', title: t('copyModel') }))
      }

      const list = total === 0
        ? h('div', { className: 'dmb_empty' }, t('noModels'))
        : groups.length === 0
          ? h('div', { className: 'dmb_empty' }, t('noMatch'))
          : groups.map(group => h('div', { className: 'dmb_group', key: group.provider },
              h('div', { className: 'dmb_groupTitle' }, group.name),
              group.rows.map(renderRow)))

      return h('div', { className: 'dmb_root' },
        h('div', { className: 'dmb_head' },
          h('div', { className: 'dmb_title' }, t('title')),
          h('div', { className: 'dmb_sub' }, t('subtitle'))),

        error !== '' ? h('div', { className: 'dmb_error' },
          h('span', null, error),
          h('button', { type: 'button', className: 'dmb_btn', onClick: load }, t('retry'))) : null,

        // ── gateway switch ───────────────────────────────────────────────────
        h('div', { className: 'dmb_section' },
          h('div', { className: 'dmb_sectionHead' },
            h('span', { className: 'dmb_sectionTitle' }, t('section.gateway')),
            h('span', { className: 'dmb_state' },
              h('span', { className: data.running ? 'dmb_dot dmb_dotOn' : 'dmb_dot' }),
              data.running ? t('running') : t('stopped'))),
          h('div', { className: 'dmb_card' },
            h('div', { className: 'dmb_row' },
              h('span', { className: 'dmb_value' }, t('switch.label')),
              h(Switch, { checked: enabled, disabled: busy, label: t('switch.label'), onChange: v => apply({ enabled: v }) })),
            h('div', { className: 'dmb_sectionHint' }, t('section.gatewayHint')))),

        // ── connection details ───────────────────────────────────────────────
        h('div', { className: 'dmb_section' },
          h('span', { className: 'dmb_sectionTitle' }, t('section.connect')),
          h('div', { className: 'dmb_card' },
            h(Field, { label: t('field.openai'), value: data.openaiBaseUrl, t }),
            h(Field, { label: t('field.anthropic'), value: data.anthropicBaseUrl, t }),
            h(Field, { label: t('field.key'), value: data.key, t }),
            h('div', { className: 'dmb_sectionHint' }, t('section.connectHint')))),

        // ── model roster ─────────────────────────────────────────────────────
        h('div', { className: 'dmb_section' },
          h('div', { className: 'dmb_sectionHead' },
            h('span', { className: 'dmb_sectionTitle' }, t('section.models')),
            h('span', { className: 'dmb_count' }, allowed === null
              ? t('all')
              : t('selected').replace('{n}', String(chosen)).replace('{total}', String(total)))),
          h('div', { className: 'dmb_toolbar' },
            h('input', {
              className: 'dmb_search',
              type: 'search',
              value: query,
              placeholder: t('search'),
              'aria-label': t('search'),
              onChange: e => setQuery(e.target.value),
            }),
            h('button', { type: 'button', className: 'dmb_btn', disabled: busy || allSelected, onClick: () => apply({ allowed: null }) }, t('selectAll')),
            h('button', { type: 'button', className: 'dmb_btn', disabled: busy || chosen === 0, onClick: () => apply({ allowed: [] }) }, t('selectNone')),
            // Copies what is actually exposed, so the pasted list matches the
            // gateway rather than the whole catalog.
            h(CopyButton, {
              value: exposedIds.join('\n'),
              label: t('copyAll'),
              doneLabel: t('copied'),
              className: 'dmb_btn',
              title: exposedIds.length === 0 ? t('copyEmpty') : t('copyAll'),
              disabled: exposedIds.length === 0,
            })),
          h('div', { className: 'dmb_list' }, list),
          h('div', { className: 'dmb_sectionHint' }, t('section.modelsHint')),
          h('div', { className: 'dmb_sectionHint' }, t('copyAllHint'))),
      )
    }

    // ── registration ──────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'model-bridge: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-bridge: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-bridge',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'model-bridge'

    return module.exports
  },
})
