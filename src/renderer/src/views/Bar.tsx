import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SELECTION_ACTIONS, type FinalizeStatus, type Mode, type SelectionAction, type Settings } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { Icon } from '@/components/Icon'
import { useAsk } from '@/lib/useAsk'
import { hint } from '@/lib/platform'
import { formatElapsed, useListening } from '@/lib/useListening'

type Panel = 'none' | 'answer' | 'transcript' | 'modes' | 'selection'

function Level({ value, label }: { value: number; label: string }) {
  const bars = [0.15, 0.35, 0.6, 0.85]
  return (
    <span className="level" title={label} aria-label={label}>
      {bars.map((b) => (
        <i key={b} className={value > b ? 'on' : ''} />
      ))}
    </span>
  )
}

function reviewText(r: FinalizeStatus | null): string {
  if (!r) return ''
  if (r.state === 'running') return r.total ? `Revisando a transcrição em segundo plano (${r.done}/${r.total})…` : 'Revisando a transcrição em segundo plano…'
  if (r.state === 'done') return 'Transcrição revisada.'
  if (r.state === 'partial') return `Transcrição revisada; ${r.fallbackParts} trecho(s) ficaram com a versão ao vivo.`
  return `A revisão não foi concluída (${r.error ?? 'erro'}); a transcrição ao vivo está salva. Dá para tentar de novo no Histórico.`
}

