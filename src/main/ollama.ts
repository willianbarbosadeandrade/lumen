import { getSettings } from './store'

export interface OllamaModel {
  name: string
  sizeGB: number
  params?: string
  vision: boolean
  thinking: boolean
}

const caps = new Map<string, { vision: boolean; thinking: boolean }>()

const base = () => getSettings().ollamaUrl.replace(/\/+$/, '')

async function show(name: string): Promise<{ vision: boolean; thinking: boolean }> {
  const cached = caps.get(name)
  if (cached) return cached
  let result = { vision: false, thinking: false }
  try {
    const res = await fetch(`${base()}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(4000)
    })
    if (res.ok) {
      const j = (await res.json()) as { capabilities?: string[]; projector_info?: unknown }
      const c = j.capabilities ?? []
      result = { vision: c.includes('vision') || !!j.projector_info, thinking: c.includes('thinking') }
    }
  } catch {
    /* Ollama antigo ou fora do ar: assume só texto */
  }
  caps.set(name, result)
  return result
}

/** Modelos instalados no Ollama, com o que cada um sabe fazer. */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}`)
  const { models } = (await res.json()) as {
    models?: { name: string; size: number; details?: { parameter_size?: string } }[]
  }
  return Promise.all(
    (models ?? []).map(async (m) => ({
      name: m.name,
      sizeGB: Math.round((m.size / 1e9) * 10) / 10,
      params: m.details?.parameter_size,
      ...(await show(m.name))
    }))
  )
}

export async function ollamaCapabilities(model: string): Promise<{ vision: boolean; thinking: boolean }> {
  const direct = await show(model)
  if (direct.vision || direct.thinking || model.includes(':')) return direct
  return show(`${model}:latest`)
}

/**
 * Remove blocos <think>…</think> do streaming (modelos de raciocínio como qwen3 e deepseek-r1),
 * para que só a resposta final apareça na barra.
 */
export function thinkFilter(emit: (text: string) => void): (chunk: string) => void {
  let inThink = false
  let buf = ''
  return (chunk) => {
    buf += chunk
    for (;;) {
      if (inThink) {
        const end = buf.indexOf('</think>')
        if (end < 0) {
          buf = buf.slice(-8) // guarda o suficiente para achar a tag quebrada entre pedaços
          return
        }
        buf = buf.slice(end + 8).replace(/^\s+/, '')
        inThink = false
      } else {
        const start = buf.indexOf('<think>')
        if (start < 0) {
          // segura um possível começo de tag no fim do pedaço
          const keep = buf.lastIndexOf('<')
          if (keep >= 0 && '<think>'.startsWith(buf.slice(keep))) {
            if (keep > 0) emit(buf.slice(0, keep))
            buf = buf.slice(keep)
          } else {
            if (buf) emit(buf)
            buf = ''
          }
          return
        }
        if (start > 0) emit(buf.slice(0, start))
        buf = buf.slice(start + 7)
        inThink = true
      }
    }
  }
}

export class ContextOverflowError extends Error {}

export interface OllamaChatOptions {
  model: string
  system: string
  turns: { role: 'user' | 'assistant'; text: string; images?: { base64: string }[] }[]
  vision: boolean
  thinking: boolean
  numCtx: number
  maxTokens: number
  signal: AbortSignal
  onText: (delta: string) => void
}

/**
 * Conversa pela API nativa do Ollama (/api/chat). Diferente da rota compatível com OpenAI,
 * ela aceita `num_ctx` (tamanho da memória de contexto, que por padrão é só 4096 tokens),
 * `keep_alive` (mantém o modelo carregado entre perguntas) e `think` (desliga o raciocínio longo).
 */
export async function streamOllamaChat(o: OllamaChatOptions): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${base()}/api/chat`, {
      method: 'POST',
      signal: o.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: o.model,
        stream: true,
        keep_alive: '30m',
        ...(o.thinking ? { think: false } : {}),
        options: { num_ctx: o.numCtx, num_predict: o.maxTokens },
        messages: [
          { role: 'system', content: o.system },
          ...o.turns.map((t) => ({
            role: t.role,
            content: t.text || '(sem texto)',
            ...(o.vision && t.images?.length ? { images: t.images.map((i) => i.base64) } : {})
          }))
        ]
      })
    })
  } catch (e) {
    if (o.signal.aborted) throw e
    throw new OllamaOfflineError(o.model)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (/context|n_ctx|exceed/i.test(detail)) throw new ContextOverflowError(detail.slice(0, 200))
    if (res.status === 404 || /not found|pull/i.test(detail)) throw new OllamaModelMissingError(o.model)
    throw new Error(`Ollama respondeu ${res.status}: ${detail.slice(0, 200)}`)
  }
  if (!res.body) throw new Error('Ollama respondeu sem conteúdo')
  const emit = o.thinking ? thinkFilter(o.onText) : o.onText
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let ev: { message?: { content?: string }; error?: string }
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.error) {
        if (/context|exceed/i.test(ev.error)) throw new ContextOverflowError(ev.error)
        throw new Error(`Ollama: ${ev.error}`)
      }
      if (ev.message?.content) emit(ev.message.content)
    }
  }
}

export class OllamaOfflineError extends Error {
  constructor(model: string) {
    super(`O Ollama não está respondendo. Abra o app Ollama e tente de novo (modelo: ${model}).`)
  }
}

export class OllamaModelMissingError extends Error {
  constructor(model: string) {
    super(`O modelo "${model}" não está instalado no Ollama. Escolha outro em Configurações ou rode: ollama pull ${model}`)
  }
}

/** Página de download do Ollama certa para o sistema do usuário. */
export function ollamaDownloadInfo(): { url: string; command?: string; label: string } {
  if (process.platform === 'win32') return { url: 'https://ollama.com/download/windows', label: 'Baixar Ollama para Windows' }
  if (process.platform === 'darwin') return { url: 'https://ollama.com/download/mac', label: 'Baixar Ollama para macOS' }
  return {
    url: 'https://ollama.com/download/linux',
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
    label: 'Instalar Ollama no Linux'
  }
}

export async function ollamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/** Modelos sugeridos para baixar, do mais leve ao mais completo. */
export const SUGGESTED_OLLAMA_MODELS = [
  { name: 'gemma3:4b', size: '3,3 GB', note: 'Rápido e lê a tela. Bom para a maioria dos computadores (8 GB de RAM).' },
  { name: 'qwen2.5vl:7b', size: '6 GB', note: 'Lê a tela com mais precisão. Recomendado com 16 GB de RAM.' },
  { name: 'qwen2.5:3b', size: '1,9 GB', note: 'Só texto, muito leve. Para computadores mais simples.' }
]

/**
 * Baixa um modelo pelo próprio Lumen (POST /api/pull), informando o progresso.
 * Assim o usuário não precisa abrir o Terminal.
 */
export async function pullOllamaModel(
  name: string,
  onProgress: (p: { status: string; percent?: number }) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${base()}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal
  })
  if (!res.ok || !res.body) throw new Error(`O Ollama não conseguiu baixar ${name} (${res.status}).`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let ev: { status?: string; total?: number; completed?: number; error?: string }
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.error) throw new Error(`Ollama: ${ev.error}`)
      const percent = ev.total && ev.completed ? Math.round((ev.completed / ev.total) * 100) : undefined
      onProgress({ status: ev.status ?? '', percent })
    }
  }
  caps.delete(name)
}
