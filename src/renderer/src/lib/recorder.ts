import type { Speaker } from '@shared/types'
import { toWav16k } from './wav'

export interface Chunk {
  speaker: Speaker
  blob: Blob
  mime: string
  startedAt: number
}

// Trechos ao vivo maiores dão mais contexto ao modelo de transcrição (menos palavras trocadas).
const MIN_SEGMENT_MS = 3000
const MAX_SEGMENT_MS = 25000
const SILENCE_CUT_MS = 1200
const DISCARD_SILENT_MS = 8000
// Arquivos da gravação completa: um arquivo independente a cada 5 minutos (cabe num pedido ao Gemini).
const ARCHIVE_PART_MS = 5 * 60 * 1000

export function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

interface Segment {
  rec: MediaRecorder
  parts: Blob[]
  voiced: boolean
  startedAt: number
}

/**
 * Grava um MediaStream em trechos que terminam em pausas naturais da fala (para a transcrição ao vivo).
 * Trechos sem voz são descartados antes de ir para a API.
 */
export class SpeechChunker {
  private ctx: AudioContext
  private analyser: AnalyserNode
  private buf: Float32Array<ArrayBuffer>
  private seg: Segment | null = null
  private timer: number | null = null
  private lastVoice = 0
  private stopped = false
  private mime = pickMime()
  level = 0

  constructor(
    private stream: MediaStream,
    private speaker: Speaker,
    private threshold: number,
    private onChunk: (c: Chunk) => void
  ) {
    this.ctx = new AudioContext()
    const src = this.ctx.createMediaStreamSource(stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.buf = new Float32Array(this.analyser.fftSize)
    src.connect(this.analyser)
  }

  setThreshold(t: number): void {
    this.threshold = t
  }

  start(): void {
    this.startSegment()
    this.timer = window.setInterval(() => this.tick(), 100)
  }

  private startSegment(): void {
    if (this.stopped) return
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined)
    const seg: Segment = { rec, parts: [], voiced: false, startedAt: Date.now() }
    rec.ondataavailable = (e) => e.data.size && seg.parts.push(e.data)
    rec.onstop = () => {
      if (seg.voiced && seg.parts.length) {
        const mime = rec.mimeType || this.mime || 'audio/webm'
        this.onChunk({ speaker: this.speaker, blob: new Blob(seg.parts, { type: mime }), mime, startedAt: seg.startedAt })
      }
    }
    rec.start()
    this.seg = seg
    this.lastVoice = seg.startedAt
  }

  private rms(): number {
    this.analyser.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    return Math.sqrt(sum / this.buf.length)
  }

  private tick(): void {
    const seg = this.seg
    if (!seg) return
    const now = Date.now()
    const r = this.rms()
    this.level = Math.min(1, r * 12)
    if (r > this.threshold) {
      this.lastVoice = now
      seg.voiced = true
    }
    const age = now - seg.startedAt
    const silentFor = now - this.lastVoice
    const cut =
      (seg.voiced && silentFor > SILENCE_CUT_MS && age > MIN_SEGMENT_MS) ||
      age > MAX_SEGMENT_MS ||
      (!seg.voiced && age > DISCARD_SILENT_MS)
    if (cut && seg.rec.state === 'recording') {
      seg.rec.stop()
      this.startSegment()
    }
  }

  /** Encerra e entrega o trecho em andamento. Não fecha o stream (quem abriu é quem fecha). */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.seg?.rec.state === 'recording') this.seg.rec.stop()
    void this.ctx.close().catch(() => {})
  }
}

/** Onde o ArchiveRecorder grava: o processo principal escreve os arquivos no disco. */
export interface ArchiveSink {
  begin(p: { speaker: Speaker; startedAt: number; mime: string }): Promise<string>
  append(file: string, data: ArrayBuffer): Promise<void>
  finish(file: string, wav: ArrayBuffer | undefined, durationMs: number): Promise<void>
  log(message: string): void
}

/**
 * Grava o áudio completo (sem cortes de silêncio) em arquivos independentes de 5 minutos.
 * Cada segundo gravado vai direto para o disco: se o app travar, fechar ou a barra cair,
 * no máximo 1–2 segundos se perdem. No fim de cada parte, gera o WAV 16 kHz usado na
 * transcrição final (se falhar, a transcrição final usa o arquivo original).
 */
