import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AiChunk,
  AiDone,
  AskRequest,
  FinalizeStatus,
  LocalModelsStatus,
  KeyStatus,
  Mode,
  PermissionKind,
  PermissionsStatus,
  ProviderId,
  SelectionAction,
  Session,
  SessionMeta,
  Settings,
  ShortcutName,
  ShortcutStatus,
  Speaker,
  TranscriptLine
} from '@shared/types'

type Unsub = () => void
function on<T>(channel: string, cb: (payload: T) => void): Unsub {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

type KeyName = keyof KeyStatus

const api = {
  platform: process.platform,
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    onChange: (cb: (s: Settings) => void) => on('settings:changed', cb)
  },
  keys: {
    status: (): Promise<KeyStatus> => ipcRenderer.invoke('keys:status'),
    set: (name: KeyName, value: string): Promise<KeyStatus> => ipcRenderer.invoke('keys:set', name, value),
    test: (name: ProviderId): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('keys:test', name)
  },
  modes: {
    list: (): Promise<Mode[]> => ipcRenderer.invoke('modes:list'),
    save: (m: Mode): Promise<Mode[]> => ipcRenderer.invoke('modes:save', m),
    remove: (id: string): Promise<Mode[]> => ipcRenderer.invoke('modes:delete', id),
    addDocs: (id: string): Promise<Mode[]> => ipcRenderer.invoke('modes:addDocs', id),
    onChange: (cb: (m: Mode[]) => void) => on('modes:changed', cb)
  },
  perms: {
    status: (): Promise<PermissionsStatus> => ipcRenderer.invoke('perm:status'),
    request: (k: PermissionKind): Promise<PermissionsStatus> => ipcRenderer.invoke('perm:request', k),
    open: (k: PermissionKind): Promise<void> => ipcRenderer.invoke('perm:open', k)
  },
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    finishOnboarding: (): Promise<void> => ipcRenderer.invoke('onboarding:finish'),
    openMain: (route?: string) => ipcRenderer.send('main:open', route),
    openOnboarding: () => ipcRenderer.send('onboarding:open'),
    onNav: (cb: (route: string) => void) => on('nav', cb)
  },
  log: (message: string) => ipcRenderer.send('log', message),
  stt: {
    status: (): Promise<LocalModelsStatus> => ipcRenderer.invoke('stt:status'),
    download: (): Promise<LocalModelsStatus> => ipcRenderer.invoke('stt:download'),
    cancel: () => ipcRenderer.send('stt:cancel'),
    onProgress: (cb: (s: LocalModelsStatus) => void) => on('stt:progress', cb)
  },
  bar: {
    /** Informa o estado da gravação ao processo principal (cronômetro na barra de menus). */
    recState: (p: { status: string; elapsed: number; sessionId?: string }) => ipcRenderer.send('rec:state', p),
    resize: (h: number) => ipcRenderer.send('bar:resize', h),
    hide: () => ipcRenderer.send('bar:hide'),
    focus: () => ipcRenderer.send('bar:focus'),
    onShown: (cb: () => void) => on('bar:shown', cb),
    onShortcut: (cb: (name: ShortcutName) => void) => on('shortcut', cb),
    onListenCommand: (cb: (cmd: 'stop' | 'pause' | 'play') => void) => on('listen:command', cb)
  },
  system: {
    info: (): Promise<{ platform: NodeJS.Platform; selection: 'ok' | 'needs-accessibility' | 'needs-linux-tool'; dataDir: string }> =>
      ipcRenderer.invoke('system:info'),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('app:openUrl', url)
  },
  ollama: {
    status: (): Promise<{
      running: boolean
      download: { url: string; command?: string; label: string }
      suggested: { name: string; size: string; note: string }[]
    }> => ipcRenderer.invoke('ollama:status'),
    pull: (name: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ollama:pull', name),
    cancelPull: () => ipcRenderer.send('ollama:pull-cancel'),
    onPullProgress: (cb: (p: { name: string; status: string; percent?: number }) => void) => on('ollama:pull-progress', cb),
    models: (): Promise<{ ok: boolean; models: { name: string; sizeGB: number; params?: string; vision: boolean; thinking: boolean }[] }> =>
      ipcRenderer.invoke('ollama:models')
  },
  shortcuts: {
    status: (): Promise<ShortcutStatus[]> => ipcRenderer.invoke('shortcuts:status'),
    set: (name: ShortcutName, accel: string | null): Promise<ShortcutStatus[]> => ipcRenderer.invoke('shortcuts:set', name, accel),
    pause: (): Promise<void> => ipcRenderer.invoke('shortcuts:pause'),
    resume: (): Promise<ShortcutStatus[]> => ipcRenderer.invoke('shortcuts:resume'),
    onChange: (cb: (s: ShortcutStatus[]) => void) => on('shortcuts:changed', cb)
  },
  sessions: {
    start: (modeId: string): Promise<Session> => ipcRenderer.invoke('session:start', modeId),
    stop: (id: string, finalize = true): Promise<Session | undefined> => ipcRenderer.invoke('session:stop', id, finalize),
    audioBegin: (p: { sessionId: string; speaker: Speaker; startedAt: number; mime: string }): Promise<string> =>
      ipcRenderer.invoke('session:audioBegin', p),
    audioAppend: (sessionId: string, file: string, data: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke('session:audioAppend', sessionId, file, data),
    audioFinish: (sessionId: string, file: string, wav: ArrayBuffer | undefined, durationMs: number): Promise<void> =>
      ipcRenderer.invoke('session:audioFinish', sessionId, file, wav, durationMs),
    renameSpeaker: (id: string, label: string, name: string): Promise<void> => ipcRenderer.invoke('session:renameSpeaker', id, label, name),
    /** Refaz a transcrição a partir do áudio; `force` refaz também as partes já revisadas. */
    refinalize: (id: string, force = false): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('session:refinalize', id, force),
    summarize: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('session:summarize', id),
    finalizeStatus: (): Promise<FinalizeStatus[]> => ipcRenderer.invoke('session:finalizeStatus'),
    onFinalize: (cb: (p: FinalizeStatus) => void) => on('session:finalize', cb),
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list'),
    get: (id: string): Promise<Session | undefined> => ipcRenderer.invoke('session:get', id),
    rename: (id: string, title: string): Promise<void> => ipcRenderer.invoke('session:rename', id, title),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('session:delete', id),
    exportMd: (id: string): Promise<boolean> => ipcRenderer.invoke('session:export', id),
    markdown: (id: string): Promise<string> => ipcRenderer.invoke('session:markdown', id),
    onChange: (cb: () => void) => on('sessions:changed', cb)
  },
  transcript: {
    send: (p: { sessionId: string; speaker: Speaker; audio: ArrayBuffer; mime: string; at: number }): Promise<TranscriptLine | null> =>
      ipcRenderer.invoke('transcribe:chunk', p),
    onLine: (cb: (p: { sessionId: string; line: TranscriptLine; removed?: string[] }) => void) => on('transcript:line', cb)
  },
  audio: {
    // Handlers registrados pelo electron-audio-loopback no processo main.
    enableLoopback: (): Promise<void> => ipcRenderer.invoke('enable-loopback-audio'),
    disableLoopback: (): Promise<void> => ipcRenderer.invoke('disable-loopback-audio')
  },
  ai: {
    ask: (req: AskRequest): Promise<void> => ipcRenderer.invoke('ai:ask', req),
    cancel: (requestId: string) => ipcRenderer.send('ai:cancel', requestId),
    onChunk: (cb: (c: AiChunk) => void) => on('ai:chunk', cb),
    onDone: (cb: (d: AiDone) => void) => on('ai:done', cb),
    onNotice: (cb: (n: { requestId: string; message: string; action?: string }) => void) => on('ai:notice', cb),
    onError: (cb: (e: { requestId: string; message: string; config?: boolean }) => void) => on('ai:error', cb)
  },
  selection: {
    onCaptured: (cb: (p: { text: string; error?: string }) => void) => on('selection:captured', cb),
    replace: (text: string): Promise<void> => ipcRenderer.invoke('selection:replace', text),
    replaceable: (): Promise<SelectionAction[]> => ipcRenderer.invoke('selection:replaceable')
  },
  clipboard: {
    write: (text: string) => navigator.clipboard.writeText(text)
  }
}

export type LumenApi = typeof api

contextBridge.exposeInMainWorld('lumen', api)
