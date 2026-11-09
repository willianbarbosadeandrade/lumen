import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AudioPart, FinalizeStatus, Session, TranscriptLine } from '@shared/types'
import { getMode, getSession, getSettings, sessionAudioDir, updateSession } from './store'
import { geminiAvailable, transcribeWithGemini } from './geminiAudio'
import { transcribeFile, transcriptionAvailable } from './transcribe'
import { echoesOf } from './transcript'
import { log } from './log'

const PART_MS = 5 * 60 * 1000

/** Remove frases repetidas em sequência ("Mais fácil. Mais fácil.") — típico de transcrição automática. */
export function collapseRepeats(text: string): string {
  const sentences = text.split(/(?<=[.!?…])\s+/)
  const out: string[] = []
  for (const sentence of sentences) {
    const norm = sentence.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()
    const prev = out.at(-1)?.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()
    if (norm && norm === prev) continue
    out.push(sentence)
  }
  return out.join(' ').trim()
}

/** Descarta "falas" que são só ruído: uma letra, um som solto, pontuação. */
export function isJunk(text: string): boolean {
  const t = text.replace(/[^\p{L}\p{N}]/gu, '')
  return t.length < 3 || /^(h+m+|a+h+|e+h+|u+m+|o+|a+)$/i.test(t)
}

type Line = TranscriptLine & { end: number }

/** Junta trechos curtos e seguidos da mesma pessoa numa fala só (leitura mais natural). */
export function mergeAdjacent(lines: Line[], gapMs = 1500): TranscriptLine[] {
  const out: Line[] = []
  for (const l of lines) {
    const prev = out.at(-1)
    if (prev && prev.speaker === l.speaker && prev.label === l.label && l.at - prev.at < 60_000 && prev.text.length < 600 && l.at - prev.end <= gapMs) {
      prev.text = `${prev.text} ${l.text}`.replace(/\s+/g, ' ')
      prev.end = l.end
      continue
    }
    out.push({ ...l })
  }
  return out.map(({ id, speaker, text, at, label }) => (label ? { id, speaker, text, at, label } : { id, speaker, text, at }))
}

/** Resultado de uma parte, guardado em disco para não refazer o que já deu certo. */
interface PartResult {
  engine: 'gemini' | 'whisper'
  lines: { label?: string; text: string; offsetMs: number; endMs: number }[]
}

const cacheFile = (dir: string, part: AudioPart) => join(dir, `${part.file}.final.json`)

/** Intervalo de tempo coberto por uma parte (para usar a transcrição ao vivo quando a revisão falha). */
function partWindow(part: AudioPart, parts: AudioPart[], session: Session): [number, number] {
  const next = parts.find((p) => p.speaker === part.speaker && p.startedAt > part.startedAt)
  // Sem a duração registrada (gravações antigas), a parte vai até a próxima ou até 5 min.
  const end = part.durationMs ? part.startedAt + part.durationMs : next?.startedAt ?? part.startedAt + PART_MS
  return [part.startedAt, session.endedAt ? Math.min(end, session.endedAt + 1000) : end]
}

async function transcribePart(dir: string, part: AudioPart, context: string, known: string[], useGemini: boolean): Promise<PartResult> {
  const errors: string[] = []
  const wavPath = part.wav ? join(dir, part.wav) : null
  if (useGemini && wavPath && existsSync(wavPath)) {
    try {
      const items = await transcribeWithGemini(readFileSync(wavPath), part.speaker === 'me' ? 'Pessoa' : 'Participante', context, known)
      return {
        engine: 'gemini',
        lines: items.map((it, i) => ({
          label: it.speaker,
          text: it.text,
          offsetMs: it.offsetMs,
          endMs: items[i + 1]?.offsetMs ?? it.offsetMs
        }))
      }
    } catch (e) {
      errors.push(`Gemini: ${(e as Error).message}`)
    }
  }
  if (transcriptionAvailable()) {
    try {
      const segments = await transcribeFile(readFileSync(join(dir, part.file)), part.mime, context)
      return {
        engine: 'whisper',
        lines: segments.map((s) => ({ text: s.text, offsetMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000) }))
      }
    } catch (e) {
      errors.push(`Whisper: ${(e as Error).message}`)
    }
  } else if (!useGemini) {
    errors.push('nenhuma chave de transcrição configurada (Gemini, Groq ou OpenAI)')
  }
  throw new Error(errors.join(' · ') || 'nenhum serviço de transcrição disponível')
}

// ---------- Controle das revisões em andamento ----------
const statuses = new Map<string, FinalizeStatus>()
const running = new Set<string>()

export function finalizeStatuses(): FinalizeStatus[] {
  return [...statuses.values()]
}

/**
 * Refaz a transcrição da sessão a partir do áudio completo, parte por parte (5 min cada):
 * Gemini (identifica quem fala) → Whisper → trecho da transcrição ao vivo.
 * Nunca é tudo-ou-nada: cada parte que dá certo é salva; as que falham ficam com a versão ao vivo
 * e podem ser refeitas depois (só elas). A transcrição ao vivo original fica em `liveTranscript`.
 */
