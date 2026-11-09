/**
 * Transcrição no computador, num processo separado (Electron utilityProcess): o trabalho pesado
 * (separar as vozes e rodar o Whisper) nunca trava a barra nem o resto do app.
 *
 * Para cada arquivo WAV (16 kHz, mono):
 *  1. separa os trechos de fala por voz (pyannote + impressão de voz titanet);
 *  2. reconhece a mesma pessoa entre as partes da gravação comparando a impressão de voz,
 *     para "Pessoa 1" ser a mesma do começo ao fim;
 *  3. transcreve cada trecho com o Whisper (turbo).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SttInit {
  modelsDir: string
  threads: number
}

export interface SttRequest {
  wavPath: string
  prefix: 'Pessoa' | 'Participante'
  /** Código do idioma ("pt", "en") ou vazio para detectar a cada trecho. */
  language: string
  /** Número de pessoas, se conhecido (0 = automático). */
  numSpeakers: number
}

export interface SttLine {
  label: string
  start: number
  end: number
  text: string
}

export interface SttSpeaker {
  label: string
  embedding: number[]
}

export interface SttResult {
  lines: SttLine[]
  /** Impressão de voz de cada pessoa desta parte (guardada para reconhecer a pessoa em partes futuras). */
  speakers: SttSpeaker[]
  seconds: number
}

const MAX_CHUNK = 28 // o Whisper ouve até 30 s de cada vez
const SAME_PERSON = 0.5 // semelhança mínima entre impressões de voz para ser a mesma pessoa

export const MODEL_FILES = {
  encoder: 'turbo-encoder.int8.onnx',
  decoder: 'turbo-decoder.int8.onnx',
  tokens: 'turbo-tokens.txt',
  segmentation: 'pyannote-segmentation-3-0.onnx',
  embedding: 'nemo_en_titanet_small.onnx'
} as const

export class LocalTranscriber {
  private so: any
  private recognizer: any = null
  private diarizer: any = null
  private extractor: any = null
  private recognizerConfig: any = null
  private language = ''
  private managers = new Map<string, any>()
  private counters = new Map<string, number>()

  constructor(private init: SttInit) {
    this.so = require('sherpa-onnx-node')
  }

  private path(name: keyof typeof MODEL_FILES): string {
    const p = join(this.init.modelsDir, MODEL_FILES[name])
    if (!existsSync(p)) throw new Error(`modelo ausente: ${MODEL_FILES[name]}`)
    return p
  }

