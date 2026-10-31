import { clipboard, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const platform = process.platform

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  )
}

function has(cmd: string): Promise<boolean> {
  return run(platform === 'win32' ? 'where' : 'which', [cmd]).then(
    () => true,
    () => false
  )
}

/** Envia ⌘C/Ctrl+C ou ⌘V/Ctrl+V ao app em primeiro plano, do jeito de cada sistema. */
async function sendShortcut(key: 'c' | 'v'): Promise<void> {
  if (platform === 'darwin') {
    await run('osascript', ['-e', `tell application "System Events" to keystroke "${key}" using command down`])
  } else if (platform === 'win32') {
    // SendKeys do Windows: "^c" = Ctrl+C. Não exige permissão especial.
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^${key}')`
    ])
  } else {
    // Linux: xdotool (X11) ou wtype/ydotool (Wayland).
    if (await has('xdotool')) await run('xdotool', ['key', '--clearmodifiers', `ctrl+${key}`])
    else if (await has('wtype')) await run('wtype', ['-M', 'ctrl', key, '-m', 'ctrl'])
    else if (await has('ydotool')) await run('ydotool', ['key', '29:1', key === 'c' ? '46:1' : '47:1', key === 'c' ? '46:0' : '47:0', '29:0'])
    else throw new Error('LINUX_TOOL')
  }
}

/** Indica se o Lumen consegue simular o atalho de copiar/colar neste computador. */
export async function selectionSupport(): Promise<'ok' | 'needs-accessibility' | 'needs-linux-tool'> {
  if (platform === 'darwin') return systemPreferences.isTrustedAccessibilityClient(false) ? 'ok' : 'needs-accessibility'
  if (platform === 'linux') {
    for (const t of ['xdotool', 'wtype', 'ydotool']) if (await has(t)) return 'ok'
    return 'needs-linux-tool'
  }
  return 'ok'
}

export function canControlKeyboard(): boolean {
  return platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false)
}

/**
 * Lê o texto selecionado no app em primeiro plano simulando copiar,
 * e devolve a área de transferência ao estado anterior.
 */
export async function grabSelection(): Promise<string> {
  if (!canControlKeyboard()) throw new Error('ACCESSIBILITY')
  const previous = await clipboard.readText()
  const marker = `__lumen_${Date.now()}__`
  await clipboard.writeText(marker)
  await sendShortcut('c')
  let text = ''
  for (let i = 0; i < 15; i++) {
    await wait(40)
    text = await clipboard.readText()
    if (text !== marker) break
  }
  await clipboard.writeText(previous)
  return text === marker ? '' : text.trim()
}

/** Cola um texto no app em primeiro plano (substitui a seleção) e restaura a área de transferência. */
export async function pasteText(text: string): Promise<void> {
  if (!canControlKeyboard()) throw new Error('ACCESSIBILITY')
  const previous = await clipboard.readText()
  await clipboard.writeText(text)
  await sendShortcut('v')
  await wait(250)
  await clipboard.writeText(previous)
}
