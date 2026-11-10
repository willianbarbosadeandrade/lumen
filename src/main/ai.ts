import type { ProviderId } from '@shared/types'
import { getKey, getSettings, setSettings } from './store'
import { ContextOverflowError, ollamaCapabilities, streamOllamaChat, thinkFilter } from './ollama'

export interface LlmImage {
  mediaType: 'image/png' | 'image/jpeg'
  base64: string
}

export interface LlmTurn {
  role: 'user' | 'assistant'
  text: string
  images?: LlmImage[]
}

export interface StreamOptions {
  system: string
  turns: LlmTurn[]
  maxTokens?: number
  signal: AbortSignal
  onText: (delta: string) => void
  retried?: boolean
  /** Tarefa em segundo plano (ex.: resumo): espera mais antes de desistir de um provedor sobrecarregado. */
  patient?: boolean
  /** Avisa quando a resposta precisou vir de outro provedor. */
  onFallback?: (from: string, to: ProviderId) => void
}

export class AiConfigError extends Error {}
export class ModelUnavailableError extends Error {}

const FALLBACK_ORDER: ProviderId[] = ['anthropic', 'openai', 'gemini', 'groq']

function isConfigured(p: ProviderId): boolean {
  if (p === 'ollama') return true // local: não precisa de chave
  return !!getKey(p)
}

export function activeProvider(): ProviderId {
  const s = getSettings()
  // Se a chave do provedor escolhido faltar, cai automaticamente para outro que tenha chave.
  if (isConfigured(s.provider)) return s.provider
  const other = FALLBACK_ORDER.find((p) => p !== s.provider && isConfigured(p))
  if (other) return other
  throw new AiConfigError('Nenhuma chave de IA configurada. Abra Configurações → Provedor de IA (Gemini e Groq são gratuitos).')
}

const VISION_HINT = /vision|llava|gemma3|qwen.*vl|minicpm|moondream|scout|maverick|pixtral|granite.*vision/i

interface CompatTarget {
  name: string
  url: string
  key?: string
  model: string
  vision: boolean
  tokenParam: 'max_tokens' | 'max_completion_tokens'
}

function compatTarget(p: Exclude<ProviderId, 'anthropic'>): CompatTarget {
  const s = getSettings()
  switch (p) {
    case 'openai':
      return { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', key: getKey('openai'), model: s.openaiModel, vision: true, tokenParam: 'max_completion_tokens' }
    case 'gemini':
      return { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: getKey('gemini'), model: s.geminiModel, vision: true, tokenParam: 'max_tokens' }
    case 'groq':
      return { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: getKey('groq'), model: s.groqModel, vision: VISION_HINT.test(s.groqModel), tokenParam: 'max_tokens' }
    case 'ollama':
      return { name: 'Ollama', url: `${s.ollamaUrl.replace(/\/+$/, '')}/v1/chat/completions`, model: s.ollamaModel, vision: VISION_HINT.test(s.ollamaModel), tokenParam: 'max_tokens' }
  }
}

/** Lê um corpo SSE e entrega cada payload `data:` já parseado. */
async function readSse(res: Response, onEvent: (data: any) => void): Promise<void> {
  if (!res.body) throw new Error('Resposta sem corpo')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        onEvent(JSON.parse(payload))
      } catch {
        /* linha parcial ou keep-alive */
      }
    }
  }
}

async function failure(res: Response, provider: string): Promise<never> {
  let detail = ''
  try {
    const j = await res.json()
    detail = j?.error?.message ?? JSON.stringify(j)
  } catch {
    detail = await res.text().catch(() => '')
  }
  if (res.status === 401) throw new AiConfigError(`Chave de API do ${provider} inválida (401).`)
  if (res.status === 404 || /no longer available|not found|does not exist|decommissioned|deprecated/i.test(detail)) {
    throw new ModelUnavailableError(`${provider}: modelo indisponível — ${detail.slice(0, 200)}`)
  }
  if ([429, 500, 502, 503, 504].includes(res.status)) {
    throw new TransientError(res.status, provider, detail.slice(0, 200))
  }
  throw new Error(`${provider} respondeu ${res.status}: ${detail.slice(0, 300)}`)
}