export function Bar() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [modes, setModes] = useState<Mode[]>([])
  const [panel, setPanel] = useState<Panel>('none')
  const [input, setInput] = useState('')
  const [withScreen, setWithScreen] = useState(true)
  const [selection, setSelection] = useState<{ text: string; error?: string } | null>(null)
  const [selAction, setSelAction] = useState<SelectionAction | null>(null)
  const [replaceable, setReplaceable] = useState<SelectionAction[]>([])
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const transcriptEnd = useRef<HTMLDivElement>(null)

  const { state: answer, ask, cancel, reset } = useAsk()
  const listening = useListening(settings?.silenceThreshold ?? 0.012, settings?.autoStopMinutes ?? 10)
  const rec = listening.state.status
  const recording = rec !== 'idle'
  const live = listening.state.session
  const mode = modes.find((m) => m.id === settings?.activeModeId) ?? modes[0]

  useEffect(() => {
    void window.lumen.settings.get().then(setSettings)
    void window.lumen.modes.list().then(setModes)
    void window.lumen.selection.replaceable().then(setReplaceable)
    const offs = [window.lumen.settings.onChange(setSettings), window.lumen.modes.onChange(setModes)]
    return () => offs.forEach((o) => o())
  }, [])

  // A janela acompanha a altura do conteúdo.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => window.lumen.bar.resize(el.getBoundingClientRect().height + 24))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => transcriptEnd.current?.scrollIntoView({ block: 'end' }), [listening.state.lines.length, panel])

  const askScreen = useCallback(
    (prompt?: string, screen = true) => {
      setPanel('answer')
      ask({ kind: 'ask', prompt, includeScreen: screen, sessionId: live?.id }, prompt || 'Ajuda com a tela')
      setInput('')
    },
    [ask, live?.id]
  )

  const suggest = useCallback(() => {
    setPanel('answer')
    ask({ kind: 'suggest', includeScreen: withScreen, sessionId: live?.id }, 'O que eu digo agora?')
  }, [ask, live?.id, withScreen])

  const play = useCallback(async () => {
    if (!mode) return
    await listening.play(mode.id)
    // Durante a gravação, só a barra com os controles fica visível.
    setPanel((p) => (p === 'transcript' || p === 'modes' ? 'none' : p))
  }, [listening, mode])

  const stopRec = useCallback(async () => {
    await listening.stop()
    setPanel((p) => (p === 'transcript' ? 'none' : p))
  }, [listening])

  /** Atalho de gravação: grava/continua, ou pausa se já estiver gravando. */
  const toggleListen = useCallback(async () => {
    if (rec === 'recording' || rec === 'starting') await listening.pause()
    else if (rec === 'idle' || rec === 'paused') await play()
  }, [rec, listening, play])

  // Atalhos globais vindos do processo main.
  const handlers = useRef({ askScreen, suggest, toggleListen, stopRec, play, pause: listening.pause })
  handlers.current = { askScreen, suggest, toggleListen, stopRec, play, pause: listening.pause }
  useEffect(() => {
    const offs = [
      window.lumen.bar.onShortcut((name) => {
        if (name === 'ask-screen') handlers.current.askScreen()
        if (name === 'suggest') handlers.current.suggest()
        if (name === 'toggle-listen') void handlers.current.toggleListen()
      }),
      window.lumen.bar.onListenCommand((cmd) => {
        if (cmd === 'stop') void handlers.current.stopRec()
        if (cmd === 'pause') void handlers.current.pause()
        if (cmd === 'play') void handlers.current.play()
      }),
      window.lumen.selection.onCaptured((p) => {
        setSelection(p)
        setSelAction(null)
        reset()
        setPanel('selection')
      })
    ]
    return () => offs.forEach((o) => o())
  }, [reset])

  // Melhoria: sugestão automática quando alguém faz uma pergunta na conversa.
  const lastLine = listening.state.lines.at(-1)
  useEffect(() => {
    if (!settings?.autoSuggest || !lastLine || lastLine.speaker !== 'them') return
    if (!/\?\s*$/.test(lastLine.text)) return
    if (answer.status === 'thinking' || answer.status === 'streaming') return
    const t = setTimeout(() => handlers.current.suggest(), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLine?.id])

  const runSelection = (action: SelectionAction) => {
    if (!selection?.text) return
    setSelAction(action)
    ask({ kind: 'selection', selection: { text: selection.text, action }, prompt: action === 'custom' ? input : undefined })
    if (action === 'custom') setInput('')
  }

  const pickMode = async (id: string) => {
    setSettings(await window.lumen.settings.set({ activeModeId: id }))
    setPanel('none')
  }

  const copy = (text: string) => {
    void window.lumen.clipboard.write(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  // Revisão da transcrição (em segundo plano) da sessão que acabou de ser salva.
  const [review, setReview] = useState<FinalizeStatus | null>(null)
  const savedId = listening.state.savedSessionId
  useEffect(() => window.lumen.sessions.onFinalize((p) => setReview((r) => (p.sessionId === savedId || r?.sessionId === p.sessionId ? p : r))), [savedId])
  useEffect(() => {
    if (!savedId) return setReview(null)
    void window.lumen.sessions.finalizeStatus().then((list) => setReview(list.find((x) => x.sessionId === savedId) ?? null))
  }, [savedId])

  const busy = answer.status === 'thinking' || answer.status === 'streaming'
  const showInput = panel === 'answer' || panel === 'selection' || (panel === 'transcript' && !recording)

  return (
    <div className="bar-root" ref={rootRef}>
      {recording ? (
        // Durante a gravação, a barra mostra só os controles: ▶ / ⏸ e ⏹.
        <div className={`bar rec-bar ${rec}`}>
          <div className="drag-handle" title="Arraste para mover">
            <span className="logo-dot" />
          </div>
          <div className="rec-status">
            <span className={`rec-dot ${rec === 'recording' ? '' : 'still'}`} />
            <span className="rec-label">
              {rec === 'starting' && 'Iniciando…'}
              {rec === 'recording' && 'Gravando'}
              {rec === 'paused' && 'Pausado'}
              {rec === 'finalizing' && 'Salvando…'}
            </span>
            <span className="mono">{formatElapsed(listening.state.elapsed)}</span>
            {rec === 'recording' && (
              <>
                <Level value={listening.state.micLevel} label="Você" />
                {listening.state.systemAudio === 'on' && <Level value={listening.state.sysLevel} label="Outros" />}
              </>
            )}
          </div>

          <div className="spacer" />

          {rec !== 'finalizing' && (
            <>
              {rec === 'recording' || rec === 'starting' ? (
                <button className="rec-btn" onClick={() => void listening.pause()} title="Pausar (solta o microfone)">
                  <Icon name="pause" size={16} />
                  <span>Pausar</span>
                </button>
              ) : (
                <button className="rec-btn play" onClick={() => void play()} title="Continuar gravando">
                  <Icon name="play" size={16} />
                  <span>Continuar</span>
                </button>
              )}
              <button className="rec-btn stop" onClick={() => void stopRec()} title="Parar e salvar">
                <Icon name="stop" size={14} />
                <span>Parar e salvar</span>
              </button>
            </>
          )}
          <button
            className={`icon-btn ${panel === 'transcript' ? 'active' : ''}`}
            onClick={() => setPanel(panel === 'transcript' ? 'none' : 'transcript')}
            title="Transcrição ao vivo"
          >
            <Icon name="lines" size={15} />
          </button>
          <button className="icon-btn" onClick={() => window.lumen.bar.hide()} title="Ocultar a barra (a gravação continua)">
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : (
      <div className="bar">
        <div className="drag-handle" title="Arraste para mover">
          <span className="logo-dot" />
        </div>

        <button className="chip mode-chip" onClick={() => setPanel(panel === 'modes' ? 'none' : 'modes')} title="Trocar modo">
          <span className="mode-icon">{mode?.icon ?? '✦'}</span>
          <span className="mode-name">{mode?.name ?? 'Modo'}</span>
          <Icon name="chevron" size={12} />
        </button>

        <div className="sep" />

        <button className="chip" onClick={() => void play()} title={`Gravar (${hint('CommandOrControl+Shift+M')})`}>
          <Icon name="mic" size={14} />
          <span>Gravar</span>
        </button>

        <button className="chip" onClick={() => askScreen()} title={`Responder com o contexto da tela (${hint('CommandOrControl+Shift+Return')})`}>
          <Icon name="sparkle" size={14} />
          <span>Perguntar</span>
        </button>

        <button className="chip" onClick={suggest} title={`Sugerir o que falar (${hint('CommandOrControl+Shift+S')})`}>
          <Icon name="bubble" size={14} />
          <span>O que digo?</span>
        </button>

        <div className="spacer" />

        <button className="icon-btn" onClick={() => window.lumen.app.openMain('home')} title="Abrir o Lumen">
          <Icon name="home" size={15} />
        </button>
        <button className="icon-btn" onClick={() => window.lumen.bar.hide()} title={`Ocultar (${hint('CommandOrControl+\\')})`}>
          <Icon name="close" size={14} />
        </button>
      </div>
      )}

      {listening.state.savedSessionId && rec === 'idle' && (
        <div className={`toast ${review?.state === 'failed' ? 'warn' : 'ok'}`}>
          {[listening.state.notice ?? 'Gravação salva.', reviewText(review)].filter(Boolean).join(' ')}
          <span className="row">
            <button className="ghost xs" onClick={() => (window.lumen.app.openMain('history'), listening.dismiss())}>
              Ver sessão
            </button>
            <button className="ghost xs" onClick={listening.dismiss}>
              OK
            </button>
          </span>
        </div>
      )}
      {listening.state.notice && !live && !listening.state.savedSessionId && (
        <div className="toast">
          {listening.state.notice}
          <button className="ghost xs" onClick={() => window.lumen.app.openMain('history')}>
            Ver sessão
          </button>
        </div>
      )}
      {listening.state.error && (
        <div className="toast warn">
          {listening.state.error}
          <button className="ghost xs" onClick={() => window.lumen.app.openMain('settings')}>
            Configurações
          </button>
        </div>
      )}
      {rec === 'recording' && listening.state.systemAudio === 'failed' && (
        <div className="toast">
          Só o microfone está ativo. Para ouvir os outros participantes, libere “Gravação de Tela e Áudio do Sistema” para o Lumen.
          <button className="ghost xs" onClick={() => window.lumen.app.openOnboarding()}>
            Permissões
          </button>
        </div>
      )}

      {panel === 'modes' && (
        <div className="panel">
          <div className="panel-title">Modo do assistente</div>
          <div className="mode-list">
            {modes.map((m) => (
              <button key={m.id} className={`mode-item ${m.id === mode?.id ? 'selected' : ''}`} onClick={() => void pickMode(m.id)}>
                <span className="mode-icon">{m.icon}</span>
                <span>
                  <strong>{m.name}</strong>
                  <small>{m.docs.length ? `${m.docs.length} documento(s) de contexto` : m.prompt.slice(0, 70) + '…'}</small>
                </span>
              </button>
            ))}
          </div>
          <button className="ghost sm" onClick={() => window.lumen.app.openMain('modes')}>
            Editar modos e documentos
          </button>
        </div>
      )}

      {panel === 'transcript' && (
        <div className="panel">
          <div className="panel-title">
            Transcrição ao vivo
            <span className="muted">{listening.state.lines.length} falas</span>
          </div>
          <div className="transcript">
            {listening.state.lines.length === 0 && <div className="empty">Ouvindo… as falas aparecem aqui em poucos segundos.</div>}
            {listening.state.lines.map((l) => (
              <div key={l.id} className={`line ${l.speaker}`}>
                <span className="who">{l.speaker === 'me' ? 'Você' : 'Outros'}</span>
                <span>{l.text}</span>
              </div>
            ))}
            <div ref={transcriptEnd} />
          </div>
        </div>
      )}

      {panel === 'selection' && selection && (
        <div className="panel">
          <div className="panel-title">
            Texto selecionado
            <button className="ghost xs" onClick={() => setPanel('none')}>
              Fechar
            </button>
          </div>
          {selection.error === 'ACCESSIBILITY' ? (
            <div className="notice">
              Para ler o texto selecionado em outros apps, o Lumen precisa da permissão de Acessibilidade.
              <button className="primary sm" onClick={() => window.lumen.app.openOnboarding()}>
                Liberar acesso
              </button>
            </div>
          ) : !selection.text ? (
            <div className="notice">Nenhum texto selecionado. Selecione um trecho em qualquer app e pressione {hint('CommandOrControl+Shift+L')}.</div>
          ) : (
            <>
              <blockquote className="selection-preview">{selection.text.slice(0, 400)}{selection.text.length > 400 ? '…' : ''}</blockquote>
              <div className="actions-row">
                {SELECTION_ACTIONS.map((a) => (
                  <button key={a.id} className={`chip sm ${selAction === a.id ? 'selected' : ''}`} onClick={() => runSelection(a.id)}>
                    {a.label}
                  </button>
                ))}
              </div>
              {selAction && (
                <div className="answer">
                  {answer.status === 'thinking' && <div className="thinking"><span /><span /><span /></div>}
                  {answer.text && <Markdown text={answer.text} />}
                  {answer.status === 'error' && <div className="error">{answer.error}</div>}
                  {answer.status === 'done' && (
                    <div className="answer-actions">
                      <button className="ghost sm" onClick={() => copy(answer.text)}>
                        {copied ? 'Copiado' : 'Copiar'}
                      </button>
                      {replaceable.includes(selAction) && (
                        <button className="primary sm" onClick={() => void window.lumen.selection.replace(answer.text)}>
                          Substituir no app
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {panel === 'answer' && (
        <div className="panel">
          <div className="panel-title">
            <span className="q">{answer.label}</span>
            <span className="row">
              {busy && (
                <button className="ghost xs" onClick={cancel}>
                  Parar
                </button>
              )}
              {answer.status === 'done' && (
                <button className="ghost xs" onClick={() => copy(answer.text)}>
                  {copied ? 'Copiado' : 'Copiar'}
                </button>
              )}
              <button className="ghost xs" onClick={() => (reset(), setPanel(live ? 'transcript' : 'none'))}>
                Fechar
              </button>
            </span>
          </div>
          <div className="answer">
            {answer.notice && (
              <div className="notice-line">
                {answer.notice}
                {/Gravação de Tela/.test(answer.notice) && (
                  <button className="ghost xs" onClick={() => window.lumen.app.openOnboarding()}>
                    Resolver
                  </button>
                )}
              </div>
            )}
            {answer.status === 'thinking' && (
              <div className="thinking">
                <span />
                <span />
                <span />
              </div>
            )}
            {answer.text && <Markdown text={answer.text} />}
            {answer.status === 'error' && (
              <div className="error">
                {answer.error}
                {answer.configError && (
                  <button className="primary sm" onClick={() => window.lumen.app.openMain('settings')}>
                    Configurar chave
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {showInput && !(panel === 'selection' && (!selection?.text || selection.error)) && (
        <form
          className="ask-row"
          onSubmit={(e) => {
            e.preventDefault()
            const q = input.trim()
            if (!q) return
            if (panel === 'selection') runSelection('custom')
            else askScreen(q, withScreen)
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => window.lumen.bar.focus()}
            placeholder={panel === 'selection' ? 'Outra instrução para o texto selecionado…' : 'Pergunte qualquer coisa…'}
          />
          {panel !== 'selection' && (
            <button
              type="button"
              className={`icon-btn ${withScreen ? 'active' : ''}`}
              onClick={() => setWithScreen(!withScreen)}
              title={withScreen ? 'Incluindo a tela no contexto' : 'Sem a tela no contexto'}
            >
              <Icon name="screen" size={15} />
            </button>
          )}
          <button type="submit" className="primary sm" disabled={!input.trim()}>
            Enviar
          </button>
        </form>
      )}
    </div>
  )
}
