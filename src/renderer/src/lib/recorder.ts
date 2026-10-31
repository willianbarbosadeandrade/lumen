import type { Speaker } from '@shared/types'

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

export interface ArchivePart {
  speaker: Speaker
  blob: Blob
  mime: string
  startedAt: number
}

/**
 * Grava o áudio completo (sem cortes de silêncio) em arquivos independentes de até 10 minutos.
 * É desse áudio que sai a transcrição final, mais fiel, feita quando a gravação termina.
 */
export class ArchiveRecorder {
  private rec: MediaRecorder | null = null
  private timer: number | null = null
  private stopped = false
  private mime = pickMime()
  private pending: Promise<void>[] = []

  constructor(
    private stream: MediaStream,
    private speaker: Speaker,
    private onPart: (p: ArchivePart) => Promise<void>
  ) {}

  start(): void {
    this.next()
    this.timer = window.setInterval(() => this.rotate(), ARCHIVE_PART_MS)
  }

  private next(): void {
    if (this.stopped) return
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 48_000 } : undefined)
    const parts: Blob[] = []
    const startedAt = Date.now()
    let resolveDone!: () => void
    this.pending.push(new Promise<void>((r) => (resolveDone = r)))
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data)
    rec.onstop = () => {
      const mime = rec.mimeType || this.mime || 'audio/webm'
      const blob = new Blob(parts, { type: mime })
      const save = blob.size > 2000 ? this.onPart({ speaker: this.speaker, blob, mime, startedAt }) : Promise.resolve()
      void save.catch(() => {}).finally(resolveDone)
    }
    rec.start(1000)
    this.rec = rec
  }

  private rotate(): void {
    if (this.rec?.state === 'recording') this.rec.stop()
    this.next()
  }

  /** Para e espera os arquivos terminarem de ser salvos. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.rec?.state === 'recording') this.rec.stop()
    await Promise.all(this.pending)
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