/** Sobrecarga ou limite momentâneo do provedor: vale tentar de novo ou usar outro. */
export class TransientError extends Error {
  constructor(public status: number, public provider: string, detail: string) {
    super(`${provider} está sobrecarregado agora (${status}). ${detail}`)
  }
}

async function streamAnthropic(o: StreamOptions): Promise<void> {
  const s = getSettings()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: o.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': getKey('anthropic')!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: s.anthropicModel,
      max_tokens: o.maxTokens ?? 2048,
      stream: true,
      system: o.system,
      messages: o.turns.map((t) => ({
        role: t.role,
        content: [
          ...(t.images ?? []).map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
          })),
          { type: 'text', text: t.text || '(sem texto)' }
        ]
      }))
    })
  })
  if (!res.ok) await failure(res, 'Anthropic')
  await readSse(res, (ev) => {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') o.onText(ev.delta.text)
    if (ev.type === 'error') throw new Error(ev.error?.message ?? 'Erro no stream da Anthropic')
  })
}

/** Lista os modelos da conta e escolhe o Gemini Flash de versão mais alta (sem lite/preview/áudio/imagem). */
export async function latestGeminiFlash(key?: string): Promise<string | null> {
  if (!key) return null
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000)
    })
    if (!res.ok) return null
    const { data } = (await res.json()) as { data?: { id: string }[] }
    const version = (id: string) => (id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0').split('.').map(Number)
    const ids = (data ?? [])
      .map((m) => m.id.replace(/^models\//, ''))
      .filter((id) => /^gemini-[\d.]+-flash$/.test(id))
    ids.sort((a, b) => {
      const [a1, a2 = 0] = version(a)
      const [b1, b2 = 0] = version(b)
      return b1 - a1 || b2 - a2
    })
    return ids[0] ?? null
  } catch {
    return null
  }
}

async function streamCompat(t: CompatTarget, o: StreamOptions): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (t.key) headers.authorization = `Bearer ${t.key}`
  let res: Response
  try {
    res = await fetch(t.url, {
      method: 'POST',
      signal: o.signal,
      headers,
      body: JSON.stringify({
        model: t.model,
        stream: true,
        [t.tokenParam]: o.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: o.system },
          ...o.turns.map((turn) => {
            if (turn.role === 'assistant') return { role: 'assistant', content: turn.text }
            const images = t.vision ? turn.images ?? [] : []
            const note =
              !t.vision && turn.images?.length
                ? '\n\n(Observação: o modelo atual não lê imagens, então a captura de tela não foi incluída.)'
                : ''
            if (!images.length) return { role: 'user', content: (turn.text || '(sem texto)') + note }
            return {
              role: 'user',
              content: [
                ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } })),
                { type: 'text', text: turn.text || '(sem texto)' }
              ]
            }
          })
        ]
      })
    })
  } catch (e) {
    if (t.name === 'Ollama' && !o.signal.aborted) {
      throw new AiConfigError('Não consegui falar com o Ollama. Abra o app Ollama (ou rode `ollama serve`) e baixe o modelo com `ollama pull ' + t.model + '`.')
    }
    throw e
  }
  if (!res.ok && res.status === 404 && t.name === 'Gemini' && !o.retried) {
    // O Google aposenta modelos com frequência: descobre o Flash mais recente, salva e tenta de novo.
    const latest = await latestGeminiFlash(t.key)
    if (latest && latest !== t.model) {
      setSettings({ geminiModel: latest })
      console.warn(`[lumen] modelo Gemini ${t.model} indisponível; usando ${latest}`)
      return streamCompat({ ...t, model: latest }, { ...o, retried: true })
    }
  }
  if (!res.ok) await failure(res, t.name)
  await readSse(res, (ev) => {
    const delta = ev.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) o.onText(delta)
  })
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('Cancelado.'))), { once: true })
  })

async function runProvider(provider: ProviderId, o: StreamOptions): Promise<void> {
  if (provider === 'anthropic') return streamAnthropic(o)
  if (provider === 'ollama') {
    const s = getSettings()
    // Pergunta ao Ollama se o modelo lê imagens e se "pensa" antes de responder.
    const c = await ollamaCapabilities(s.ollamaModel)
    return streamOllamaChat({
      model: s.ollamaModel,
      system: o.system,
      turns: o.turns,
      vision: c.vision || VISION_HINT.test(s.ollamaModel),
      thinking: c.thinking,
      numCtx: s.ollamaContext,
      maxTokens: Math.min(o.maxTokens ?? 1024, 1024),
      signal: o.signal,
      onText: o.onText
    })
  }
  return streamCompat(compatTarget(provider), o)
}

