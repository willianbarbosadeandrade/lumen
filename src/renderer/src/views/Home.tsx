import { useEffect, useState } from 'react'
import {
  speakerName,
  PROVIDERS,
  SHORTCUTS,
  type ProviderId,
  type ShortcutName,
  type ShortcutStatus,
  type FinalizeStatus,
  type KeyStatus,
  type Mode,
  type PermissionsStatus,
  type Session,
  type SessionMeta,
  type Settings
} from '@shared/types'
import { Icon } from '@/components/Icon'
import { Markdown } from '@/components/Markdown'
import { useAsk } from '@/lib/useAsk'
import { isMac, isWindows, kbd } from '@/lib/platform'

type Route = 'home' | 'history' | 'modes' | 'settings'

const NAV: { id: Route; label: string; icon: string }[] = [
  { id: 'home', label: 'Início', icon: 'home' },
  { id: 'history', label: 'Histórico', icon: 'history' },
  { id: 'modes', label: 'Modos', icon: 'layers' },
  { id: 'settings', label: 'Configurações', icon: 'gear' }
]

/** Converte uma tecla pressionada no formato de atalho do Electron. */
function toAccelerator(e: KeyboardEvent): string | null {
  const codeMap: Record<string, string> = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Tab: 'Tab'
  }
  let key: string | undefined
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code
  else key = codeMap[e.code]
  if (!key) return null
  const mods: string[] = []
  if (isMac) {
    if (e.metaKey) mods.push('CommandOrControl')
    if (e.ctrlKey) mods.push('Control')
  } else if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (!mods.length && !/^F\d/.test(key)) return null // exige ao menos um modificador
  return [...mods, key].join('+')
}

function useShortcutStatus() {
  const [status, setStatus] = useState<ShortcutStatus[]>([])
  useEffect(() => {
    void window.lumen.shortcuts.status().then(setStatus)
    return window.lumen.shortcuts.onChange(setStatus)
  }, [])
  return [status, setStatus] as const
}

