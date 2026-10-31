import type { TranscriptLine } from '@shared/types'

const normalize = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)

/** Fração das palavras de `a` que também aparecem em `b`. */
function overlap(a: string[], b: string[]): number {
  if (!a.length) return 0
  const set = new Set(b)
  return a.filter((w) => set.has(w)).length / a.length
}

/**
 * Detecta eco: quando a pessoa usa alto-falantes, o microfone também capta a voz dos outros
 * participantes, e a mesma frase chegaria duas vezes (como "Você" e como "Outros").
 * Uma fala do microfone muito parecida com uma fala do sistema dos últimos segundos é descartada.
 */
export function isEcho(candidate: Pick<TranscriptLine, 'speaker' | 'text' | 'at'>, recent: TranscriptLine[], windowMs = 12_000): boolean {
  if (candidate.speaker !== 'me') return false
  const words = normalize(candidate.text)
  if (words.length < 3) return false
  return recent.some(
    (l) => l.speaker === 'them' && Math.abs(l.at - candidate.at) < windowMs && overlap(words, normalize(l.text)) >= 0.7
  )
}

/** Quando o eco chega antes da fala original do sistema, remove a fala do microfone já salva. */
export function echoesOf(systemLine: Pick<TranscriptLine, 'text' | 'at'>, recent: TranscriptLine[], windowMs = 12_000): string[] {
  const words = normalize(systemLine.text)
  if (words.length < 3) return []
  return recent
    .filter((l) => l.speaker === 'me' && Math.abs(l.at - systemLine.at) < windowMs && overlap(normalize(l.text), words) >= 0.7)
    .map((l) => l.id)
}
