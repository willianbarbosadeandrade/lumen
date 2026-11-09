import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { writeFile } from 'node:fs/promises'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initMain as initLoopback } from 'electron-audio-loopback'
import { SHORTCUT_ALTERNATES, SHORTCUTS, type AskRequest, type ShortcutStatus, type Mode, type PermissionKind, type Settings, type ShortcutName, type Speaker } from '@shared/types'
import { promptBudget, testProvider } from './ai'
import { humanizeError } from './errors'
import { autoTitle, REPLACEABLE, runAsk, sessionToMarkdown } from './assistant'
import { captureScreen } from './capture'
import { getBar as barWindow } from './windows'
import { loadDoc } from './docs'
import { listOllamaModels, ollamaDownloadInfo, ollamaRunning, pullOllamaModel, SUGGESTED_OLLAMA_MODELS } from './ollama'
import { selectionSupport } from './selection'
import { openPermissionPane, permissionsStatus, requestPermission } from './permissions'
import { grabSelection, pasteText } from './selection'
import * as store from './store'
import { transcribeChunk } from './transcribe'
import { echoesOf, isEcho } from './transcript'
import { finalizeSession, finalizeStatuses } from './finalize'
import { captureConsole, log, logPath } from './log'
import { cancelDownload, downloadModels, localModelsStatus, stopLocalStt } from './localStt'
import {
  allWindows,
  keepBarOnTop,
  onBarCreated,
  broadcast,
  closeOnboarding,
  createBar,
  focusBar,
  getBar,
  openMain,
  openOnboarding,
  resizeBar,
  setQuitting,
  toggleBar
} from './windows'

captureConsole()

// Precisa rodar antes do `ready`: habilita a captura do áudio do sistema via getDisplayMedia.
initLoopback()

app.setName('Lumen')
if (!app.requestSingleInstanceLock()) app.quit()

let tray: Tray | null = null
const inflight = new Map<string, AbortController>()
let listening = false
let activeSessionId: string | null = null

// ---------- Estado da gravação (vem da barra) ----------
interface RecState {
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'finalizing'
  elapsed: number
  sessionId?: string
}
let recState: RecState = { status: 'idle', elapsed: 0 }

