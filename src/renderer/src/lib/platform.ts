/** Sistema em que o Lumen está rodando (vem do preload). */
export const platform: string = window.lumen?.platform ?? 'darwin'
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'
export const isLinux = platform === 'linux'

const MAC: Record<string, string> = {
  CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧',
  Return: '↩', Enter: '↩', Space: 'Espaço', Up: '↑', Down: '↓', Left: '←', Right: '→'
}
const PC: Record<string, string> = {
  CommandOrControl: 'Ctrl', Command: 'Ctrl', Cmd: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift',
  Return: 'Enter', Enter: 'Enter', Space: 'Espaço', Up: '↑', Down: '↓', Left: '←', Right: '→'
}

/** Mostra um atalho do jeito de cada sistema: "⌘ ⇧ M" no Mac, "Ctrl+Shift+M" no Windows/Linux. */
export function kbd(accel: string): string {
  const parts = accel.split('+').map((k) => (isMac ? MAC : PC)[k] ?? k)
  return isMac ? parts.join(' ') : parts.join('+')
}

/** Versão compacta para dicas (tooltips): "⌘⇧M" ou "Ctrl+Shift+M". */
export const hint = (accel: string) => (isMac ? kbd(accel).replace(/ /g, '') : kbd(accel))
