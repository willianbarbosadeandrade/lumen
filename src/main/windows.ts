import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'

let bar: BrowserWindow | null = null
let main: BrowserWindow | null = null
let onboarding: BrowserWindow | null = null
let quitting = false

/** Marca que o app está encerrando: nenhuma janela deve ser reaberta a partir daqui. */
export function setQuitting(): void {
  quitting = true
}

export const BAR_WIDTH = 760
const BAR_MIN_HEIGHT = 76
const BAR_MAX_HEIGHT = 720

function load(win: BrowserWindow, route: string): void {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${route}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

const preload = () => join(__dirname, '../preload/index.js')

/**
 * Barra de título de cada sistema: no macOS ela fica embutida (semáforo sobre o conteúdo);
 * no Windows e no Linux usa a barra normal do sistema, sem a barra de menus antiga.
 */
function chrome(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return { autoHideMenuBar: true, icon: join(app.getAppPath(), 'resources', 'icon.png') }
}

function externalLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

export function createBar(showOnReady: boolean): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  bar = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_MIN_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - BAR_WIDTH) / 2),
    y: workArea.y + 16,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Lumen',
    webPreferences: { preload: preload(), backgroundThrottling: false, sandbox: false }
  })
  bar.setAlwaysOnTop(true, 'floating')
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  externalLinks(bar)
  load(bar, 'bar')
  if (showOnReady) bar.once('ready-to-show', () => bar?.showInactive())
  bar.on('closed', () => (bar = null))
  return bar
}

export function getBar(): BrowserWindow | null {
  return bar && !bar.isDestroyed() ? bar : null
}

export function resizeBar(height: number): void {
  const b = getBar()
  if (!b) return
  const h = Math.max(BAR_MIN_HEIGHT, Math.min(BAR_MAX_HEIGHT, Math.round(height)))
  const [x, y] = b.getPosition()
  b.setBounds({ x, y, width: BAR_WIDTH, height: h }, false)
}

export function toggleBar(force?: boolean): void {
  if (quitting) return
  const b = getBar() ?? createBar(false)
  const show = force ?? !b.isVisible()
  if (show) {
    b.setOpacity(1) // garante que a barra nunca fique invisível
    b.showInactive()
    b.webContents.send('bar:shown')
  } else b.hide()
}

export function focusBar(): void {
  const b = getBar() ?? createBar(false)
  b.setOpacity(1)
  b.show()
  b.focus()
}

export function openMain(route = 'home'): BrowserWindow | null {
  if (quitting) return null
  if (main && !main.isDestroyed()) {
    main.webContents.send('nav', route)
    main.show()
    main.focus()
    return main
  }
  main = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Lumen',
    ...chrome(),
    backgroundColor: '#0d0e12',
    webPreferences: { preload: preload(), sandbox: false }
  })
  externalLinks(main)
  load(main, route)
  main.once('ready-to-show', () => main?.show())
  main.on('closed', () => (main = null))
  return main
}

export function openOnboarding(): BrowserWindow {
  if (onboarding && !onboarding.isDestroyed()) {
    onboarding.show()
    onboarding.focus()
    return onboarding
  }
  onboarding = new BrowserWindow({
    width: 940,
    height: 620,
    resizable: false,
    show: false,
    title: 'Configurar o Lumen',
    ...chrome(),
    backgroundColor: '#0d0e12',
    webPreferences: { preload: preload(), sandbox: false }
  })
  externalLinks(onboarding)
  load(onboarding, 'onboarding')
  onboarding.once('ready-to-show', () => onboarding?.show())
  onboarding.on('closed', () => {
    onboarding = null
    if (quitting) return
    // Nunca deixa o app sem nenhuma janela: se o onboarding fechar, mostra a tela inicial.
    const anyVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible())
    if (!anyVisible) openMain('home')
  })
  return onboarding
}

export function closeOnboarding(): void {
  if (onboarding && !onboarding.isDestroyed()) onboarding.close()
}

export function allWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of allWindows()) w.webContents.send(channel, payload)
}
