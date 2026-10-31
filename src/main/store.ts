import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KeyStatus, Mode, Session, SessionMeta, Settings } from '@shared/types'
import { DEFAULT_MODES } from './modes'

const dir = () => app.getPath('userData')
const sessionsDir = () => join(dir(), 'sessions')

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

// Escrita atômica: grava em arquivo temporário e renomeia, para não corromper em caso de crash.
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'gemini',
  anthropicModel: 'claude-sonnet-5-5',
  openaiModel: 'gpt-5-mini',
  geminiModel: 'gemini-3.8-flash',
  groqModel: 'openai/gpt-oss-120b',
  ollamaModel: 'gemma3',
  ollamaUrl: 'http://localhost:11434',
  ollamaContext: 8192,
  autoStopMinutes: 10,
  finalTranscriber: 'auto',
  transcriptionProvider: 'groq',
  transcriptionLanguage: 'pt',
  answerLanguage: 'Português do Brasil',
  activeModeId: 'general',
  autoSuggest: false,
  silenceThreshold: 0.012,
  onboardingDone: false,
  launchHidden: false,
  openAtLogin: true,
  showInDock: true,
  shortcuts: {}
}

export function ensureDirs(): void {
  mkdirSync(sessionsDir(), { recursive: true })
}

// ---------- Configurações ----------
// Modelos que os provedores já aposentaram: são trocados pelo padrão atual ao ler as configurações.
const RETIRED_MODELS: Partial<Record<keyof Settings, string[]>> = {
  geminiModel: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash']
}

export function getSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(join(dir(), 'settings.json'), {}) }
  for (const [k, retired] of Object.entries(RETIRED_MODELS) as [keyof Settings, string[]][]) {
    if (retired.includes(s[k] as string)) (s as unknown as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k]
  }
  return s
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeJson(join(dir(), 'settings.json'), next)
  return next
}

// ---------- Chaves de API (criptografadas com o Keychain via safeStorage) ----------
type KeyName = keyof KeyStatus
const keysFile = () => join(dir(), 'keys.json')

export function setKey(name: KeyName, value: string): KeyStatus {
  const all = readJson<Record<string, string>>(keysFile(), {})
  const trimmed = value.trim()
  if (!trimmed) delete all[name]
  else if (safeStorage.isEncryptionAvailable()) all[name] = 'enc:' + safeStorage.encryptString(trimmed).toString('base64')
  else all[name] = 'raw:' + trimmed
  writeJson(keysFile(), all)
  return keyStatus()
}

export function getKey(name: KeyName): string | undefined {
  const envName = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY' }[name]
  const stored = readJson<Record<string, string>>(keysFile(), {})[name]
  if (stored?.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return undefined
    }
  }
  if (stored?.startsWith('raw:')) return stored.slice(4)
  return process.env[envName] || undefined
}

export function keyStatus(): KeyStatus {
  return { anthropic: !!getKey('anthropic'), openai: !!getKey('openai'), groq: !!getKey('groq'), gemini: !!getKey('gemini') }
}

// ---------- Modos ----------
const modesFile = () => join(dir(), 'modes.json')

export function getModes(): Mode[] {
  const custom = readJson<Mode[]>(modesFile(), [])
  const overrides = new Map(custom.map((m) => [m.id, m]))
  const builtIns = DEFAULT_MODES.map((m) => ({ ...m, ...(overrides.get(m.id) ?? {}), builtIn: true }))
  const extras = custom.filter((m) => !DEFAULT_MODES.some((d) => d.id === m.id))
  return [...builtIns, ...extras]
}

export function getMode(id: string): Mode {
  const modes = getModes()
  return modes.find((m) => m.id === id) ?? modes[0]
}

export function saveMode(mode: Mode): Mode[] {
  const custom = readJson<Mode[]>(modesFile(), [])
  const toSave = { ...mode, id: mode.id || randomUUID() }
  delete toSave.builtIn
  const idx = custom.findIndex((m) => m.id === toSave.id)
  if (idx >= 0) custom[idx] = toSave
  else custom.push(toSave)
  writeJson(modesFile(), custom)
  return getModes()
}

