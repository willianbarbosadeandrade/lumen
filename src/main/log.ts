import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Registro em arquivo para diagnosticar problemas que acontecem longe dos olhos (ex.: no meio de
 * uma reunião). Fica em ~/Library/Logs/Lumen/main.log (macOS), %APPDATA%\Lumen\logs (Windows)
 * ou ~/.config/Lumen/logs (Linux). Gira em 5 MB, mantendo o arquivo anterior como main.old.log.
 */
const MAX_BYTES = 5 * 1024 * 1024
let file: string | null = null

function target(): string | null {
  if (file) return file
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
  } catch {
    return null
  }
  return file
}

function write(level: string, args: unknown[]): void {
  const f = target()
  if (!f) return
  const text = args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeJson(a)))
    .join(' ')
  try {
    if ((statSync(f, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(f, f.replace(/\.log$/, '.old.log'))
    appendFileSync(f, `${new Date().toISOString()} ${level} ${text}\n`)
  } catch {
    /* registro nunca pode derrubar o app */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  info: (...a: unknown[]) => write('INFO', a),
  warn: (...a: unknown[]) => write('WARN', a),
  error: (...a: unknown[]) => write('ERROR', a)
}

/** Faz console.warn/console.error do processo principal também irem para o arquivo. */
export function captureConsole(): void {
  const { warn, error } = console
  console.warn = (...a: unknown[]) => (warn(...a), write('WARN', a))
  console.error = (...a: unknown[]) => (error(...a), write('ERROR', a))
  process.on('uncaughtException', (e) => write('FATAL', [e]))
  process.on('unhandledRejection', (e) => write('ERROR', ['unhandledRejection', e]))
}

export function logPath(): string | null {
  return target()
}