const fmtDate = (t: number) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
const fmtDuration = (a: number, b?: number) => {
  if (!b) return 'em andamento'
  const min = Math.max(1, Math.round((b - a) / 60000))
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

export function Home({ initial }: { initial: string }) {
  const [route, setRoute] = useState<Route>((NAV.find((n) => n.id === initial)?.id ?? 'home') as Route)
  useEffect(() => window.lumen.app.onNav((r) => NAV.some((n) => n.id === r) && setRoute(r as Route)), [])

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="titlebar-space" />
        <div className="brand">
          <span className="logo-dot big" /> Lumen
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${route === n.id ? 'active' : ''}`} onClick={() => setRoute(n.id)}>
            <Icon name={n.icon} size={16} />
            {n.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="nav-item" onClick={() => window.lumen.app.openOnboarding()}>
          <Icon name="shield" size={16} /> Permissões
        </button>
      </nav>
      <main className="content">
        <div className="titlebar-space drag" />
        {route === 'home' && <HomePage go={setRoute} />}
        {route === 'history' && <HistoryPage />}
        {route === 'modes' && <ModesPage />}
        {route === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

// ---------------- Início ----------------
function HomePage({ go }: { go: (r: Route) => void }) {
  const [perms, setPerms] = useState<PermissionsStatus | null>(null)
  const [keys, setKeys] = useState<KeyStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [recent, setRecent] = useState<SessionMeta[]>([])
  const [shortcuts] = useShortcutStatus()
  const toggleAccel = shortcuts.find((x) => x.name === 'toggle-bar')?.accel ?? SHORTCUTS['toggle-bar'].accel

  useEffect(() => {
    // Atualiza o status continuamente: as permissões mudam fora do app (Ajustes do Sistema).
    const refresh = () => {
      void window.lumen.perms.status().then(setPerms)
      void window.lumen.keys.status().then(setKeys)
      void window.lumen.settings.get().then(setSettings)
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    window.addEventListener('focus', refresh)
    const load = () => void window.lumen.sessions.list().then((l) => setRecent(l.slice(0, 4)))
    load()
    const off = window.lumen.sessions.onChange(load)
    return () => {
      off()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const checks = [
    { ok: !!(keys && settings && (settings.provider === 'ollama' || keys.anthropic || keys.openai || keys.gemini || keys.groq)), label: 'Provedor de IA', fix: () => go('settings') },
    { ok: !!(settings && keys?.[settings.transcriptionProvider]), label: 'Transcrição de áudio', fix: () => go('settings') },
    { ok: perms?.microphone === 'granted', label: 'Microfone', fix: () => window.lumen.app.openOnboarding() },
    { ok: perms?.screen === 'granted', label: 'Tela e áudio do sistema', fix: () => window.lumen.app.openOnboarding() },
    { ok: perms?.accessibility === 'granted', label: 'Acessibilidade (opcional)', fix: () => window.lumen.app.openOnboarding() }
  ]

  return (
    <div className="page">
      <header className="hero">
        <div>
          <h1>Pronto quando você estiver.</h1>
          <p className="muted">
            A barra do Lumen fica sobre qualquer app. Use <kbd>{kbd(toggleAccel)}</kbd> para mostrar ou esconder.
          </p>
        </div>
        <button className="primary" onClick={() => void window.lumen.bar.focus()}>
          Mostrar a barra
        </button>
      </header>

      <div className="grid-2">
        <section className="card">
          <h3>Atalhos</h3>
          <ul className="shortcuts">
            {shortcuts.map((sc) => (
              <li key={sc.name}>
                <span>
                  {sc.label}
                  {sc.fallback && <small className="muted"> · padrão em uso por outro app</small>}
                </span>
                {sc.ok && sc.accel ? <kbd>{kbd(sc.accel)}</kbd> : <em className="bad-tag">indisponível</em>}
              </li>
            ))}
          </ul>
          {shortcuts.some((x) => !x.ok || x.fallback) && (
            <button className="ghost xs" style={{ marginTop: 12 }} onClick={() => go('settings')}>
              Ajustar atalhos
            </button>
          )}
        </section>
        <section className="card">
          <h3>Status</h3>
          {perms && perms.screen !== 'granted' && (
            <p className="muted small">
              Já ligou o Lumen em “Gravação de Tela e Áudio do Sistema”? O macOS só libera depois de reabrir o app.{' '}
              <button className="ghost xs" onClick={() => void window.lumen.app.relaunch()}>
                Reabrir o Lumen
              </button>
            </p>
          )}
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.label} className={c.ok ? 'ok' : ''}>
                <span className="check-dot">{c.ok ? <Icon name="check" size={12} /> : null}</span>
                <span>{c.label}</span>
                {!c.ok && (
                  <button className="ghost xs" onClick={c.fix}>
                    Resolver
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Sessões recentes</h3>
          <button className="ghost xs" onClick={() => go('history')}>
            Ver todas
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="muted">Nenhuma sessão ainda. Clique em “Ouvir” na barra para começar uma.</p>
        ) : (
          <ul className="session-list compact">
            {recent.map((s) => (
              <li key={s.id} onClick={() => go('history')}>
                <strong>{s.title}</strong>
                <small>
                  {fmtDate(s.startedAt)} · {fmtDuration(s.startedAt, s.endedAt)} · {s.lines} falas
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ---------------- Histórico ----------------
/** Situação da revisão da transcrição (feita a partir do áudio completo). */
function ReviewNotice({ session, status }: { session: Session; status?: FinalizeStatus }) {
  if (!session.audio?.length) return null
  const retry = (
    <button className="ghost xs" onClick={() => void window.lumen.sessions.refinalize(session.id)}>
      Tentar de novo
    </button>
  )
  if (status?.state === 'running')
    return <div className="notice-line">Revisando a transcrição a partir do áudio ({status.done}/{status.total})… Pode continuar usando o Lumen.</div>
  if (session.finalState === 'failed' || (!session.finalized && status?.state === 'failed'))
    return (
      <div className="notice-line warn">
        A revisão não foi concluída ({session.finalError ?? status?.error ?? 'erro desconhecido'}). A transcrição ao vivo está salva. {retry}
      </div>
    )
  if (session.finalState === 'partial')
    return (
      <div className="notice-line">
        Alguns trechos não puderam ser revisados e ficaram com a transcrição ao vivo ({session.finalError}). {retry}
      </div>
    )
  if (!session.finalized)
    return (
      <div className="notice-line">
        Esta transcrição é a versão ao vivo; dá para revisá-la a partir do áudio completo (mais fiel, com quem falou).{' '}
        <button className="primary xs" onClick={() => void window.lumen.sessions.refinalize(session.id)}>
          Revisar agora
        </button>
      </div>
    )
  return null
}

function HistoryPage() {
  const [list, setList] = useState<SessionMeta[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'summary' | 'answers' | 'transcript'>('summary')
  const [review, setReview] = useState<Record<string, FinalizeStatus>>({})
  const summary = useAsk()

  // Andamento da revisão da transcrição (roda em segundo plano no processo principal).
  useEffect(() => {
    void window.lumen.sessions.finalizeStatus().then((l) => setReview(Object.fromEntries(l.map((x) => [x.sessionId, x]))))
    return window.lumen.sessions.onFinalize((p) => setReview((r) => ({ ...r, [p.sessionId]: p })))
  }, [])

  useEffect(() => {
    const load = () =>
      void window.lumen.sessions.list().then((l) => {
        setList(l)
        setSelected((cur) => cur ?? l[0]?.id ?? null)
      })
    load()
    return window.lumen.sessions.onChange(load)
  }, [])

  useEffect(() => {
    summary.reset()
    if (selected) void window.lumen.sessions.get(selected).then((s) => setSession(s ?? null))
    else setSession(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, list])

  const filtered = list.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
  const speakers = [...new Set((session?.transcript ?? []).map((l) => l.label).filter((x): x is string => !!x))]
  const summaryText = summary.state.text || session?.summary

  return (
    <div className="page split">
      <div className="list-pane">
        <input className="search" placeholder="Buscar sessões…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ul className="session-list">
          {filtered.map((s) => (
            <li key={s.id} className={s.id === selected ? 'active' : ''} onClick={() => setSelected(s.id)}>
              <strong>{s.title}</strong>
              <small>
                {fmtDate(s.startedAt)} · {fmtDuration(s.startedAt, s.endedAt)}
              </small>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted empty">Nada por aqui.</li>}
        </ul>
      </div>

      <div className="detail-pane">
        {!session ? (
          <p className="muted">Selecione uma sessão.</p>
        ) : (
          <>
            <div className="detail-head">
              <input
                className="title-input"
                defaultValue={session.title}
                key={session.id}
                onBlur={(e) => void window.lumen.sessions.rename(session.id, e.target.value)}
              />
              <div className="row">
                {!!session.audio?.length && (
                  <button
                    className="ghost sm"
                    disabled={review[session.id]?.state === 'running'}
                    title="Transcreve de novo todo o áudio gravado, do zero, com o modelo mais preciso"
                    onClick={() => {
                      if (confirm('Refazer a transcrição inteira a partir do áudio? Os nomes dados a quem falou podem mudar.'))
                        void window.lumen.sessions.refinalize(session.id, true)
                    }}
                  >
                    <Icon name="refresh" size={14} /> Refazer transcrição
                  </button>
                )}
                <button className="ghost sm" onClick={() => void window.lumen.sessions.exportMd(session.id)}>
                  <Icon name="download" size={14} /> Exportar .md
                </button>
                <button
                  className="ghost sm danger"
                  onClick={() => {
                    if (confirm('Excluir esta sessão? Não dá para desfazer.')) {
                      void window.lumen.sessions.remove(session.id)
                      setSelected(null)
                    }
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
            <p className="muted small">
              {fmtDate(session.startedAt)} · {fmtDuration(session.startedAt, session.endedAt)} · {session.transcript.length} falas ·{' '}
              {session.messages.filter((m) => m.role === 'assistant').length} respostas
              {session.finalized ? (session.finalEngine === 'gemini' ? ' · revisada pelo Gemini, com identificação de quem fala' : ' · revisada do áudio completo') : ''}
            </p>
            <ReviewNotice session={session} status={review[session.id]} />

            <div className="tabs">
              {(['summary', 'answers', 'transcript'] as const).map((t) => (
                <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                  {{ summary: 'Resumo', answers: 'Respostas', transcript: 'Transcrição' }[t]}
                </button>
              ))}
            </div>

            {tab === 'summary' && (
              <div className="card">
                {summaryText ? (
                  <Markdown text={summaryText} />
                ) : (
                  <p className="muted">Ainda não há resumo desta sessão.</p>
                )}
                {summary.state.notice && <p className="muted small">{summary.state.notice}</p>}
                {summary.state.status === 'error' && <div className="error">{summary.state.error}</div>}
                <button
                  className="primary sm"
                  disabled={summary.state.status === 'thinking' || summary.state.status === 'streaming' || session.transcript.length === 0}
                  onClick={() => summary.ask({ kind: 'summary', sessionId: session.id })}
                >
                  {summaryText ? 'Gerar de novo' : 'Gerar resumo e próximos passos'}
                </button>
              </div>
            )}

            {tab === 'answers' && (
              <div className="thread">
                {session.messages.length === 0 && <p className="muted">Nenhuma pergunta feita nesta sessão.</p>}
                {session.messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="bubble user">
                      {m.content}
                      {m.withScreen && <span className="tag">com tela</span>}
                    </div>
                  ) : (
                    <div key={m.id} className="bubble ai">
                      <Markdown text={m.content} />
                    </div>
                  )
                )}
              </div>
            )}

            {tab === 'transcript' && (
              <div className="transcript big">
                {session.transcript.length === 0 && <p className="muted">Sem transcrição.</p>}
                {speakers.length > 0 && (
                  <div className="speakers">
                    <span className="muted small">Quem falou (clique para dar nome):</span>
                    {speakers.map((label) => (
                      <input
                        key={`${session.id}-${label}`}
                        className="speaker-name"
                        defaultValue={session.speakerNames?.[label] ?? ''}
                        placeholder={label}
                        onBlur={(e) => void window.lumen.sessions.renameSpeaker(session.id, label, e.target.value)}
                      />
                    ))}
                  </div>
                )}
                {session.transcript.map((l) => (
                  <div key={l.id} className={`line ${l.speaker} ${l.label ? 'labeled s' + (speakers.indexOf(l.label) % 4) : ''}`}>
                    <span className="who">{speakerName(l, session.speakerNames)}</span>
                    <span className="time">{new Date(l.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                    <span>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------- Modos ----------------
const EMPTY_MODE: Mode = { id: '', name: 'Novo modo', icon: '●', prompt: '', docs: [] }

function ModesPage() {
  const [modes, setModes] = useState<Mode[]>([])
  const [editing, setEditing] = useState<Mode | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.lumen.modes.list().then((m) => {
      setModes(m)
      setEditing((e) => e ?? m[0])
    })
    return window.lumen.modes.onChange((m) => {
      setModes(m)
      setEditing((e) => (e ? m.find((x) => x.id === e.id) ?? e : m[0]))
    })
  }, [])

  const save = async () => {
    if (!editing) return
    const next = await window.lumen.modes.save(editing)
    setModes(next)
    const savedMode = editing.id ? next.find((m) => m.id === editing.id) : next.at(-1)
    if (savedMode) setEditing(savedMode)
    setSaved(true)
    setTimeout(() => setSaved(false), 1400)
  }

  return (
    <div className="page split">
      <div className="list-pane">
        <ul className="session-list">
          {modes.map((m) => (
            <li key={m.id} className={editing?.id === m.id ? 'active' : ''} onClick={() => setEditing(m)}>
              <strong>
                <span className="mode-icon">{m.icon}</span> {m.name}
              </strong>
              <small>{m.builtIn ? 'Padrão' : 'Personalizado'} · {m.docs.length} doc(s)</small>
            </li>
          ))}
        </ul>
        <button className="ghost sm" onClick={() => setEditing({ ...EMPTY_MODE })}>
          <Icon name="plus" size={14} /> Novo modo
        </button>
      </div>

      <div className="detail-pane">
        {editing && (
          <div className="form">
            <div className="row">
              <label className="narrow">
                <span>Ícone</span>
                <input value={editing.icon} maxLength={2} onChange={(e) => setEditing({ ...editing, icon: e.target.value })} />
              </label>
              <label className="grow">
                <span>Nome</span>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
            </div>
            <label>
              <span>Instruções para a IA</span>
              <textarea
                rows={8}
                value={editing.prompt}
                placeholder="Ex.: Você me ajuda em entrevistas com clientes do setor de saúde. Foque em…"
                onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              />
            </label>

            <div className="field">
              <span className="label">Documentos de contexto</span>
              <p className="muted small">PDF, TXT, MD, CSV ou JSON. O texto entra no contexto de toda resposta deste modo (currículo, roteiro, FAQ, proposta…).</p>
              <ul className="docs">
                {editing.docs.map((d) => (
                  <li key={d.id}>
                    <span>{d.name}</span>
                    <small>{(d.chars / 1000).toFixed(1)} mil caracteres</small>
                    <button className="ghost xs" onClick={() => setEditing({ ...editing, docs: editing.docs.filter((x) => x.id !== d.id) })}>
                      Remover
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="ghost sm"
                disabled={!editing.id}
                title={editing.id ? '' : 'Salve o modo antes de anexar documentos'}
                onClick={() => void window.lumen.modes.addDocs(editing.id)}
              >
                <Icon name="plus" size={14} /> Adicionar documentos
              </button>
            </div>

            <div className="row">
              <button className="primary" onClick={() => void save()}>
                {saved ? 'Salvo' : 'Salvar modo'}
              </button>
              {editing.id && (
                <button
                  className="ghost danger"
                  onClick={async () => {
                    const next = await window.lumen.modes.remove(editing.id)
                    setModes(next)
                    setEditing(next.find((m) => m.id === editing.id) ?? next[0])
                  }}
                >
                  {editing.builtIn ? 'Restaurar original' : 'Excluir'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------- Configurações ----------------
function KeyField({ name, label, saved }: { name: keyof KeyStatus; label: string; saved: boolean }) {
  const [value, setValue] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null)
  return (
    <div className="key-field">
      <span className="label">
        {label} {saved && <em className="ok-tag">salva</em>}
      </span>
      <div className="row">
        <input type="password" placeholder={saved ? '•••••••• (cole para trocar)' : 'Cole a chave'} value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          className="ghost sm"
          disabled={!value}
          onClick={async () => {
            await window.lumen.keys.set(name, value)
            setValue('')
            setMsg(await window.lumen.keys.test(name))
          }}
        >
          Salvar
        </button>
        {saved && (
          <>
            <button className="ghost sm" onClick={async () => setMsg(await window.lumen.keys.test(name))}>
              Testar
            </button>
            <button className="ghost sm danger" onClick={async () => (await window.lumen.keys.set(name, ''), setMsg(null))}>
              Remover
            </button>
          </>
        )}
      </div>
      {msg && <small className={msg.ok ? 'ok-text' : 'error-text'}>{msg.message}</small>}
    </div>
  )
}

function ModelField({ label, value, options, onSave }: { label: string; value: string; options: string[]; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const id = `dl-${label.replace(/\W/g, '')}`
  return (
    <label className="grow">
      <span>{label}</span>
      <input value={v} list={id} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && onSave(v.trim())} />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </label>
  )
}

function TestButton({ provider }: { provider: ProviderId }) {
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null)
  return (
    <div className="row">
      <button className="ghost sm" onClick={async () => setMsg(await window.lumen.keys.test(provider))}>
        Testar conexão
      </button>
      {msg && <small className={msg.ok ? 'ok-text' : 'error-text'}>{msg.message}</small>}
    </div>
  )
}

function ShortcutRow({ sc }: { sc: ShortcutStatus }) {
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    if (!recording) return
    void window.lumen.shortcuts.pause()
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const accel = toAccelerator(e)
      if (!accel) {
        setHint(isMac ? 'Use pelo menos uma tecla modificadora (⌘ ⌃ ⌥ ⇧) + uma tecla.' : 'Use pelo menos uma tecla modificadora (Ctrl, Alt, Shift) + uma tecla.')
        return
      }
      setRecording(false)
      const res = await window.lumen.shortcuts.set(sc.name as ShortcutName, accel)
      const mine = res.find((x) => x.name === sc.name)
      setHint(mine?.ok ? '' : `${kbd(accel)} está em uso por outro app. Tente outra combinação.`)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      void window.lumen.shortcuts.resume()
    }
  }, [recording, sc.name])

  return (
    <li className="shortcut-row">
      <span className="grow">
        {sc.label}
        {hint && <small className="error-text block">{hint}</small>}
        {!hint && sc.fallback && <small className="muted block">O padrão estava em uso; usando uma alternativa.</small>}
      </span>
      <button className={`kbd-btn ${recording ? 'recording' : ''} ${sc.ok ? '' : 'bad'}`} onClick={() => (setHint(''), setRecording(!recording))}>
        {recording ? 'Pressione as teclas…' : sc.ok && sc.accel ? kbd(sc.accel) : 'Definir'}
      </button>
      {sc.custom && (
        <button className="ghost xs" onClick={() => void window.lumen.shortcuts.set(sc.name as ShortcutName, null)}>
          Padrão
        </button>
      )}
    </li>
  )
}

function ShortcutsCard() {
  const [status] = useShortcutStatus()
  return (
    <section className="card">
      <h3>Atalhos</h3>
      <p className="muted small">Clique num atalho e pressione a nova combinação (Esc cancela). Se outro app já usar a combinação, o Lumen avisa.</p>
      <ul className="shortcut-list">
        {status.map((sc) => (
          <ShortcutRow key={sc.name} sc={sc} />
        ))}
      </ul>
    </section>
  )
}

type OllamaInfo = { name: string; sizeGB: number; params?: string; vision: boolean; thinking: boolean }

/** Recomenda: primeiro um modelo que lê a tela; senão o maior modelo de texto (mais inteligente). */
function recommendOllama(models: OllamaInfo[]): OllamaInfo | undefined {
  const vision = models.filter((m) => m.vision).sort((a, b) => b.sizeGB - a.sizeGB)[0]
  return vision ?? [...models].sort((a, b) => b.sizeGB - a.sizeGB)[0]
}

function OllamaSection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<void> }) {
  const [state, setState] = useState<{ loading: boolean; ok: boolean; models: OllamaInfo[] }>({ loading: true, ok: false, models: [] })
  const load = async () => {
    setState((x) => ({ ...x, loading: true }))
    const r = await window.lumen.ollama.models()
    setState({ loading: false, ...r })
    // Se o modelo salvo não está instalado, escolhe o recomendado entre os instalados.
    const installed = r.models.some((m) => m.name === settings.ollamaModel || m.name === `${settings.ollamaModel}:latest`)
    const rec = recommendOllama(r.models)
    if (r.ok && !installed && rec) void patch({ ollamaModel: rec.name })
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ollamaUrl])

  const rec = recommendOllama(state.models)
  const current = state.models.find((m) => m.name === settings.ollamaModel || m.name === `${settings.ollamaModel}:latest`)

  return (
    <>
      <p className="muted small">Roda no seu Mac, sem internet e sem custo. Deixe o app Ollama aberto.</p>
      {state.loading ? (
        <p className="muted small">Procurando modelos instalados…</p>
      ) : !state.ok ? (
        <div className="notice-line">
          Não consegui falar com o Ollama em {settings.ollamaUrl}. Abra o app Ollama e clique em atualizar.
          <button className="ghost xs" onClick={() => void load()}>Atualizar</button>
        </div>
      ) : state.models.length === 0 ? (
        <div className="notice-line">
          Nenhum modelo instalado. No Terminal, rode <code>ollama pull gemma3:4b</code>.
          <button className="ghost xs" onClick={() => void load()}>Atualizar</button>
        </div>
      ) : (
        <div className="field">
          <span className="label">Modelos instalados</span>
          <div className="ollama-list">
            {state.models.map((m) => (
              <button key={m.name} className={`provider ${current?.name === m.name ? 'active' : ''}`} onClick={() => void patch({ ollamaModel: m.name })}>
                <strong>
                  {m.name} {rec?.name === m.name && <em className="free-tag">recomendado</em>}
                </strong>
                <small>
                  {m.params ? `${m.params} · ` : ''}
                  {m.sizeGB} GB · {m.vision ? 'lê a tela' : 'só texto'}
                  {m.thinking ? ' · raciocínio' : ''}
                </small>
              </button>
            ))}
          </div>
          <button className="ghost xs" style={{ alignSelf: 'flex-start' }} onClick={() => void load()}>
            Atualizar lista
          </button>
        </div>
      )}
      {state.ok && !state.models.some((m) => m.vision) && (
        <p className="muted small">
          Nenhum modelo instalado lê imagens, então o Lumen vai responder sem ver a tela. Para ler a tela, instale um modelo de visão no Terminal:{' '}
          <code>ollama pull gemma3:4b</code> (3,3 GB, rápido) ou <code>ollama pull qwen2.5vl:7b</code> (6 GB, mais preciso), e clique em “Atualizar lista”.
        </p>
      )}
      <label>
        <span>Memória de contexto</span>
        <select value={settings.ollamaContext} onChange={(e) => void patch({ ollamaContext: Number(e.target.value) })}>
          <option value={4096}>4 mil tokens · mais leve</option>
          <option value={8192}>8 mil tokens · recomendado</option>
          <option value={16384}>16 mil tokens · conversas longas (usa mais RAM)</option>
          <option value={32768}>32 mil tokens · Macs com 32 GB+</option>
        </select>
      </label>
      <p className="muted small">Quanto maior, mais transcrição e documentos cabem em cada pergunta, mas o modelo usa mais memória e fica um pouco mais lento.</p>
      <div className="row">
        <ModelField label="Endereço do Ollama" value={settings.ollamaUrl} options={['http://localhost:11434']} onSave={(v) => void patch({ ollamaUrl: v })} />
      </div>
      <TestButton provider="ollama" />
    </>
  )
}

function SettingsPage() {
  const [dataDir, setDataDir] = useState('')
  useEffect(() => void window.lumen.system.info().then((i) => setDataDir(i.dataDir)), [])
  const [s, setS] = useState<Settings | null>(null)
  const [keys, setKeys] = useState<KeyStatus | null>(null)

  useEffect(() => {
    void window.lumen.settings.get().then(setS)
    const refresh = () => void window.lumen.keys.status().then(setKeys)
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [])

  if (!s || !keys) return null
  const patch = async (p: Partial<Settings>) => setS(await window.lumen.settings.set(p))

  return (
    <div className="page narrow-page">
      <h2>Configurações</h2>

      <section className="card form">
        <h3>Provedor de IA</h3>
        <div className="provider-grid">
          {PROVIDERS.map((p) => (
            <button key={p.id} className={`provider ${s.provider === p.id ? 'active' : ''}`} onClick={() => void patch({ provider: p.id })}>
              <strong>{p.label}</strong>
              <small>
                {p.free ? <em className="free-tag">grátis</em> : <em className="paid-tag">pago</em>} {p.vision}
              </small>
            </button>
          ))}
        </div>
        <p className="muted small">Se o provedor escolhido não estiver configurado, o Lumen usa outro que tenha chave.</p>

        {s.provider === 'gemini' && (
          <>
            <p className="muted small">
              Crie uma chave grátis em{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a> (só precisa de uma conta Google).
            </p>
            <ModelField label="Modelo Gemini" value={s.geminiModel} options={['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']} onSave={(v) => void patch({ geminiModel: v })} />
            <KeyField name="gemini" label="Chave do Gemini" saved={keys.gemini} />
          </>
        )}
        {s.provider === 'groq' && (
          <>
            <p className="muted small">
              Chave grátis em <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>. Muito rápido, mas os modelos padrão não leem a tela. A mesma chave serve para a transcrição.
            </p>
            <ModelField label="Modelo Groq" value={s.groqModel} options={['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']} onSave={(v) => void patch({ groqModel: v })} />
            <KeyField name="groq" label="Chave da Groq" saved={keys.groq} />
          </>
        )}
        {s.provider === 'ollama' && <OllamaSection settings={s} patch={patch} />}
        {s.provider === 'anthropic' && (
          <>
            <ModelField label="Modelo Claude" value={s.anthropicModel} options={['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']} onSave={(v) => void patch({ anthropicModel: v })} />
            <KeyField name="anthropic" label="Chave da Anthropic" saved={keys.anthropic} />
          </>
        )}
        {s.provider === 'openai' && (
          <>
            <ModelField label="Modelo OpenAI" value={s.openaiModel} options={['gpt-5-mini', 'gpt-5']} onSave={(v) => void patch({ openaiModel: v })} />
            <KeyField name="openai" label="Chave da OpenAI" saved={keys.openai} />
          </>
        )}
      </section>

      <section className="card form">
        <h3>Transcrição</h3>
        <div className="segmented">
          {(['openai', 'groq'] as const).map((p) => (
            <button key={p} className={s.transcriptionProvider === p ? 'active' : ''} onClick={() => void patch({ transcriptionProvider: p })}>
              {p === 'openai' ? 'OpenAI (pago)' : 'Groq Whisper (grátis)'}
            </button>
          ))}
        </div>
        {s.transcriptionProvider === 'groq' && s.provider !== 'groq' && <KeyField name="groq" label="Chave da Groq" saved={keys.groq} />}
        {s.transcriptionProvider === 'openai' && s.provider !== 'openai' && <KeyField name="openai" label="Chave da OpenAI" saved={keys.openai} />}
        <p className="muted small">A Groq transcreve de graça (limite diário generoso). A OpenAI é paga.</p>
        <label>
          <span>Revisão final (ao parar a gravação)</span>
          <select value={s.finalTranscriber} onChange={(e) => void patch({ finalTranscriber: e.target.value as Settings['finalTranscriber'] })}>
            <option value="auto">Automático: Gemini se houver chave, senão Whisper</option>
            <option value="gemini">Gemini · identifica quem fala (recomendado)</option>
            <option value="whisper">Whisper · só texto, sem separar as vozes</option>
          </select>
        </label>
        <div className="row">
          <label className="grow">
            <span>Idioma falado</span>
            <select value={s.transcriptionLanguage} onChange={(e) => void patch({ transcriptionLanguage: e.target.value })}>
              <option value="pt">Português</option>
              <option value="en">Inglês</option>
              <option value="es">Espanhol</option>
              <option value="ar">Árabe</option>
              <option value="auto">Detectar automaticamente</option>
            </select>
          </label>
          <label className="grow">
            <span>Sensibilidade do microfone</span>
            <input
              type="range"
              min={0.004}
              max={0.04}
              step={0.002}
              value={0.044 - s.silenceThreshold}
              onChange={(e) => setS({ ...s, silenceThreshold: 0.044 - Number(e.target.value) })}
              onMouseUp={() => void patch({ silenceThreshold: s.silenceThreshold })}
            />
          </label>
        </div>
      </section>

      <section className="card form">
        <h3>Respostas</h3>
        <label>
          <span>Idioma das respostas</span>
          <input value={s.answerLanguage} onChange={(e) => setS({ ...s, answerLanguage: e.target.value })} onBlur={() => void patch({ answerLanguage: s.answerLanguage })} />
        </label>
        <label>
          <span>Parar a escuta automaticamente</span>
          <select value={s.autoStopMinutes} onChange={(e) => void patch({ autoStopMinutes: Number(e.target.value) })}>
            <option value={5}>Após 5 min sem fala</option>
            <option value={10}>Após 10 min sem fala</option>
            <option value={30}>Após 30 min sem fala</option>
            <option value={0}>Nunca</option>
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.autoSuggest} onChange={(e) => void patch({ autoSuggest: e.target.checked })} />
          <span>Sugerir uma resposta automaticamente quando alguém fizer uma pergunta na conversa</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.launchHidden} onChange={(e) => void patch({ launchHidden: e.target.checked })} />
          <span>Iniciar com a barra oculta (use {kbd('CommandOrControl+\\')} para mostrar)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.openAtLogin} onChange={(e) => void patch({ openAtLogin: e.target.checked })} />
          <span>{isMac ? 'Abrir o Lumen ao iniciar o Mac (fica rodando na barra de menus)' : isWindows ? 'Abrir o Lumen ao iniciar o Windows (fica na bandeja, perto do relógio)' : 'Abrir o Lumen ao iniciar a sessão (fica na bandeja do sistema)'}</span>
        </label>
        {isMac && <label className="toggle">
          <input type="checkbox" checked={s.showInDock} onChange={(e) => void patch({ showInDock: e.target.checked })} />
          <span>Mostrar o ícone no Dock (o ícone na barra de menus fica sempre visível)</span>
        </label>}
      </section>

      <ShortcutsCard />

      <section className="card">
        <h3>Privacidade</h3>
        <p className="muted small">
          Tudo fica no seu computador: sessões em <code>{dataDir || '…'}</code> e chaves criptografadas pelo cofre do sistema{isMac ? ' (Keychain)' : isWindows ? ' (DPAPI do Windows)' : ''}. Áudio e capturas de tela vão
          apenas para o provedor de IA que você configurou, e só enquanto a escuta estiver ligada ou quando você pedir uma resposta.
        </p>
      </section>
    </div>
  )
}
