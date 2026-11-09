import { getKey, getSettings } from './store'

// Frases que modelos de transcrição costumam "alucinar" em trechos de silêncio ou ruído.
const HALLUCINATIONS = [
  /^obrigad[oa]( por assistir)?[.!]?$/i,
  /^legendas? (pela|por) .*$/i,
  /^(inscreva-se|se inscreva).*$/i,
  /^thanks? for watching[.!]?$/i,
  /^tchau[.!]?$/i,
  /^\.+$/,
  /^♪+$/,
  // Frases que o Whisper inventa com silêncio ou som de fundo (vêm de legendas usadas no treino).
  /субтитр/i,
  /dimatorzok/i,
  /продолжение следует/i,
  /amara\.org/i,
  /^(obrigad[oa] por assistir|thanks? for watching|please subscribe|like and subscribe)[.!]?$/i
]

export const isHallucination = (text: string) => !text.trim() || HALLUCINATIONS.some((r) => r.test(text.trim()))

function provider() {
  const s = getSettings()
  const id = s.transcriptionProvider
  const key = getKey(id)
  if (!key) {
    throw new Error(
      id === 'groq'
        ? 'Configure a chave da Groq para transcrever (Configurações → Transcrição).'
        : 'Configure a chave da OpenAI para transcrever (Configurações → Transcrição).'
    )
  }
  return {
    id,
    key,
    base: id === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1',
    // Português fixo dá resultado bem melhor que "detectar" em trechos curtos.
    language: s.transcriptionLanguage && s.transcriptionLanguage !== 'auto' ? s.transcriptionLanguage : undefined
  }
}

const extOf = (mime: string) => (mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm')

async function post(form: FormData, p: ReturnType<typeof provider>, timeoutMs: number): Promise<any> {
  let res: Response
  try {
    // Sempre com limite de tempo: uma chamada que não responde não pode travar a gravação.
    res = await fetch(`${p.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.key}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error('A transcrição não respondeu a tempo.')
    throw new Error(`Sem conexão com o serviço de transcrição (${(e as Error).message}).`)
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 429) throw new Error('Limite de transcrição atingido no momento. Aguarde um pouco e continue.')
    if (res.status === 401) throw new Error('Chave de transcrição inválida. Confira em Configurações → Transcrição.')
    throw new Error(`Transcrição falhou (${res.status}): ${txt.replace(/\s*[{[].*$/s, '').slice(0, 160)}`)
  }
  return res.json()
}

/**
 * Transcrição ao vivo de um trecho curto. O `context` (final do que já foi dito) ajuda o modelo a
 * manter nomes, termos técnicos e a continuidade da frase.
 */
export async function transcribeChunk(audio: ArrayBuffer, mime: string, context = ''): Promise<string> {
  const p = provider()
  const form = new FormData()
  form.append('file', new Blob([audio], { type: mime }), `chunk.${extOf(mime)}`)
  form.append('model', p.id === 'groq' ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe')
  if (p.language) form.append('language', p.language)
  if (context) form.append('prompt', context.slice(-400))
  form.append('temperature', '0')
  form.append('response_format', 'json')
  const json = (await post(form, p, 45_000)) as { text?: string }
  const text = (json.text ?? '').trim()
  return isHallucination(text) ? '' : text
}

export interface FileSegment {
  start: number // segundos desde o início do arquivo
  end: number
  text: string
}

/**
 * Transcrição final de um arquivo completo, com o modelo mais preciso e marcação de tempo por trecho.
 * Trechos que o próprio modelo marca como provável silêncio são descartados.
 */
export function transcriptionAvailable(): boolean {
  try {
    provider()
    return true
  } catch {
    return false
  }
}

export async function transcribeFile(audio: Buffer, mime: string, vocabulary = ''): Promise<FileSegment[]> {
  const p = provider()
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${extOf(mime)}`)
  // Groq: whisper-large-v3 (o mais preciso, sem a versão "turbo"). OpenAI: whisper-1 devolve os trechos com tempo.
  form.append('model', p.id === 'groq' ? 'whisper-large-v3' : 'whisper-1')
  if (p.language) form.append('language', p.language)
  if (vocabulary) form.append('prompt', vocabulary.slice(0, 400))
  form.append('temperature', '0')
  form.append('response_format', 'verbose_json')
  const json = (await post(form, p, 240_000)) as {
    text?: string
    segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[]
  }
  const segments = json.segments ?? (json.text ? [{ start: 0, end: 0, text: json.text }] : [])
  return segments
    .filter((s) => !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.8))
    .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
    .filter((s) => !isHallucination(s.text))
}
