import { useEffect, useRef, useState } from 'react'
import type { KeyStatus, PermissionKind, PermissionsStatus, ProviderId } from '@shared/types'
import { Icon } from '@/components/Icon'
import { hint, isLinux, isMac, isWindows } from '@/lib/platform'

type StepId = PermissionKind | 'ai'
type AiChoice = 'free' | 'local' | 'own'

interface Step {
  id: StepId
  title: string
  short: string
  icon: string
  body: string
  why: string
}

const selectionKey = hint('CommandOrControl+Shift+L')

/** Os passos mudam conforme o sistema: cada um pede só o que realmente precisa. */
function stepsFor(): Step[] {
  const ai: Step = {
    id: 'ai',
    title: 'Inteligência artificial',
    short: 'Grátis, no seu computador ou com sua chave',
    icon: 'key',
    body: 'Escolha como o Lumen vai pensar. Dá para trocar a qualquer momento em Configurações.',
    why: 'O Lumen fala direto com o provedor escolhido (ou com o Ollama no seu computador), sem servidor intermediário.'
  }
  if (isMac) {
    return [
      { id: 'microphone', title: 'Microfone', short: 'Transcreve o que você fala', icon: 'mic', body: 'O macOS vai perguntar se o Lumen pode usar o microfone. O áudio só é captado enquanto a gravação estiver ligada.', why: 'Sem o microfone, o Lumen não sabe o que você disse e as sugestões ficam sem contexto.' },
      { id: 'screen', title: 'Tela e áudio do sistema', short: 'Lê a tela e ouve os outros participantes', icon: 'screen', body: 'Em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema, ative o Lumen. Se ele não aparecer, use o botão “+” e escolha o Lumen em Aplicativos. Depois, reabra o app.', why: 'A tela só é capturada quando você pede uma resposta. O áudio do sistema permite transcrever quem fala do outro lado da chamada.' },
      { id: 'accessibility', title: 'Acessibilidade', short: 'Ações no texto selecionado', icon: 'cursor', body: `Em Ajustes do Sistema → Privacidade e Segurança → Acessibilidade, ative o Lumen. Assim o atalho ${selectionKey} consegue copiar a seleção e colar o resultado de volta.`, why: 'É opcional: sem ela, todo o resto funciona, menos as ações sobre o texto selecionado.' },
      ai
    ]
  }
  if (isWindows) {
    return [
      { id: 'microphone', title: 'Microfone', short: 'Transcreve o que você fala', icon: 'mic', body: 'O Windows libera o microfone para aplicativos em Configurações → Privacidade e segurança → Microfone. Confira se “Permitir que aplicativos da área de trabalho acessem o microfone” está ativado.', why: 'Sem o microfone, o Lumen não sabe o que você disse e as sugestões ficam sem contexto.' },
      { id: 'screen', title: 'Tela e áudio do sistema', short: 'Já liberados no Windows', icon: 'screen', body: 'No Windows, o Lumen lê a tela e o áudio das chamadas sem pedir permissão extra. A tela só é capturada quando você pede uma resposta.', why: 'O áudio do sistema permite transcrever quem fala do outro lado da chamada (Teams, Meet, Zoom…).' },
      ai
    ]
  }
  return [
    { id: 'microphone', title: 'Microfone', short: 'Transcreve o que você fala', icon: 'mic', body: 'No Linux, o microfone passa pelo PipeWire/PulseAudio e não precisa de permissão. Confira só se o microfone certo está selecionado nas Configurações de som.', why: 'Sem o microfone, o Lumen não sabe o que você disse.' },
    { id: 'screen', title: 'Tela e áudio do sistema', short: 'O sistema pergunta na hora', icon: 'screen', body: 'Em sessões Wayland (GNOME, KDE), o sistema mostra uma janela pedindo para compartilhar a tela na primeira vez que o Lumen precisar. Escolha a tela e marque “lembrar”, se houver a opção.', why: 'A tela só é capturada quando você pede uma resposta.' },
    { id: 'accessibility', title: 'Texto selecionado', short: 'Precisa de uma ferramenta pequena', icon: 'cursor', body: `Para o atalho ${selectionKey} copiar o texto selecionado em outros apps, instale o xdotool (X11) ou o wtype (Wayland). No Ubuntu/Debian: sudo apt install xdotool`, why: 'É opcional: sem ela, todo o resto funciona, menos as ações sobre o texto selecionado.' },
    ai
  ]
}