const clock = (ms: number) => {
  const t = Math.floor(ms / 1000)
  const h = Math.floor(t / 3600)
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0')
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`
}

/** Na barra de menus do Mac, o cronômetro mostra que a gravação continua mesmo com a barra oculta. */
function updateTrayTitle(): void {
  if (!tray || process.platform !== 'darwin') return
  const running = finalizeStatuses().find((f) => f.state === 'running')
  const title =
    recState.status === 'recording'
      ? ` ● ${clock(recState.elapsed)}`
      : recState.status === 'paused'
        ? ` ❚❚ ${clock(recState.elapsed)}`
        : running
          ? ` Revisando ${running.done}/${running.total}`
          : ' Lumen'
  tray.setTitle(title)
  tray.setToolTip(recState.status === 'recording' ? `Lumen · gravando ${clock(recState.elapsed)}` : 'Lumen')
}

/**
 * Depois que a gravação termina: revisa a transcrição a partir do áudio, cria o título e o resumo.
 * Tudo em segundo plano, com o progresso aparecendo na barra e no Histórico.
 */
async function afterRecording(id: string): Promise<void> {
  try {
    store.dropEmptyAudio(id)
    if (store.getSession(id)?.audio?.length) {
      const result = await finalizeSession(id, {
        onStatus: (st) => {
          broadcast('session:finalize', st)
          updateTrayTitle()
        }
      })
      log.info(`[finalize] ${id}: ${result.state} ${result.done}/${result.total}${result.error ? ` — ${result.error}` : ''}`)
    }
    store.pruneEmptySessions()
    broadcast('sessions:changed')
    updateTrayTitle()
    await autoTitle(id)
    broadcast('sessions:changed')
    const s = store.getSession(id)
    // Resumo automático da reunião inteira (só quando há conversa suficiente e ainda não há resumo).
    if (s && !s.summary && s.transcript.length >= 10) {
      await runAsk({ requestId: randomUUID(), kind: 'summary', sessionId: id }, { signal: AbortSignal.timeout(600_000), onText: () => {} }).catch(
        (e) => log.warn('[summary] resumo automático falhou:', (e as Error).message)
      )
      broadcast('sessions:changed')
    }
  } catch (e) {
    log.error('[afterRecording]', e)
  } finally {
    updateTrayTitle()
  }
}

/**
 * Se a barra (que é quem grava) travar ou fechar no meio da gravação, a sessão é encerrada com o
 * áudio que já está no disco, a revisão roda e a barra volta.
 */
function watchBar(win: BrowserWindow): void {
  win.webContents.on('did-fail-load', (_e, code, desc) => log.error(`[barra] não carregou: ${desc} (${code})`))
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log.warn(`[barra] ${e.message}`.slice(0, 1000))
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`[barra] processo da barra caiu: ${details.reason} (${details.exitCode})`)
    const id = activeSessionId ?? recState.sessionId
    const wasRecording = recState.status === 'recording' || recState.status === 'paused'
    recState = { status: 'idle', elapsed: 0 }
    listening = false
    activeSessionId = null
    refreshTray()
    updateTrayTitle()
    if (id && wasRecording) {
      store.updateSession(id, (x) => (x.endedAt ??= Date.now()))
      void afterRecording(id)
      if (Notification.isSupported())
        new Notification({ title: 'Lumen', body: 'A barra reiniciou. A gravação até agora foi salva e está sendo revisada.' }).show()
    }
    if (!win.isDestroyed()) win.destroy()
    setTimeout(() => createBar(true), 500)
  })
  win.on('unresponsive', () => log.warn('[barra] janela sem responder'))
  win.on('responsive', () => log.info('[barra] janela voltou a responder'))
}

// ---------- Atalhos globais ----------
let shortcutStatus: ShortcutStatus[] = []

function tryRegister(accel: string, name: ShortcutName): boolean {
  try {
    return globalShortcut.register(accel, () => void onShortcut(name))
  } catch {
    return false // acelerador inválido
  }
}

/**
 * Registra os atalhos globais. Se o padrão estiver ocupado por outro app,
 * tenta as alternativas e informa na interface qual ficou valendo.
 */
function registerShortcuts(): ShortcutStatus[] {
  globalShortcut.unregisterAll()
  const custom = store.getSettings().shortcuts ?? {}
  shortcutStatus = (Object.keys(SHORTCUTS) as ShortcutName[]).map((name) => {
    const def = SHORTCUTS[name]
    const own = custom[name]
    const candidates = own ? [own] : [def.accel, ...SHORTCUT_ALTERNATES[name]]
    const accel = candidates.find((c) => tryRegister(c, name)) ?? null
    if (!accel) console.warn(`[lumen] atalho indisponível: ${name} (${candidates.join(', ')})`)
    return { name, label: def.label, accel, custom: !!own, fallback: !own && !!accel && accel !== def.accel, ok: !!accel }
  })
  broadcast('shortcuts:changed', shortcutStatus)
  refreshTray()
  return shortcutStatus
}

const accelOf = (name: ShortcutName) => shortcutStatus.find((s) => s.name === name)?.accel ?? undefined

async function onShortcut(name: ShortcutName): Promise<void> {
  if (name === 'toggle-bar') return toggleBar()
  toggleBar(true)
  const bar = getBar()
  if (!bar) return
  if (name === 'selection') {
    try {
      const text = await grabSelection()
      bar.webContents.send('selection:captured', { text })
      focusBar()
    } catch (e) {
      bar.webContents.send('selection:captured', {
        text: '',
        error: ['ACCESSIBILITY', 'LINUX_TOOL'].includes((e as Error).message) ? (e as Error).message : (e as Error).message
      })
    }
    return
  }
  bar.webContents.send('shortcut', name)
}

// ---------- Ícone na barra de menus ----------
const resource = (name: string) => join(app.getAppPath(), 'resources', name)

function buildTray(): void {
  // macOS usa ícone "template" (preto, o sistema adapta ao tema). Windows e Linux usam o ícone colorido.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  let icon = nativeImage.createFromPath(resource(file))
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  else if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  // No macOS, o nome ao lado do ícone deixa o Lumen fácil de achar na barra de menus.
  if (process.platform === 'darwin') tray.setTitle(icon.isEmpty() ? '◉ Lumen' : ' Lumen')
  updateTrayTitle()
  tray.setToolTip('Lumen')
  // No Windows, clicar no ícone da bandeja mostra/esconde a barra; o menu fica no botão direito.
  if (process.platform === 'win32') tray.on('click', () => toggleBar())
  refreshTray()
}

function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) return
  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })
    return
  }
  // Linux: o padrão freedesktop é um arquivo .desktop em ~/.config/autostart.
  const dir = join(app.getPath('appData'), 'autostart')
  const file = join(dir, 'lumen.desktop')
  try {
    if (openAtLogin) {
      mkdirSync(dir, { recursive: true })
      const exec = process.env.APPIMAGE || process.execPath
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Lumen\nExec="${exec}" --hidden\nIcon=lumen\nX-GNOME-Autostart-enabled=true\n`)
    } else rmSync(file, { force: true })
  } catch (e) {
    console.warn('[lumen] não consegui configurar o início automático:', (e as Error).message)
  }
}

