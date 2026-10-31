import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TranscriptLine } from '@shared/types'
import { getMode, getSession, getSettings, sessionAudioDir, updateSession } from './store'
import { geminiAvailable, transcribeWithGemini } from './geminiAudio'
import { transcribeFile } from './transcribe'
import { echoesOf } from './transcript'

export interface FinalizeProgress {
  done: number
  total: number
}

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

/** Junta trechos curtos e seguidos da mesma pessoa numa fala só (leitura mais natural). */
function mergeAdjacent(lines: TranscriptLine[], gapMs = 1500): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const l of lines) {
    const prev = out.at(-1)
    if (prev && prev.speaker === l.speaker && prev.label === l.label && l.at - prev.at < 60_000 && prev.text.length < 600) {
      const prevEnd = (prev as TranscriptLine & { end?: number }).end ?? prev.at
      if (l.at - prevEnd <= gapMs) {
        prev.text = `${prev.text} ${l.text}`.replace(/\s+/g, ' ')
        ;(prev as TranscriptLine & { end?: number }).end = (l as TranscriptLine & { end?: number }).end ?? l.at
        continue
      }
    }
    out.push({ ...l })
  }
  return out.map(({ id, speaker, text, at, label }) => (label ? { id, speaker, text, at, label } : { id, speaker, text, at }))
}

/**
 * Refaz a transcrição da sessão a partir do áudio completo gravado, com o modelo mais preciso.
 * A transcrição ao vivo fica guardada em `liveTranscript`; se a final falhar, ela continua valendo.
 */
export async function finalizeSession(id: string, onProgress: (p: FinalizeProgress) => void): Promise<{ ok: boolean; error?: string }> {
  const session = getSession(id)
  const parts = [...(session?.audio ?? [])].sort((a, b) => a.startedAt - b.startedAt)
  if (!session || !parts.length) return { ok: false, error: 'Nenhum áudio gravado nesta sessão.' }

  // Vocabulário da sessão (nome do modo e termos do que já foi dito) ajuda nomes próprios e jargões.
  const vocabulary = [getMode(session.modeId).name, session.transcript.slice(-20).map((l) => l.text).join(' ')].join('. ')

  const dir = sessionAudioDir(id)
  const pref = getSettings().finalTranscriber
  // Gemini ouve o áudio e separa quem fala; Whisper só transcreve (sem saber quem é quem).
  const useGemini = pref !== 'whisper' && geminiAvailable() && parts.some((p) => p.wav)
  const lines: (TranscriptLine & { end: number })[] = []
  const known: Record<'me' | 'them', string[]> = { me: [], them: [] }
  let done = 0
  onProgress({ done, total: parts.length })
  try {
    for (const part of parts) {
      if (useGemini && part.wav) {
        const context = lines.slice(-8).map((l) => `${l.label}: ${l.text}`).join(' ')
        const items = await transcribeWithGemini(
          readFileSync(join(dir, part.wav)),
          part.speaker === 'me' ? 'Pessoa' : 'Participante',
          context || vocabulary,
          known[part.speaker]
        )
        items.forEach((it, i) => {
          if (!known[part.speaker].includes(it.speaker)) known[part.speaker].push(it.speaker)
          const at = part.startedAt + it.offsetMs
          const next = items[i + 1]
          lines.push({ id: randomUUID(), speaker: part.speaker, label: it.speaker, text: it.text, at, end: next ? part.startedAt + next.offsetMs : at })
        })
      } else {
        const segments = await transcribeFile(readFileSync(join(dir, part.file)), part.mime, vocabulary)
        for (const seg of segments) {
          lines.push({
            id: randomUUID(),
            speaker: part.speaker,
            text: seg.text,
            at: part.startedAt + Math.round(seg.start * 1000),
            end: part.startedAt + Math.round(seg.end * 1000)
          })
        }
      }
      onProgress({ done: ++done, total: parts.length })
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  // Limpeza: ruídos de uma letra e frases repetidas em sequência.
  for (const l of lines) l.text = collapseRepeats(l.text)
  const kept = lines.filter((l) => !isJunk(l.text))
  lines.length = 0
  lines.push(...kept)

  lines.sort((a, b) => a.at - b.at)
  // Remove o eco: fala dos outros captada também pelo microfone (alto-falantes).
  const echoIds = new Set<string>()
  for (const l of lines) if (l.speaker === 'them') echoesOf(l, lines, 4000).forEach((x) => echoIds.add(x))
  const finalLines = mergeAdjacent(lines.filter((l) => !echoIds.has(l.id)))

  if (!finalLines.length) return { ok: false, error: 'O áudio gravado não tinha fala reconhecível.' }
  updateSession(id, (s) => {
    s.liveTranscript = s.liveTranscript ?? s.transcript
    s.transcript = finalLines
    s.finalized = true
    s.finalEngine = useGemini ? 'gemini' : 'whisper'
  })
  return { ok: true }
}