export class ArchiveRecorder {
  private rec: MediaRecorder | null = null
  private timer: number | null = null
  private stopped = false
  private mime = pickMime()
  private pending: Promise<void>[] = []
  private writeErrors = 0

  constructor(
    private stream: MediaStream,
    private speaker: Speaker,
    private sink: ArchiveSink
  ) {}

  start(): void {
    this.next()
    this.timer = window.setInterval(() => this.rotate(), ARCHIVE_PART_MS)
  }

  private next(): void {
    if (this.stopped) return
    const mime = this.mime || 'audio/webm'
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 48_000 } : undefined)
    const parts: Blob[] = []
    const startedAt = Date.now()
    // Escritas em ordem: primeiro registra a parte, depois anexa cada pedaço na sequência.
    let writes: Promise<unknown> = this.sink.begin({ speaker: this.speaker, startedAt, mime })
    const file = writes as Promise<string>
    let resolveDone!: () => void
    this.pending.push(new Promise<void>((r) => (resolveDone = r)))
    rec.ondataavailable = (e) => {
      if (!e.data.size) return
      parts.push(e.data)
      const data = e.data
      writes = writes.then(async () => this.sink.append(await file, await data.arrayBuffer())).catch((err) => {
        if (this.writeErrors++ < 5) this.sink.log(`falha ao gravar áudio (${this.speaker}): ${(err as Error)?.message ?? err}`)
      })
    }
    rec.onerror = (e) => this.sink.log(`MediaRecorder (${this.speaker}) erro: ${String((e as ErrorEvent).error ?? e.type)}`)
    rec.onstop = () => {
      const durationMs = Date.now() - startedAt
      const blob = new Blob(parts, { type: rec.mimeType || mime })
      void writes
        .then(async () => {
          if (blob.size < 2000) return
          // O WAV é um extra: se a conversão falhar ou demorar, o arquivo original já está salvo.
          const wav = await withTimeout(toWav16k(blob), 60_000, 'conversão WAV demorou demais').catch((err) => {
            this.sink.log(`WAV não gerado (${this.speaker}): ${(err as Error)?.message ?? err}`)
            return undefined
          })
          await this.sink.finish(await file, wav, durationMs)
        })
        .catch((err) => this.sink.log(`falha ao fechar parte (${this.speaker}): ${(err as Error)?.message ?? err}`))
        .finally(resolveDone)
    }
    rec.start(1000)
    this.rec = rec
  }

  private rotate(): void {
    if (this.rec?.state === 'recording') this.rec.stop()
    this.next()
  }

  /** Para e espera os arquivos terminarem de ser salvos (no máximo `maxWaitMs`). */
  async stop(maxWaitMs = 20_000): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.rec?.state === 'recording') {
      // Pede o último pedaço antes de parar, para ele ir para o disco junto.
      try {
        this.rec.requestData()
      } catch {
        /* já parado */
      }
      this.rec.stop()
    }
    await withTimeout(Promise.all(this.pending), maxWaitMs, 'salvamento do áudio demorou').catch((e) => this.sink.log(String(e?.message ?? e)))
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))])
}

export async function micStream(): Promise<MediaStream> {
  return withTimeout(
    navigator.mediaDevices.getUserMedia({
      // Sem redução de ruído: ela abafa a voz de quem está mais longe do microfone (ex.: do outro lado da mesa).
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
    }),
    8000,
    'O microfone não respondeu'
  )
}

/**
 * Abre o áudio do sistema (o que os outros falam na chamada). Tem limite de tempo:
 * se o macOS não liberar, a gravação segue só com o microfone em vez de travar.
 */
export async function systemAudioStream(): Promise<MediaStream> {
  await window.lumen.audio.enableLoopback()
  let stream: MediaStream | undefined
  const request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  try {
    stream = await withTimeout(request, 5000, 'O áudio do sistema não respondeu')
    stream.getVideoTracks().forEach((t) => {
      t.stop()
      stream!.removeTrack(t)
    })
    if (!stream.getAudioTracks().length) throw new Error('Sem trilha de áudio do sistema')
    return stream
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop())
    // Se o macOS liberar depois do limite, fecha o stream atrasado para não deixar captura aberta.
    void request.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => {})
    throw e
  } finally {
    await window.lumen.audio.disableLoopback().catch(() => {})
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop())
}
