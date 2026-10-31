export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'ollama'
export type TranscriptionProviderId = 'openai' | 'groq'
export type Speaker = 'me' | 'them'
export type PermissionKind = 'microphone' | 'screen' | 'accessibility'
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export interface ContextDoc {
  id: string
  name: string
  chars: number
  text: string
}

export interface Mode {
  id: string
  name: string
  icon: string
  prompt: string
  docs: ContextDoc[]
  builtIn?: boolean
}

export interface Settings {
  provider: ProviderId
  anthropicModel: string
  openaiModel: string
  geminiModel: string
  groqModel: string
  ollamaModel: string
  ollamaUrl: string
  ollamaContext: number
  autoStopMinutes: number
  finalTranscriber: 'auto' | 'gemini' | 'whisper'
  transcriptionProvider: TranscriptionProviderId
  transcriptionLanguage: string
  answerLanguage: string
  activeModeId: string
  autoSuggest: boolean
  silenceThreshold: number
  onboardingDone: boolean
  launchHidden: boolean
  openAtLogin: boolean
  showInDock: boolean
  shortcuts: Partial<Record<ShortcutName, string>>
}

export interface KeyStatus {
  anthropic: boolean
  openai: boolean
  groq: boolean
  gemini: boolean
}

export const PROVIDERS: { id: ProviderId; label: string; free: boolean; vision: string }[] = [
  { id: 'gemini', label: 'Gemini (Google)', free: true, vision: 'Lê a tela' },
  { id: 'groq', label: 'Groq', free: true, vision: 'Só texto' },
  { id: 'ollama', label: 'Ollama (local)', free: true, vision: 'Lê a tela com modelos de visão' },
  { id: 'anthropic', label: 'Claude', free: false, vision: 'Lê a tela' },
  { id: 'openai', label: 'OpenAI', free: false, vision: 'Lê a tela' }
]

export interface TranscriptLine {
  id: string
  speaker: Speaker
  text: string
  at: number
  /** Quem falou, quando identificado pela voz (ex.: "Pessoa 1"). */
  label?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  kind: AskKind
  content: string
  at: number
  withScreen?: boolean
}

export interface Session {
  id: string
  title: string
  modeId: string
  startedAt: number
  endedAt?: number
  transcript: TranscriptLine[]
  messages: ChatMessage[]
  summary?: string
  /** Áudio completo gravado (arquivos de até 10 min por fonte). */
  audio?: AudioPart[]
  /** true quando a transcrição foi refeita a partir do áudio completo. */
  finalized?: boolean
  /** Transcrição ao vivo original, guardada caso a final falhe. */
  liveTranscript?: TranscriptLine[]
  /** Nomes dados pelo usuário a cada falante identificado (ex.: { "Pessoa 2": "Esposa" }). */
  speakerNames?: Record<string, string>
  /** Motor usado na transcrição final. */
  finalEngine?: 'gemini' | 'whisper'
}

export interface AudioPart {
  file: string
  wav?: string
  speaker: Speaker
  startedAt: number
  mime: string
}

export type SessionMeta = Pick<Session, 'id' | 'title' | 'modeId' | 'startedAt' | 'endedAt'> & {
  lines: number
  answers: number
}

export type AskKind = 'ask' | 'suggest' | 'selection' | 'summary' | 'followup'

export type SelectionAction = 'explain' | 'summarize' | 'rewrite' | 'translate' | 'fix' | 'reply' | 'custom'

export interface AskRequest {
  requestId: string
  sessionId?: string
  kind: AskKind
  prompt?: string
  includeScreen?: boolean
  selection?: { text: string; action: SelectionAction }
}

export interface AiChunk {
  requestId: string
  text: string
}

export interface AiDone {
  requestId: string
  full: string
  messageId?: string
}

export interface AiError {
  requestId: string
  message: string
}

export interface PermissionsStatus {
  microphone: PermissionState
  screen: PermissionState
  accessibility: PermissionState
}

export type ShortcutName = 'toggle-bar' | 'ask-screen' | 'selection' | 'toggle-listen' | 'suggest'

export interface ShortcutStatus {
  name: ShortcutName
  label: string
  accel: string | null
  custom: boolean
  fallback: boolean
  ok: boolean
}

/** Combinações alternativas tentadas quando o padrão já está em uso por outro app. */
export const SHORTCUT_ALTERNATES: Record<ShortcutName, string[]> = {
  'toggle-bar': ['Control+Alt+\\'],
  'ask-screen': ['Control+Alt+Return', 'Control+Alt+Space'],
  suggest: ['Control+Alt+S', 'Control+Alt+D'],
  'toggle-listen': ['Control+Alt+M', 'Control+Alt+O'],
  selection: ['Control+Alt+L', 'Control+Alt+T']
}

export const SHORTCUTS: Record<ShortcutName, { accel: string; label: string }> = {
  'toggle-bar': { accel: 'CommandOrControl+\\', label: 'Mostrar/ocultar a barra' },
  'ask-screen': { accel: 'CommandOrControl+Shift+Return', label: 'Perguntar sobre a tela' },
  suggest: { accel: 'CommandOrControl+Shift+S', label: 'O que eu digo agora?' },
  'toggle-listen': { accel: 'CommandOrControl+Shift+M', label: 'Iniciar/parar a escuta' },
  selection: { accel: 'CommandOrControl+Shift+L', label: 'Ações no texto selecionado' }
}

export const SELECTION_ACTIONS: { id: SelectionAction; label: string }[] = [
  { id: 'explain', label: 'Explicar' },
  { id: 'summarize', label: 'Resumir' },
  { id: 'rewrite', label: 'Reescrever' },
  { id: 'fix', label: 'Corrigir' },
  { id: 'translate', label: 'Traduzir' },
  { id: 'reply', label: 'Responder' }
]

/** Nome exibido para quem falou numa linha da transcrição. */
export function speakerName(line: Pick<TranscriptLine, 'speaker' | 'label'>, names: Record<string, string> = {}): string {
  if (line.label) return names[line.label] || line.label
  return line.speaker === 'me' ? 'Você' : 'Outros'
}