export function deleteMode(id: string): Mode[] {
  // Para modos padrão, isso restaura o original; para modos do usuário, remove.
  writeJson(
    modesFile(),
    readJson<Mode[]>(modesFile(), []).filter((m) => m.id !== id)
  )
  return getModes()
}

// ---------- Sessões ----------
const sessionFile = (id: string) => join(sessionsDir(), `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`)

export function createSession(modeId: string): Session {
  const now = Date.now()
  const s: Session = {
    id: randomUUID(),
    title: `Sessão de ${new Date(now).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`,
    modeId,
    startedAt: now,
    transcript: [],
    messages: []
  }
  saveSession(s)
  return s
}

export function getSession(id: string): Session | undefined {
  const f = sessionFile(id)
  return existsSync(f) ? readJson<Session | undefined>(f, undefined) : undefined
}

export function saveSession(s: Session): void {
  writeJson(sessionFile(s.id), s)
}

export function updateSession(id: string, fn: (s: Session) => void): Session | undefined {
  const s = getSession(id)
  if (!s) return undefined
  fn(s)
  saveSession(s)
  return s
}

export function listSessions(): SessionMeta[] {
  return readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<Session | null>(join(sessionsDir(), f), null))
    .filter((s): s is Session => !!s)
    .map((s) => ({
      id: s.id,
      title: s.title,
      modeId: s.modeId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      lines: s.transcript.length,
      answers: s.messages.filter((m) => m.role === 'assistant').length
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function deleteSession(id: string): void {
  rmSync(sessionFile(id), { force: true })
  rmSync(sessionAudioDir(id), { recursive: true, force: true })
}

/** Pasta com os arquivos de áudio da sessão. */
export function sessionAudioDir(id: string): string {
  const d = join(sessionsDir(), id.replace(/[^a-zA-Z0-9-]/g, ''))
  mkdirSync(d, { recursive: true })
  return d
}

export function saveSessionAudio(id: string, speaker: 'me' | 'them', startedAt: number, mime: string, data: ArrayBuffer, wavData?: ArrayBuffer): void {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm'
  const file = `${speaker}-${startedAt}.${ext}`
  writeFileSync(join(sessionAudioDir(id), file), Buffer.from(data))
  let wav: string | undefined
  if (wavData && wavData.byteLength > 1000) {
    wav = `${speaker}-${startedAt}.wav`
    writeFileSync(join(sessionAudioDir(id), wav), Buffer.from(wavData))
  }
  updateSession(id, (s) => {
    s.audio = [...(s.audio ?? []).filter((a) => a.file !== file), { file, wav, speaker, startedAt, mime }]
  })
}

/**
 * Fecha sessões que ficaram "em andamento" porque o app foi encerrado com a escuta ligada.
 * O fim passa a ser a última fala registrada (ou o início, se não houve fala).
 */
export function closeOrphanSessions(exceptId?: string): number {
  let closed = 0
  for (const f of readdirSync(sessionsDir()).filter((x) => x.endsWith('.json'))) {
    const s = readJson<Session | null>(join(sessionsDir(), f), null)
    if (!s || s.endedAt || s.id === exceptId) continue
    s.endedAt = s.transcript.at(-1)?.at ?? s.startedAt
    saveSession(s)
    closed++
  }
  return closed
}

/** Remove sessões vazias (sem fala e sem perguntas) criadas por engano. */
export function pruneEmptySessions(): number {
  let removed = 0
  for (const f of readdirSync(sessionsDir()).filter((x) => x.endsWith('.json'))) {
    const s = readJson<Session | null>(join(sessionsDir(), f), null)
    if (s && s.endedAt && !s.transcript.length && !s.messages.length && !(s.audio ?? []).length) {
      rmSync(join(sessionsDir(), f), { force: true })
      rmSync(join(sessionsDir(), s.id), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}