const STEPS = stepsFor()

type OllamaState = Awaited<ReturnType<typeof window.lumen.ollama.status>>
type OllamaModel = { name: string; sizeGB: number; vision: boolean }

export function Onboarding() {
  const [perms, setPerms] = useState<PermissionsStatus | null>(null)
  const [keys, setKeys] = useState<KeyStatus | null>(null)
  const [selection, setSelection] = useState<'ok' | 'needs-accessibility' | 'needs-linux-tool'>('ok')
  const [active, setActive] = useState<StepId>('microphone')
  const [showWhy, setShowWhy] = useState(false)
  const [screenRequested, setScreenRequested] = useState(false)
  const [choice, setChoice] = useState<AiChoice>('free')
  const [keyDraft, setKeyDraft] = useState({ gemini: '', groq: '', anthropic: '', openai: '' })
  const [saved, setSaved] = useState('')
  const [ollama, setOllama] = useState<OllamaState | null>(null)
  const [installed, setInstalled] = useState<OllamaModel[]>([])
  const [pull, setPull] = useState<{ name: string; status: string; percent?: number; error?: string } | null>(null)
  const [provider, setProvider] = useState<ProviderId | null>(null)
  // Depois que a pessoa escolhe uma etapa na lista, o app para de avançar sozinho.
  const manual = useRef(false)

  useEffect(() => {
    const refresh = () => {
      void window.lumen.perms.status().then(setPerms)
      void window.lumen.keys.status().then(setKeys)
      void window.lumen.system.info().then((i) => setSelection(i.selection))
      void window.lumen.settings.get().then((s) => setProvider(s.provider))
    }
    refresh()
    const id = setInterval(refresh, 1500)
    return () => clearInterval(id)
  }, [])

  // Detecta o Ollama enquanto a opção "no seu computador" estiver aberta.
  useEffect(() => {
    if (active !== 'ai' || choice !== 'local') return
    const check = async () => {
      const st = await window.lumen.ollama.status()
      setOllama(st)
      if (st.running) {
        const r = await window.lumen.ollama.models()
        setInstalled(r.models)
      }
    }
    void check()
    const id = setInterval(check, 3000)
    return () => clearInterval(id)
  }, [active, choice])

  useEffect(() => window.lumen.ollama.onPullProgress((p) => setPull((cur) => (cur && cur.name === p.name ? { ...cur, ...p } : cur))), [])

  const hasCloudKey = !!(keys && (keys.gemini || keys.groq || keys.anthropic || keys.openai))
  const aiReady = hasCloudKey || (provider === 'ollama' && installed.length > 0)

  const done = (id: StepId): boolean => {
    if (id === 'ai') return aiReady
    if (id === 'accessibility') return isMac ? perms?.accessibility === 'granted' : selection === 'ok'
    return perms?.[id] === 'granted'
  }

  const step = STEPS.find((s) => s.id === active)!
  const allRequired = done('microphone') && done('ai')

  const saveKeys = async () => {
    for (const name of ['gemini', 'groq', 'anthropic', 'openai'] as const) {
      if (keyDraft[name]) await window.lumen.keys.set(name, keyDraft[name])
    }
    // Escolhe automaticamente provedores compatíveis com o que foi salvo.
    const k = await window.lumen.keys.status()
    const p: ProviderId = k.gemini ? 'gemini' : k.anthropic ? 'anthropic' : k.openai ? 'openai' : 'groq'
    await window.lumen.settings.set({ provider: p, transcriptionProvider: k.groq || !k.openai ? 'groq' : 'openai' })
    setKeys(k)
    setKeyDraft({ gemini: '', groq: '', anthropic: '', openai: '' })
    setSaved('Chaves salvas e testadas na próxima pergunta.')
  }

  const useOllama = async (model: string) => {
    await window.lumen.settings.set({ provider: 'ollama', ollamaModel: model })
    setProvider('ollama')
    setSaved(`Usando ${model} no seu computador.`)
  }

  const pullModel = async (name: string) => {
    setPull({ name, status: 'Iniciando download…' })
    const r = await window.lumen.ollama.pull(name)
    if (!r.ok) setPull({ name, status: '', error: r.error })
    else {
      setPull(null)
      setInstalled((await window.lumen.ollama.models()).models)
      await useOllama(name)
    }
  }

  const requestStep = async () => {
    if (active === 'screen') setScreenRequested(true)
    if (active === 'ai') return
    setPerms(await window.lumen.perms.request(active))
  }

  useEffect(() => {
    // Avança sozinho quando a etapa atual é concluída (menos a de IA, que tem escolhas).
    if (manual.current || !perms || active === 'ai' || !done(active)) return
    const next = STEPS.find((s) => !done(s.id))
    if (next && next.id !== active) setTimeout(() => !manual.current && setActive(next.id), 700)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms, selection])

  const keyInput = (name: keyof typeof keyDraft, label: string, placeholder: string, link?: string, free?: boolean) => (
    <label>
      <span>
        {label} {free && <em className="free-tag">grátis</em>} {keys?.[name] && <em className="ok-tag">salva</em>}
        {link && (
          <button className="link" onClick={() => void window.lumen.system.openUrl(link)}>
            criar chave
          </button>
        )}
      </span>
      <input type="password" placeholder={placeholder} value={keyDraft[name]} onChange={(e) => setKeyDraft({ ...keyDraft, [name]: e.target.value })} />
    </label>
  )

  return (
    <div className="onboarding">
      <aside>
        <div className="titlebar-space" />
        <h1>Bem-vindo ao Lumen</h1>
        <p className="muted">Alguns passos rápidos. Você pode pular e voltar depois pelo ícone do Lumen{isMac ? ' na barra de menus' : ' na bandeja do sistema'}.</p>
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.id}>
              <button className={`step ${active === s.id ? 'active' : ''} ${done(s.id) ? 'done' : ''}`} onClick={() => ((manual.current = true), setActive(s.id), setShowWhy(false), setSaved(''))}>
                <span className="step-icon">{done(s.id) ? <Icon name="check" size={16} /> : <Icon name={s.icon} size={16} />}</span>
                <span>
                  <strong>{s.title}</strong>
                  <small>{s.short}</small>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="aside-foot">
          <button className="primary" disabled={!allRequired} onClick={() => void window.lumen.app.finishOnboarding()}>
            {allRequired ? 'Começar a usar' : 'Conclua microfone e IA'}
          </button>
          <button className="ghost sm" onClick={() => void window.lumen.app.finishOnboarding()}>
            Pular por enquanto
          </button>
        </div>
      </aside>

      <section className={`stage ${active === 'ai' ? 'stage-ai' : ''}`}>
        {active !== 'ai' && (
          <div className="stage-art">
            <div className={`orb ${done(active) ? 'ok' : ''}`}>
              <Icon name={done(active) ? 'check' : step.icon} size={40} />
            </div>
          </div>
        )}
        <h2>{step.title}</h2>
        <p>{step.body}</p>

        {active === 'ai' ? (
          <div className="ai-setup">
            <div className="choice-row">
              <button className={`provider ${choice === 'free' ? 'active' : ''}`} onClick={() => setChoice('free')}>
                <strong>Grátis na nuvem</strong>
                <small><em className="free-tag">recomendado</em> Gemini responde e lê a tela; Groq transcreve o áudio.</small>
              </button>
              <button className={`provider ${choice === 'local' ? 'active' : ''}`} onClick={() => setChoice('local')}>
                <strong>No seu computador</strong>
                <small><em className="free-tag">grátis</em> Ollama: privado e offline. Precisa de 8 GB+ de RAM.</small>
              </button>
              <button className={`provider ${choice === 'own' ? 'active' : ''}`} onClick={() => setChoice('own')}>
                <strong>Minha chave</strong>
                <small><em className="paid-tag">pago</em> Claude (Anthropic) ou OpenAI.</small>
              </button>
            </div>

            {choice === 'free' && (
              <div className="key-form">
                {keyInput('gemini', 'Gemini', 'AIza…', 'https://aistudio.google.com/apikey', true)}
                {keyInput('groq', 'Groq (transcrição)', 'gsk_…', 'https://console.groq.com/keys', true)}
                <p className="muted small">As duas contas são gratuitas e levam um minuto para criar. As chaves ficam criptografadas no seu computador.</p>
                <button className="primary" disabled={!keyDraft.gemini && !keyDraft.groq} onClick={() => void saveKeys()}>Salvar chaves</button>
              </div>
            )}

            {choice === 'local' && (
              <div className="key-form">
                {!ollama ? (
                  <p className="muted small">Procurando o Ollama…</p>
                ) : !ollama.running ? (
                  <>
                    <div className="notice-line">O Ollama não está rodando neste computador.</div>
                    <ol className="howto">
                      <li>
                        <button className="primary sm" onClick={() => void window.lumen.system.openUrl(ollama.download.url)}>
                          <Icon name="download" size={14} /> {ollama.download.label}
                        </button>
                        {ollama.download.command && (
                          <span className="muted small">
                            {' '}ou no terminal: <code>{ollama.download.command}</code>
                          </span>
                        )}
                      </li>
                      <li className="muted small">Instale e abra o Ollama. Esta tela detecta sozinha quando ele estiver pronto.</li>
                    </ol>
                  </>
                ) : (
                  <>
                    <div className="granted">Ollama encontrado.</div>
                    {installed.length > 0 && (
                      <div className="field">
                        <span className="label">Modelos já instalados</span>
                        <div className="ollama-list">
                          {installed.map((m) => (
                            <button key={m.name} className={`provider ${provider === 'ollama' ? '' : ''}`} onClick={() => void useOllama(m.name)}>
                              <strong>{m.name}</strong>
                              <small>{m.sizeGB} GB · {m.vision ? 'lê a tela' : 'só texto'}</small>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="field">
                      <span className="label">{installed.length ? 'Ou baixe outro modelo' : 'Baixe um modelo (uma vez só)'}</span>
                      {ollama.suggested.map((m) => {
                        const has = installed.some((i) => i.name === m.name)
                        const busy = pull?.name === m.name && !pull.error
                        return (
                          <div key={m.name} className="model-row">
                            <span className="grow">
                              <strong>{m.name}</strong> <span className="muted small">· {m.size}</span>
                              <small className="block muted">{m.note}</small>
                            </span>
                            {has ? (
                              <button className="ghost sm" onClick={() => void useOllama(m.name)}>Usar</button>
                            ) : (
                              <button className="ghost sm" disabled={!!pull && !pull.error} onClick={() => void pullModel(m.name)}>
                                {busy ? `${pull?.percent ?? 0}%` : 'Baixar'}
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {pull && !pull.error && (
                        <div className="progress">
                          <div style={{ width: `${pull.percent ?? 2}%` }} />
                          <small className="muted">{pull.status || 'Baixando…'}</small>
                        </div>
                      )}
                      {pull?.error && <small className="error-text">{pull.error}</small>}
                    </div>
                  </>
                )}
                <p className="muted small">
                  O Ollama responde às perguntas. Para transcrever o áudio das gravações, adicione também a chave grátis da Groq na opção “Grátis na nuvem”.
                </p>
              </div>
            )}

            {choice === 'own' && (
              <div className="key-form">
                {keyInput('anthropic', 'Anthropic (Claude)', 'sk-ant-…', 'https://console.anthropic.com/settings/keys')}
                {keyInput('openai', 'OpenAI', 'sk-…', 'https://platform.openai.com/api-keys')}
                <p className="muted small">A chave da OpenAI também serve para transcrever o áudio.</p>
                <button className="primary" disabled={!keyDraft.anthropic && !keyDraft.openai} onClick={() => void saveKeys()}>Salvar chaves</button>
              </div>
            )}
            {saved && <div className="granted">{saved}</div>}
          </div>
        ) : done(active) ? (
          <div className="granted">{isMac || active === 'microphone' ? 'Permissão concedida.' : 'Tudo certo por aqui.'}</div>
        ) : (
          <div className="stage-actions">
            {(isMac || (isWindows && active === 'microphone')) && (
              <button className="primary" onClick={() => void requestStep()}>
                {isMac && active === 'microphone' ? 'Permitir microfone' : isWindows ? 'Abrir Configurações do Windows' : 'Abrir Ajustes do Sistema'}
              </button>
            )}
            {isLinux && active === 'accessibility' && (
              <button className="ghost" onClick={() => void navigator.clipboard.writeText('sudo apt install xdotool')}>Copiar comando</button>
            )}
            {isMac && (active === 'screen' || active === 'accessibility' || screenRequested) && (
              <button className="ghost" onClick={() => void window.lumen.app.relaunch()}>
                <Icon name="refresh" size={14} /> Já ativei, reabrir o Lumen
              </button>
            )}
          </div>
        )}

        <button className="why" onClick={() => setShowWhy(!showWhy)}>
          Por que isso é necessário? <Icon name="chevron" size={12} />
        </button>
        {showWhy && <p className="muted small">{step.why}</p>}
      </section>
    </div>
  )
}
