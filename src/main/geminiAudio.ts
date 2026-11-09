import { getKey, getSettings, setSettings } from './store'
import { latestGeminiFlash } from './ai'

export interface DiarizedLine {
  speaker: string // "Pessoa 1", "Pessoa 2"…
  offsetMs: number // a partir do início do arquivo
  text: string
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      speaker: { type: 'STRING', description: 'Rótulo de quem fala, ex.: "Pessoa 1"' },
      start: { type: 'STRING', description: 'Início da fala no áudio, formato mm:ss' },
      text: { type: 'STRING', description: 'Exatamente o que foi dito' }
    },
    required: ['speaker', 'start', 'text']
  }
}

const parseClock = (t: string) => {
  const parts = t.split(':').map((x) => Number(x) || 0)
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts.slice(-2)]
  return ((h * 60 + m) * 60 + s) * 1000
}

export function geminiAvailable(): boolean {
  return !!getKey('gemini')
}

/**
 * Transcreve um arquivo WAV com o Gemini, que ouve o áudio e separa as vozes.
 * `prefix` define o rótulo ("Pessoa" para o microfone, "Participante" para a chamada).
 * `knownSpeakers` mantém a numeração coerente entre um arquivo e o próximo.
 */
export async function transcribeWithGemini(
  wav: Buffer,
  prefix: 'Pessoa' | 'Participante',
  context: string,
  knownSpeakers: string[]
): Promise<DiarizedLine[]> {
  const key = getKey('gemini')
  if (!key) throw new Error('Sem chave do Gemini')
  const s = getSettings()
  const lang = s.transcriptionLanguage && s.transcriptionLanguage !== 'auto' ? s.transcriptionLanguage : null
  const instructions = [
    lang
      ? `Transcreva este áudio (idioma principal: ${lang === 'pt' ? 'português do Brasil' : lang}) palavra por palavra.`
      : 'Transcreva este áudio palavra por palavra, no idioma em que cada pessoa fala (a conversa pode misturar idiomas).',
    '- NÃO traduza: escreva cada fala exatamente no idioma em que foi dita.',
    'Regras:',
    '- Não resuma, não corrija o sentido e não invente nada. Se não der para entender, escreva [inaudível].',
    `- Identifique cada pessoa pela voz e rotule como "${prefix} 1", "${prefix} 2" etc. Pessoas diferentes falando no mesmo microfone devem ter rótulos diferentes.`,
    knownSpeakers.length
      ? `- Já identificados antes neste mesmo encontro: ${knownSpeakers.join(', ')}. Reutilize o mesmo rótulo quando reconhecer a mesma voz.`
      : '',
    '- Cada item é uma fala contínua de uma pessoa. Quando outra pessoa começar a falar, crie um novo item.',
    '- "start" é o momento em que a fala começa no áudio (mm:ss).',
    '- Ignore ruídos, música e silêncio. Se não houver fala, devolva uma lista vazia.',
    context ? `Contexto do que foi dito antes (só para manter nomes e termos; não repita): ${context.slice(-600)}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [{ inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }, { text: instructions }]
      }
    ],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA }
  })

  // Repete em caso de sobrecarga momentânea (o Gemini grátis às vezes responde 503).
  const delays = [2000, 5000, 10000]
  let model = s.geminiModel
  let discovered = false
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      // Um arquivo de 5 min leva de 20 s a 2 min; sem resposta em 4 min, desiste desta parte.
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(240_000)
      })
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new Error('o Gemini não respondeu em 4 minutos')
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]))
        continue
      }
      throw new Error(`sem conexão com o Gemini (${(e as Error).message})`)
    }
    if (res.ok) {
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '[]'
      let items: { speaker?: string; start?: string; text?: string }[] = []
      try {
        items = JSON.parse(raw)
      } catch {
        throw new Error('o Gemini devolveu a transcrição em formato inesperado')
      }
      return items
        .filter((i) => i.text?.trim())
        .map((i) => ({ speaker: (i.speaker || `${prefix} 1`).trim(), offsetMs: parseClock(i.start || '0:00'), text: i.text!.trim() }))
    }
    if (res.status === 404 && !discovered) {
      // Modelo aposentado: descobre o Flash mais recente e tenta de novo.
      discovered = true
      const latest = await latestGeminiFlash(key)
      if (latest && latest !== model) {
        model = latest
        setSettings({ geminiModel: latest })
        continue
      }
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < delays.length) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000
      await new Promise((r) => setTimeout(r, Math.min(60_000, retryAfter || delays[attempt])))
      continue
    }
    const detail = await res.text().catch(() => '')
    throw new Error(`Gemini respondeu ${res.status}: ${detail.replace(/\s*[{[].*$/s, '').slice(0, 160)}`)
  }
}