function refreshTray(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label:
        recState.status === 'recording'
          ? '● Gravando'
          : recState.status === 'paused'
            ? '❚❚ Gravação pausada'
            : 'Lumen',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Mostrar/ocultar barra', accelerator: accelOf('toggle-bar'), click: () => toggleBar() },
    {
      label: recState.status === 'recording' ? 'Pausar gravação' : recState.status === 'paused' ? 'Continuar gravação' : 'Gravar',
      accelerator: accelOf('toggle-listen'),
      click: () => void onShortcut('toggle-listen')
    },
    ...(listening || recState.status === 'recording' || recState.status === 'paused'
      ? [{ label: 'Parar e salvar gravação', click: () => getBar()?.webContents.send('listen:command', 'stop') }]
      : []),
    { label: 'Perguntar sobre a tela', accelerator: accelOf('ask-screen'), click: () => void onShortcut('ask-screen') },
    { label: 'O que eu digo agora?', accelerator: accelOf('suggest'), click: () => void onShortcut('suggest') },
    { label: 'Ações no texto selecionado', accelerator: accelOf('selection'), click: () => void onShortcut('selection') },
    { type: 'separator' },
    { label: 'Abrir Lumen', click: () => openMain('home') },
    { label: 'Histórico', click: () => openMain('history') },
    { label: 'Configurações…', accelerator: 'CommandOrControl+,', click: () => openMain('settings') },
    { label: 'Permissões…', click: () => openOnboarding() },
    { label: 'Abrir registro de diagnóstico', click: () => void shell.openPath(logPath() ?? '') },
    { type: 'separator' },
    {
      label: process.platform === 'darwin' ? 'Abrir ao iniciar o Mac' : 'Abrir ao iniciar o computador',
      type: 'checkbox',
      checked: store.getSettings().openAtLogin,
      click: (item) => {
        store.setSettings({ openAtLogin: item.checked })
        applyLoginItem(item.checked)
        broadcast('settings:changed', store.getSettings())
      }
    },
    ...(process.platform !== 'darwin'
      ? []
      : [{
      label: 'Mostrar no Dock',
      type: 'checkbox',
      checked: store.getSettings().showInDock,
      click: (item) => {
        store.setSettings({ showInDock: item.checked })
        applyDock()
        broadcast('settings:changed', store.getSettings())
      }
    }] as Electron.MenuItemConstructorOptions[]),
    { type: 'separator' },
    { label: 'Sair do Lumen', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

function applyDock(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  if (store.getSettings().showInDock) void app.dock.show()
  else app.dock.hide()
}

// ---------- IPC ----------
function registerIpc(): void {
  // Configurações e chaves
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = store.setSettings(patch)
    if ('openAtLogin' in patch) applyLoginItem(s.openAtLogin)
    if ('showInDock' in patch) applyDock()
    refreshTray()
    broadcast('settings:changed', s)
    return s
  })
  ipcMain.handle('keys:status', () => store.keyStatus())
  ipcMain.handle('keys:set', (_e, name: keyof import('@shared/types').KeyStatus, value: string) => store.setKey(name, value))
  ipcMain.handle('keys:test', (_e, name: import('@shared/types').ProviderId) => testProvider(name))

  // Modos
  ipcMain.handle('modes:list', () => store.getModes())
  ipcMain.handle('modes:save', (_e, mode: Mode) => {
    const modes = store.saveMode(mode)
    broadcast('modes:changed', modes)
    return modes
  })
  ipcMain.handle('modes:delete', (_e, id: string) => {
    const modes = store.deleteMode(id)
    broadcast('modes:changed', modes)
    return modes
  })
  ipcMain.handle('modes:addDocs', async (e, modeId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Adicionar documentos de contexto',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documentos', extensions: ['pdf', 'txt', 'md', 'csv', 'json'] }]
    })
    if (res.canceled) return store.getModes()
    const mode = store.getMode(modeId)
    const docs = await Promise.all(res.filePaths.map(loadDoc))
    const modes = store.saveMode({ ...mode, docs: [...mode.docs, ...docs] })
    broadcast('modes:changed', modes)
    return modes
  })

  // Permissões
  ipcMain.handle('perm:status', () => permissionsStatus())
  ipcMain.handle('perm:request', (_e, kind: PermissionKind) => requestPermission(kind))
  ipcMain.handle('perm:open', (_e, kind: PermissionKind) => openPermissionPane(kind))
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('onboarding:finish', () => {
    store.setSettings({ onboardingDone: true })
    closeOnboarding()
    toggleBar(true)
  })

  // Ollama
  ipcMain.handle('ollama:models', async () => {
    try {
      return { ok: true, models: await listOllamaModels() }
    } catch {
      return { ok: false, models: [] }
    }
  })

  ipcMain.handle('ollama:status', async () => ({
    running: await ollamaRunning(),
    download: ollamaDownloadInfo(),
    suggested: SUGGESTED_OLLAMA_MODELS
  }))
  let pullCtrl: AbortController | null = null
  ipcMain.handle('ollama:pull', async (e, name: string) => {
    pullCtrl?.abort()
    pullCtrl = new AbortController()
    try {
      await pullOllamaModel(name, (p) => !e.sender.isDestroyed() && e.sender.send('ollama:pull-progress', { name, ...p }), pullCtrl.signal)
      store.setSettings({ ollamaModel: name })
      broadcast('settings:changed', store.getSettings())
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.on('ollama:pull-cancel', () => pullCtrl?.abort())
  ipcMain.handle('system:info', async () => ({
    platform: process.platform,
    selection: await selectionSupport(),
    dataDir: app.getPath('userData')
  }))
  ipcMain.handle('app:openUrl', (_e, url: string) => {
    if (/^(https?:|ms-settings:|x-apple\.systempreferences:)/.test(url)) void shell.openExternal(url)
  })

  // Atalhos
  ipcMain.handle('shortcuts:status', () => shortcutStatus)
  ipcMain.handle('shortcuts:set', (_e, name: ShortcutName, accel: string | null) => {
    const current = { ...(store.getSettings().shortcuts ?? {}) }
    if (accel) current[name] = accel
    else delete current[name]
    store.setSettings({ shortcuts: current })
    return registerShortcuts()
  })
  // Pausa os atalhos enquanto o usuário grava uma combinação nova.
  ipcMain.handle('shortcuts:pause', () => globalShortcut.unregisterAll())
  ipcMain.handle('shortcuts:resume', () => registerShortcuts())

  // Registro em arquivo e estado da gravação vindo da barra
  ipcMain.on('log', (_e, message: string) => log.warn('[barra]', String(message).slice(0, 2000)))
  ipcMain.on('rec:state', (_e, p: { status: RecState['status']; elapsed: number; sessionId?: string }) => {
    const changed = p.status !== recState.status
    recState = p
    if (changed) log.info(`[rec] ${p.status}`)
    updateTrayTitle()
    if (changed) refreshTray()
  })

  // Janelas
  ipcMain.on('bar:resize', (_e, h: number) => resizeBar(h))
  ipcMain.on('bar:hide', () => toggleBar(false))
  ipcMain.on('bar:focus', () => focusBar())
  ipcMain.on('main:open', (_e, route?: string) => openMain(route))
  ipcMain.on('onboarding:open', () => openOnboarding())

  // Sessões
  ipcMain.handle('session:start', (_e, modeId: string) => {
    // Só uma sessão ao vivo por vez: se havia outra aberta, ela é encerrada antes.
    if (activeSessionId) store.updateSession(activeSessionId, (x) => (x.endedAt ??= Date.now()))
    const s = store.createSession(modeId)
    activeSessionId = s.id
    listening = true
    refreshTray()
    broadcast('sessions:changed')
    return s
  })
  ipcMain.handle('session:stop', (_e, id: string, finalize = true) => {
    const s = store.updateSession(id, (x) => (x.endedAt = Date.now()))
    if (activeSessionId === id) activeSessionId = null
    listening = false
    recState = { status: 'idle', elapsed: 0 }
    refreshTray()
    broadcast('sessions:changed')
    log.info(`[session] ${id} encerrada (${s?.transcript.length ?? 0} falas ao vivo, ${s?.audio?.length ?? 0} partes de áudio)`)
    // A revisão roda em segundo plano: a barra fica livre na hora.
    if (finalize) void afterRecording(id)
    else store.pruneEmptySessions()
    return store.getSession(id)
  })
  ipcMain.handle('session:audioBegin', (_e, p: { sessionId: string; speaker: Speaker; startedAt: number; mime: string }) =>
    store.beginSessionAudio(p.sessionId, p.speaker, p.startedAt, p.mime)
  )
  ipcMain.handle('session:audioAppend', (_e, sessionId: string, file: string, data: ArrayBuffer) =>
    store.appendSessionAudio(sessionId, file, data)
  )
  ipcMain.handle('session:audioFinish', (_e, sessionId: string, file: string, wav: ArrayBuffer | undefined, durationMs: number) =>
    store.finishSessionAudio(sessionId, file, wav, durationMs)
  )
  ipcMain.handle('session:finalizeStatus', () => finalizeStatuses())
  // Transcrição no computador (modelos baixados de dentro do app)
  ipcMain.handle('stt:status', () => localModelsStatus())
  ipcMain.handle('stt:download', () => downloadModels((st) => broadcast('stt:progress', st)))
  ipcMain.on('stt:cancel', () => cancelDownload())
  ipcMain.handle('session:summarize', async (_e, id: string) => {
    try {
      await runAsk({ requestId: randomUUID(), kind: 'summary', sessionId: id }, { signal: AbortSignal.timeout(600_000), onText: () => {} })
      broadcast('sessions:changed')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: humanizeError(err).message }
    }
  })
  ipcMain.handle('session:renameSpeaker', (_e, id: string, label: string, name: string) => {
    store.updateSession(id, (s) => {
      s.speakerNames = { ...(s.speakerNames ?? {}), [label]: name.trim() }
      if (!name.trim()) delete s.speakerNames[label]
    })
    broadcast('sessions:changed')
  })
  ipcMain.handle('session:refinalize', async (_e, id: string, force = false) => {
    const result = await finalizeSession(id, { force, onStatus: (st) => broadcast('session:finalize', st) })
    broadcast('sessions:changed')
    return { ok: result.state === 'done' || result.state === 'partial', error: result.error }
  })
  ipcMain.handle('session:list', () => store.listSessions())
  ipcMain.handle('session:get', (_e, id: string) => store.getSession(id))
  ipcMain.handle('session:rename', (_e, id: string, title: string) => {
    store.updateSession(id, (s) => (s.title = title.trim() || s.title))
    broadcast('sessions:changed')
  })
  ipcMain.handle('session:delete', (_e, id: string) => {
    store.deleteSession(id)
    broadcast('sessions:changed')
  })
  ipcMain.handle('session:export', async (e, id: string) => {
    const s = store.getSession(id)
    if (!s) return false
    const win = BrowserWindow.fromWebContents(e.sender)!
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${s.title.replace(/[/\\:]/g, '-')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return false
    await writeFile(res.filePath, sessionToMarkdown(s), 'utf8')
    return true
  })
  ipcMain.handle('session:markdown', (_e, id: string) => {
    const s = store.getSession(id)
    return s ? sessionToMarkdown(s) : ''
  })

  // Transcrição: o renderer manda pedaços de áudio já filtrados por silêncio.
  ipcMain.handle('transcribe:chunk', async (_e, p: { sessionId: string; speaker: Speaker; audio: ArrayBuffer; mime: string; at: number }) => {
    // O final do que já foi dito vai como contexto: mantém nomes e termos consistentes.
    const context = (store.getSession(p.sessionId)?.transcript ?? []).slice(-6).map((l) => l.text).join(' ')
    const text = await transcribeChunk(p.audio, p.mime, context)
    if (!text) return null
    const line = { id: randomUUID(), speaker: p.speaker, text, at: p.at }
    let removed: string[] = []
    let dropped = false
    store.updateSession(p.sessionId, (s) => {
      const recent = s.transcript.slice(-12)
      if (isEcho(line, recent, 25_000)) {
        dropped = true // eco dos alto-falantes captado pelo microfone
        return
      }
      if (line.speaker === 'them') {
        removed = echoesOf(line, recent, 25_000)
        if (removed.length) s.transcript = s.transcript.filter((l) => !removed.includes(l.id))
      }
      s.transcript.push(line)
      s.transcript.sort((a, b) => a.at - b.at)
    })
    if (dropped) return null
    broadcast('transcript:line', { sessionId: p.sessionId, line, removed })
    return line
  })

  // IA com streaming
  ipcMain.handle('ai:ask', async (e, req: AskRequest) => {
    const ctrl = new AbortController()
    inflight.set(req.requestId, ctrl)
    const send = (ch: string, payload: unknown) => !e.sender.isDestroyed() && e.sender.send(ch, payload)
    try {
      let screen: Awaited<ReturnType<typeof captureScreen>> | undefined
      if (req.includeScreen) {
        try {
          const b = barWindow()
          screen = await captureScreen(b ? [b] : [], promptBudget(undefined, true).imageMaxSide)
        } catch (err) {
          // Responde mesmo assim, só sem a tela, e avisa o motivo.
          send('ai:notice', {
            requestId: req.requestId,
            message: 'Respondendo sem ver a tela: o macOS ainda não liberou a Gravação de Tela para este build do Lumen.',
            action: 'screen-permission'
          })
          console.warn('[lumen] captura falhou:', (err as Error).message)
        }
      }
      const { full, messageId } = await runAsk(req, {
        signal: ctrl.signal,
        screen,
        onText: (text) => send('ai:chunk', { requestId: req.requestId, text }),
        onFallback: (from, to) =>
          send('ai:notice', {
            requestId: req.requestId,
            message: `${from} sobrecarregado no momento: esta resposta veio da ${({ groq: 'Groq', gemini: 'Gemini', anthropic: 'Claude', openai: 'OpenAI' } as Record<string, string>)[to] ?? to}.`
          }),
        onNotice: (message) => send('ai:notice', { requestId: req.requestId, message })
      })
      send('ai:done', { requestId: req.requestId, full, messageId })
      if (req.sessionId) broadcast('sessions:changed')
    } catch (err) {
      if (ctrl.signal.aborted) {
        send('ai:error', { requestId: req.requestId, message: 'Cancelado.', config: false })
      } else {
        console.error('[lumen] erro na resposta:', err)
        const { message, config } = humanizeError(err)
        send('ai:error', { requestId: req.requestId, message, config })
      }
    } finally {
      inflight.delete(req.requestId)
    }
  })
  ipcMain.on('ai:cancel', (_e, requestId: string) => inflight.get(requestId)?.abort())

  // Ações sobre a seleção
  ipcMain.handle('selection:replace', async (_e, text: string) => {
    toggleBar(false)
    await new Promise((r) => setTimeout(r, 150))
    await pasteText(text)
  })
  ipcMain.handle('selection:replaceable', () => REPLACEABLE)
}

// ---------- Ciclo de vida ----------
app.on('second-instance', () => openMain('home'))

app.whenReady().then(() => {
  store.ensureDirs()
  log.info(`[app] Lumen ${app.getVersion()} iniciado (${process.platform}); log em ${logPath()}`)
  // Sessões que ficaram abertas (app fechou ou travou gravando): encerra e revisa com o áudio salvo.
  const orphans = store.closeOrphanSessions()
  store.pruneEmptySessions()
  if (process.platform === 'darwin') app.dock?.setIcon(resource('icon.png'))
  applyDock()
  applyLoginItem(store.getSettings().openAtLogin)
  registerIpc()
  buildTray()
  registerShortcuts()

  const settings = store.getSettings()
  const startedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden')
  onBarCreated(watchBar)
  createBar(settings.onboardingDone && !settings.launchHidden && !startedAtLogin)
  // Revisa (uma de cada vez) as gravações que ficaram sem revisão: sessões interrompidas e revisões que não terminaram.
  const pending = [...new Set([...orphans, ...store.sessionsPendingReview()])].filter((id) => store.getSession(id)?.audio?.length)
  if (pending.length) log.info(`[app] ${pending.length} sessão(ões) aguardando revisão: ${pending.join(', ')}`)
  // Só depois que a barra carregou: ler as chaves pode abrir o pedido de senha do Keychain, que
  // bloqueia o app até ser respondido — não pode acontecer enquanto a barra ainda está carregando.
  if (pending.length)
    setTimeout(() => void pending.reduce((chain, id) => chain.then(() => afterRecording(id)), Promise.resolve()), 15_000)

  // Enquanto grava, a barra fica acima de tudo (inclusive de apps em tela cheia, como a chamada).
  setInterval(() => {
    if (recState.status === 'recording' || recState.status === 'paused') keepBarOnTop()
  }, 5000)
  if (!settings.onboardingDone) openOnboarding()
  else if (!startedAtLogin) openMain('home')

  const appMenu = Menu.buildFromTemplate([
    {
      label: 'Lumen',
      submenu: [
        { role: 'about', label: 'Sobre o Lumen' },
        { label: 'Configurações…', accelerator: 'CommandOrControl+,', click: () => openMain('settings') },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Lumen' },
        { role: 'quit', label: 'Sair do Lumen' }
      ]
    },
    { role: 'editMenu', label: 'Editar' },
    { role: 'windowMenu', label: 'Janela' }
  ])
  // No Windows e no Linux o Lumen não usa barra de menus (tudo fica na bandeja e nas janelas).
  Menu.setApplicationMenu(process.platform === 'darwin' ? appMenu : null)
})

app.on('activate', () => openMain('home'))
app.on('window-all-closed', () => {
  /* o Lumen continua rodando na barra de menus */
})
// Encerramento de verdade: Dock → Encerrar, ⌘Q ou "Sair do Lumen" fecham tudo.
app.on('before-quit', () => {
  setQuitting()
  if (activeSessionId) store.updateSession(activeSessionId, (x) => (x.endedAt ??= Date.now()))
  globalShortcut.unregisterAll()
  stopLocalStt()
  cancelDownload()
  for (const ctrl of inflight.values()) ctrl.abort()
  tray?.destroy()
  tray = null
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy()
  // Rede de segurança: se algo segurar o processo, força a saída.
  setTimeout(() => app.exit(0), 2000).unref()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
