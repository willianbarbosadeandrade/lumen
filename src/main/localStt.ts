import { app, utilityProcess, type UtilityProcess } from 'electron'
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SttRequest, SttResult, SttSpeaker } from './sttWorker'
import { MODEL_FILES } from './sttWorker'
import type { LocalModelsStatus } from '@shared/types'
import { log } from './log'

/**
 * Transcrição no computador: Whisper turbo + separação de vozes (sherpa-onnx), rodando num
 * processo separado. Os modelos (~1,1 GB) são baixados uma vez, de dentro do app.
 */
const HF = 'https://huggingface.co/csukuangfj'
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
export const MODEL_SOURCES: { file: string; url: string; bytes: number }[] = [
  { file: MODEL_FILES.encoder, url: `${HF}/sherpa-onnx-whisper-turbo/resolve/main/turbo-encoder.int8.onnx`, bytes: 674_716_297 },
  { file: MODEL_FILES.decoder, url: `${HF}/sherpa-onnx-whisper-turbo/resolve/main/turbo-decoder.int8.onnx`, bytes: 361_080_764 },
  { file: MODEL_FILES.tokens, url: `${HF}/sherpa-onnx-whisper-turbo/resolve/main/turbo-tokens.txt`, bytes: 816_730 },
  { file: MODEL_FILES.segmentation, url: `${HF}/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`, bytes: 5_992_913 },
  { file: MODEL_FILES.embedding, url: `${GH}/speaker-recongition-models/nemo_en_titanet_small.onnx`, bytes: 40_257_283 }
]
export const MODELS_TOTAL_BYTES = MODEL_SOURCES.reduce((n, m) => n + m.bytes, 0)

export const modelsDir = () => join(app.getPath('userData'), 'models')

const sizeOf = (f: string) => statSync(f, { throwIfNoEntry: false })?.size ?? 0

let downloading: AbortController | null = null
let lastError: string | undefined

export function localModelsStatus(): LocalModelsStatus {
  const dir = modelsDir()
  let done = 0
  let installed = true
  for (const m of MODEL_SOURCES) {
    const size = sizeOf(join(dir, m.file))
    if (size === m.bytes) done += size
    else {
      installed = false
      done += Math.min(sizeOf(join(dir, `${m.file}.part`)), m.bytes)
    }
  }
  return { installed, downloading: !!downloading, done, total: MODELS_TOTAL_BYTES, error: lastError }
}

export const localAvailable = () => localModelsStatus().installed

/** Baixa o que falta (arquivo por arquivo, com progresso). Arquivos já completos não são baixados de novo. */
export async function downloadModels(onProgress: (s: LocalModelsStatus) => void): Promise<LocalModelsStatus> {
  if (downloading) return localModelsStatus()
  const ctrl = new AbortController()
  downloading = ctrl
  lastError = undefined
  const dir = modelsDir()
  mkdirSync(dir, { recursive: true })
  try {
    for (const m of MODEL_SOURCES) {
      const target = join(dir, m.file)
      if (sizeOf(target) === m.bytes) continue
      const part = `${target}.part`
      rmSync(part, { force: true })
      const res = await fetch(m.url, { signal: ctrl.signal })
      if (!res.ok || !res.body) throw new Error(`download de ${m.file} falhou (${res.status})`)
      const out = createWriteStream(part)
      let last = 0
      const body = Readable.fromWeb(res.body as never)
      body.on('data', () => {
        const now = Date.now()
        if (now - last > 400) {
          last = now
          onProgress(localModelsStatus())
        }
      })
      await pipeline(body, out)
      if (sizeOf(part) !== m.bytes) throw new Error(`${m.file} chegou incompleto; tente de novo`)
      renameSync(part, target)
      onProgress(localModelsStatus())
    }
    log.info('[stt] modelos da transcrição local instalados')
  } catch (e) {
    lastError = ctrl.signal.aborted ? 'download cancelado' : (e as Error).message
    log.warn('[stt] download dos modelos:', lastError)
  } finally {
    downloading = null
  }
  const st = localModelsStatus()
  onProgress(st)
  return st
}

export function cancelDownload(): void {
  downloading?.abort()
}

// ---------- Processo separado ----------
let worker: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let idleTimer: NodeJS.Timeout | null = null

function startWorker(): UtilityProcess {
  if (worker) return worker
  const w = utilityProcess.fork(join(__dirname, 'sttWorker.js'), [], { serviceName: 'Lumen Transcrição', stdio: 'pipe' })
  w.stderr?.on('data', (d) => log.warn('[stt]', String(d).trim().slice(0, 500)))
  w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  })
  w.on('exit', (code) => {
    log.info(`[stt] processo de transcrição saiu (código ${code})`)
    for (const p of pending.values()) p.reject(new Error('o processo de transcrição local fechou'))
    pending.clear()
    if (worker === w) worker = null
  })
  worker = w
  const threads = Math.max(2, Math.min(8, cpus().length - 2))
  call('init', { init: { modelsDir: modelsDir(), threads } }).catch((e) => log.warn('[stt] init:', (e as Error).message))
  return w
}

function call<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const w = worker ?? startWorker()
  if (idleTimer) clearTimeout(idleTimer)
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w.postMessage({ id, type, ...payload })
  }).finally(() => {
    // Sem uso por 2 min: fecha o processo e devolve a memória (~1,5 GB) ao sistema.
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!pending.size) stopLocalStt()
    }, 120_000)
  })
}

export function stopLocalStt(): void {
  if (idleTimer) clearTimeout(idleTimer)
  worker?.kill()
  worker = null
}

/** Começa uma sessão nova (pessoas novas) e reapresenta as vozes já conhecidas desta sessão. */
export async function beginLocalSession(known: { prefix: string; speakers: SttSpeaker[] }[]): Promise<void> {
  await call('reset')
  for (const k of known) if (k.speakers.length) await call('seed', { prefix: k.prefix, speakers: k.speakers })
}

/** Transcreve uma parte; limite generoso (o processamento pode levar alguns minutos em máquinas lentas). */
export async function transcribeLocal(req: SttRequest, timeoutMs = 15 * 60_000): Promise<SttResult> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      call<SttResult>('transcribe', { req }),
      new Promise<SttResult>((_, reject) => {
        timer = setTimeout(() => {
          stopLocalStt()
          reject(new Error('a transcrição local demorou demais'))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