export interface PromptBudget {
  transcriptChars: number
  /** Quanto da transcrição cabe de uma vez para resumos e perguntas sobre a reunião inteira. */
  fullTranscriptChars: number
  docsChars: number
  historyTurns: number
  historyChars: number
  imageMaxSide: number
}

/**
 * Quanto contexto cabe em cada pergunta. Modelos na nuvem aceitam centenas de milhares de tokens;
 * no Ollama a janela é o `num_ctx` configurado, então o Lumen corta transcrição, documentos e
 * histórico para caber (≈3 caracteres por token em português, com folga para a resposta e a imagem).
 */
export function promptBudget(provider: ProviderId = safeProvider(), withImage = false): PromptBudget {
  if (provider !== 'ollama') {
    // Gemini, Claude e OpenAI leem centenas de milhares de tokens; a Groq grátis limita tokens por minuto.
    const full = provider === 'groq' ? 14_000 : provider === 'openai' ? 250_000 : 400_000
    return { transcriptChars: 12_000, fullTranscriptChars: full, docsChars: 60_000, historyTurns: 8, historyChars: 4000, imageMaxSide: 1600 }
  }
  const ctx = getSettings().ollamaContext
  const reserved = 1024 /* resposta */ + 600 /* instruções */ + (withImage ? 1300 : 0)
  const chars = Math.max(1500, (ctx - reserved) * 3)
  return {
    transcriptChars: Math.round(chars * 0.5),
    fullTranscriptChars: Math.round(chars * 0.75),
    docsChars: Math.round(chars * 0.3),
    historyTurns: 4,
    historyChars: Math.round(chars * 0.2 / 4),
    imageMaxSide: 1024
  }
}

function safeProvider(): ProviderId {
  try {
    return activeProvider()
  } catch {
    return getSettings().provider
  }
}

export { ContextOverflowError }