export async function finalizeSession(id: string, opts: { force?: boolean; onStatus?: (s: FinalizeStatus) => void } = {}): Promise<FinalizeStatus> {
  const emit = (s: FinalizeStatus) => {
    statuses.set(id, s)
    opts.onStatus?.(s)
    return s
  }
  if (running.has(id)) return statuses.get(id)!
  const session = getSession(id)
  const dir = sessionAudioDir(id)
  const parts = [...(session?.audio ?? [])]
    .filter((p) => (statSync(join(dir, p.file), { throwIfNoEntry: false })?.size ?? 0) > 2000)
    .sort((a, b) => a.startedAt - b.startedAt || a.speaker.localeCompare(b.speaker))
  if (!session || !parts.length) return emit({ sessionId: id, state: 'failed', done: 0, total: 0, error: 'nenhum áudio gravado nesta sessão' })

  running.add(id)
  try {
    const live = session.liveTranscript ?? session.transcript
    const pref = getSettings().finalTranscriber
    const useGemini = pref !== 'whisper' && geminiAvailable()
    const vocabulary = getMode(session.modeId).name
    const lines: Line[] = []
    const known: Record<'me' | 'them', string[]> = { me: [], them: [] }
    let done = 0
    let fallbackParts = 0
    const engines = new Set<string>()
    const errors: string[] = []
    emit({ sessionId: id, state: 'running', done, total: parts.length })
    log.info(`[finalize] ${id}: ${parts.length} partes, gemini=${useGemini}, whisper=${transcriptionAvailable()}`)

    for (const part of parts) {
      const cache = cacheFile(dir, part)
      let result: PartResult | null = null
      if (!opts.force && existsSync(cache)) {
        try {
          result = JSON.parse(readFileSync(cache, 'utf8')) as PartResult
        } catch {
          result = null
        }
      }
      if (!result) {
        const context = lines.filter((l) => l.speaker === part.speaker).slice(-8).map((l) => l.text).join(' ') || vocabulary
        try {
          result = await transcribePart(dir, part, context, known[part.speaker], useGemini)
          writeFileSync(cache, JSON.stringify(result))
          log.info(`[finalize] ${part.file}: ${result.engine}, ${result.lines.length} falas`)
        } catch (e) {
          const msg = (e as Error).message
          errors.push(msg)
          log.warn(`[finalize] ${part.file}: falhou (${msg}); usando a transcrição ao vivo deste trecho`)
        }
      }
      if (result) {
        engines.add(result.engine)
        for (const l of result.lines) {
          if (l.label && !known[part.speaker].includes(l.label)) known[part.speaker].push(l.label)
          lines.push({ id: randomUUID(), speaker: part.speaker, label: l.label, text: l.text, at: part.startedAt + l.offsetMs, end: part.startedAt + l.endMs })
        }
      } else {
        // Sem revisão para este trecho: fica valendo o que foi transcrito ao vivo.
        fallbackParts++
        const [from, to] = partWindow(part, parts, session)
        for (const l of live) if (l.speaker === part.speaker && l.at >= from && l.at < to) lines.push({ ...l, id: randomUUID(), end: l.at })
      }
      emit({ sessionId: id, state: 'running', done: ++done, total: parts.length, fallbackParts })
    }

    // Fala ao vivo registrada depois da última parte de áudio (ex.: a parte final se perdeu).
    for (const speaker of ['me', 'them'] as const) {
      const own = parts.filter((p) => p.speaker === speaker)
      if (!own.length) {
        // Sem áudio guardado desta fonte: mantém tudo o que foi transcrito ao vivo dela.
        for (const l of live) if (l.speaker === speaker) lines.push({ ...l, id: randomUUID(), end: l.at })
        continue
      }
      const lastEnd = Math.max(...own.map((p) => partWindow(p, parts, session)[1]))
      for (const l of live) if (l.speaker === speaker && l.at >= lastEnd) lines.push({ ...l, id: randomUUID(), end: l.at })
    }

    for (const l of lines) l.text = collapseRepeats(l.text)
    const kept = lines.filter((l) => !isJunk(l.text)).sort((a, b) => a.at - b.at)
    // Remove o eco: fala dos outros captada também pelo microfone (alto-falantes).
    const echoIds = new Set<string>()
    for (const l of kept) if (l.speaker === 'them') echoesOf(l, kept, 8000).forEach((x) => echoIds.add(x))
    const finalLines = mergeAdjacent(kept.filter((l) => !echoIds.has(l.id)))

    if (fallbackParts === parts.length) {
      updateSession(id, (s) => {
        s.finalState = 'failed'
        s.finalError = errors[0]
      })
      return emit({ sessionId: id, state: 'failed', done, total: parts.length, fallbackParts, error: errors[0] })
    }
    const state = fallbackParts ? 'partial' : 'done'
    updateSession(id, (s) => {
      s.liveTranscript = s.liveTranscript ?? s.transcript
      s.transcript = finalLines
      s.finalized = true
      s.finalEngine = engines.has('gemini') ? 'gemini' : 'whisper'
      s.finalState = state
      s.finalError = fallbackParts ? errors[0] : undefined
    })
    return emit({ sessionId: id, state, done, total: parts.length, fallbackParts, error: fallbackParts ? errors[0] : undefined })
  } catch (e) {
    log.error('[finalize] erro inesperado', e)
    return emit({ sessionId: id, state: 'failed', done: 0, total: parts.length, error: (e as Error).message })
  } finally {
    running.delete(id)
  }
}