  private async load(): Promise<void> {
    if (this.recognizer) return
    const threads = this.init.threads
    this.extractor = new this.so.SpeakerEmbeddingExtractor({ model: this.path('embedding'), numThreads: threads })
    this.diarizer = new this.so.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: this.path('segmentation') }, numThreads: threads },
      embedding: { model: this.path('embedding'), numThreads: threads },
      clustering: { numClusters: -1, threshold: 1.0 },
      minDurationOn: 0.3,
      minDurationOff: 0.5
    })
    this.recognizerConfig = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: this.path('encoder'), decoder: this.path('decoder'), language: '', task: 'transcribe' },
        tokens: this.path('tokens'),
        numThreads: threads,
        provider: 'cpu'
      }
    }
    this.recognizer = await this.so.OfflineRecognizer.createAsync(this.recognizerConfig)
  }

  /** Idioma fixo (ex.: "pt") ou vazio para o Whisper detectar em cada trecho. */
  private setLanguage(language: string): void {
    if (language === this.language) return
    this.language = language
    const c = this.recognizerConfig
    c.modelConfig.whisper.language = language
    this.recognizer.setConfig(c)
  }

  private manager(prefix: string): any {
    let m = this.managers.get(prefix)
    if (!m) {
      m = new this.so.SpeakerEmbeddingManager(this.extractor.dim)
      this.managers.set(prefix, m)
    }
    return m
  }

  /** Volta ao zero: uma nova sessão tem pessoas novas. */
  reset(): void {
    this.managers.clear()
    this.counters.clear()
  }

  /** Reapresenta pessoas já identificadas (partes revisadas antes) para manter os mesmos nomes. */
  async seed(prefix: string, speakers: SttSpeaker[]): Promise<void> {
    await this.load()
    const m = this.manager(prefix)
    for (const s of speakers) {
      if (!m.contains(s.label)) m.add({ name: s.label, v: Float32Array.from(s.embedding) })
      const n = Number(s.label.match(/(\d+)$/)?.[1] ?? 0)
      this.counters.set(prefix, Math.max(this.counters.get(prefix) ?? 0, n))
    }
  }

  private embed(samples: Float32Array): Float32Array | null {
    const stream = this.extractor.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    stream.inputFinished()
    if (!this.extractor.isReady(stream)) return null
    // false: o Electron não aceita buffers externos de módulos nativos
    return Float32Array.from(this.extractor.compute(stream, false))
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    await this.load()
    this.setLanguage(req.language)
    const wave = this.so.readWave(req.wavPath, false)
    if (wave.sampleRate !== 16000) throw new Error(`áudio em ${wave.sampleRate} Hz (esperado 16 kHz)`)
    const samples: Float32Array = wave.samples
    const seconds = samples.length / 16000

    this.diarizer.setConfig({ clustering: { numClusters: req.numSpeakers > 0 ? req.numSpeakers : -1, threshold: 1.0 } })
    const segs: { start: number; end: number; speaker: number }[] = this.diarizer.process(samples)

    // Dá a cada voz desta parte um nome que vale para a reunião toda.
    const m = this.manager(req.prefix)
    const names = new Map<number, string>()
    const speakers: SttSpeaker[] = []
    for (const id of [...new Set(segs.map((s) => s.speaker))]) {
      // Até 20 s de fala desta voz para tirar a impressão.
      const own = segs.filter((s) => s.speaker === id).sort((a, b) => b.end - b.start - (a.end - a.start))
      const pieces: Float32Array[] = []
      let total = 0
      for (const s of own) {
        if (total >= 20) break
        pieces.push(samples.subarray(Math.floor(s.start * 16000), Math.ceil(s.end * 16000)))
        total += s.end - s.start
      }
      const joined = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
      let off = 0
      for (const p of pieces) joined.set(p, (off += p.length) - p.length)
      const v = total >= 1 ? this.embed(joined) : null
      let label = v ? m.search({ v, threshold: SAME_PERSON }) : ''
      // Pouca fala (1–3 s) dá uma impressão de voz fraca: aceita a pessoa conhecida mais parecida.
      if (!label && v && total < 3) label = m.search({ v, threshold: SAME_PERSON / 2 })
      if (!label) {
        const n = (this.counters.get(req.prefix) ?? 0) + 1
        this.counters.set(req.prefix, n)
        label = `${req.prefix} ${n}`
        if (v) m.add({ name: label, v })
      }
      names.set(id, label)
      if (v) speakers.push({ label, embedding: Array.from(v) })
    }

    // Junta trechos seguidos da mesma voz (até 28 s) e transcreve.
    const chunks: { start: number; end: number; speaker: number }[] = []
    for (const s of segs) {
      const p = chunks.at(-1)
      if (p && p.speaker === s.speaker && s.start - p.end < 1 && s.end - p.start <= MAX_CHUNK) p.end = s.end
      else if (s.end - s.start <= MAX_CHUNK) chunks.push({ ...s })
      else for (let a = s.start; a < s.end; a += MAX_CHUNK) chunks.push({ start: a, end: Math.min(s.end, a + MAX_CHUNK), speaker: s.speaker })
    }
    const lines: SttLine[] = []
    for (const c of chunks) {
      if (c.end - c.start < 0.4) continue
      const stream = this.recognizer.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: samples.subarray(Math.floor(c.start * 16000), Math.ceil(c.end * 16000)) })
      const r = await this.recognizer.decodeAsync(stream)
      const text = String(r.text ?? '').trim()
      if (text) lines.push({ label: names.get(c.speaker)!, start: c.start, end: c.end, text })
    }
    return { lines, speakers, seconds }
  }
}

// ---------- Execução como utilityProcess ----------
type Msg =
  | { id: number; type: 'init'; init: SttInit }
  | { id: number; type: 'reset' }
  | { id: number; type: 'seed'; prefix: string; speakers: SttSpeaker[] }
  | { id: number; type: 'transcribe'; req: SttRequest }

const port = (process as any).parentPort
if (port) {
  let engine: LocalTranscriber | null = null
  port.on('message', async (e: { data: Msg }) => {
    const msg = e.data
    try {
      let result: unknown = null
      if (msg.type === 'init') engine = new LocalTranscriber(msg.init)
      else if (!engine) throw new Error('transcrição local não iniciada')
      else if (msg.type === 'reset') engine.reset()
      else if (msg.type === 'seed') await engine.seed(msg.prefix, msg.speakers)
      else if (msg.type === 'transcribe') result = await engine.transcribe(msg.req)
      port.postMessage({ id: msg.id, ok: true, result })
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) })
    }
  })
}