/** Roda num provedor, trocando o modelo aposentado e repetindo em caso de sobrecarga. */
async function runWithRecovery(provider: ProviderId, o: StreamOptions, hasText: () => boolean): Promise<void> {
  // Perguntas ao vivo: até 3 tentativas rápidas. Segundo plano: espera o limite por minuto zerar.
  const delays = o.patient ? [5000, 20_000, 60_000] : [1200, 3000]
  for (let attempt = 0; ; attempt++) {
    // Se o provedor não mandar nem a primeira palavra em 90 s, a tentativa é dada como perdida
    // (uma conexão pendurada não pode prender o resumo ou a resposta para sempre).
    const silence = new AbortController()
    let timer: NodeJS.Timeout | undefined = setTimeout(() => silence.abort(), provider === 'ollama' ? 300_000 : 90_000)
    const attemptOpts: StreamOptions = {
      ...o,
      signal: AbortSignal.any([o.signal, silence.signal]),
      onText: (d) => {
        if (timer) clearTimeout(timer), (timer = undefined)
        o.onText(d)
      }
    }
    try {
      await runProvider(provider, attemptOpts)
      return
    } catch (e) {
      const err = silence.signal.aborted && !o.signal.aborted && !hasText() ? new TransientError(408, provider, 'sem resposta em 90 s') : e
      if (hasText() || o.signal.aborted) throw err
      // Modelo aposentado: troca pelo mais novo e tenta de novo.
      if (err instanceof ModelUnavailableError && (provider === 'gemini' || provider === 'groq')) {
        const key = provider === 'gemini' ? 'geminiModel' : 'groqModel'
        const replacement = await latestModel(provider)
        if (!replacement || replacement === getSettings()[key]) throw err
        console.warn(`[lumen] modelo ${getSettings()[key]} indisponível; usando ${replacement}`)
        setSettings({ [key]: replacement })
        continue
      }
      // Sobrecarga momentânea: espera um pouco e repete.
      if (err instanceof TransientError && attempt < delays.length) {
        console.warn(`[lumen] ${provider} ${err.status}; nova tentativa em ${delays[attempt]}ms`)
        await sleep(delays[attempt], o.signal)
        continue
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Provedor que acabou de falhar por sobrecarga fica de lado por 2 min (vai direto para a reserva). */
const cooldown = new Map<ProviderId, number>()

export async function streamCompletion(o: StreamOptions): Promise<string> {
  let full = ''
  const wrapped = { ...o, onText: (d: string) => ((full += d), o.onText(d)) }
  const primary = activeProvider()
  const backupOf = () => FALLBACK_ORDER.concat('gemini').find((p) => p !== primary && p !== 'ollama' && isConfigured(p))
  const resting = (cooldown.get(primary) ?? 0) > Date.now() && backupOf()
  try {
    if (resting) throw new TransientError(503, primary, 'em pausa após falhas recentes')
    await runWithRecovery(primary, wrapped, () => !!full)
  } catch (err) {
    if (!(err instanceof TransientError) || full || o.signal.aborted) throw err
    if (!resting) cooldown.set(primary, Date.now() + 120_000)
    // Plano B: o provedor continua sobrecarregado; responde por outro que esteja configurado.
    const backup = backupOf()
    if (!backup) {
      throw new Error(`O ${err.provider} está sobrecarregado agora. Tentei 3 vezes; tente de novo em alguns segundos ou configure a Groq como reserva.`)
    }
    console.warn(`[lumen] ${primary} sobrecarregado; respondendo com ${backup}`)
    o.onFallback?.(err.provider, backup)
    await runWithRecovery(backup, wrapped, () => !!full)
  }
  return full
}

/** Lista os modelos do provedor e escolhe o mais novo adequado para o Lumen. */
export async function latestModel(provider: 'gemini' | 'groq'): Promise<string | null> {
  const key = getKey(provider)
  if (!key) return null
  try {
    const base = provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://api.groq.com/openai/v1'
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const { data } = (await res.json()) as { data?: { id: string }[] }
    const ids = (data ?? []).map((m) => m.id.replace(/^models\//, ''))
    if (provider === 'gemini') {
      // Prefere "gemini-X.Y-flash" estável (sem lite/preview/imagem/áudio), com a maior versão.
      const score = (id: string) => {
        const m = /^gemini-(\d+(?:\.\d+)?)-flash(?:-latest)?$/.exec(id)
        return m ? Number(m[1]) : -1
      }
      const best = ids.filter((id) => score(id) >= 0).sort((a, b) => score(b) - score(a))[0]
      return best ?? ids.find((id) => /^gemini-[\d.]+-flash/.test(id) && !/image|tts|audio|live/.test(id)) ?? null
    }
    const prefer = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']
    return prefer.find((p) => ids.includes(p)) ?? ids.find((id) => !/whisper|guard|tts|playai/i.test(id)) ?? null
  } catch {
    return null
  }
}

/** Testa a conexão com um provedor. Usado na tela de configurações. */
export async function testProvider(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
  try {
    if (provider === 'ollama') {
      const base = getSettings().ollamaUrl.replace(/\/+$/, '')
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return { ok: false, message: `Ollama respondeu ${res.status}.` }
      const { models } = (await res.json()) as { models?: { name: string }[] }
      const names = (models ?? []).map((m) => m.name)
      const want = getSettings().ollamaModel
      const has = names.some((n) => n === want || n.startsWith(want + ':'))
      return has
        ? { ok: true, message: `Conectado. Modelo ${want} disponível.` }
        : { ok: false, message: `Ollama conectado, mas o modelo "${want}" não está baixado. Rode: ollama pull ${want}` }
    }
    const key = getKey(provider)
    if (!key) return { ok: false, message: 'Sem chave salva.' }
    let res: Response
    if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      })
    } else {
      const base = {
        openai: 'https://api.openai.com/v1',
        groq: 'https://api.groq.com/openai/v1',
        gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
      }[provider]
      res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } })
    }
    return res.ok ? { ok: true, message: 'Conectado.' } : { ok: false, message: `Falhou (${res.status}). Confira a chave.` }
  } catch (e) {
    return {
      ok: false,
      message: provider === 'ollama' ? 'Ollama não está rodando. Abra o app Ollama.' : (e as Error).message
    }
  }
}
