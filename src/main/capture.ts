import { BrowserWindow, desktopCapturer, screen, systemPreferences } from 'electron'
import type { LlmImage } from './ai'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ScreenPermissionError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))])
}

/**
 * Captura a tela onde está o cursor. As janelas do Lumen ficam transparentes
 * por um instante para não aparecerem na própria captura, e SEMPRE voltam a ficar
 * visíveis, mesmo se a captura falhar ou travar.
 */
export async function captureScreen(hide: BrowserWindow[] = [], maxSide = 1600): Promise<LlmImage> {
  // Sem permissão, nem tenta: chamar a API aqui só abriria o aviso do macOS e poderia travar.
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new ScreenPermissionError('Sem permissão de Gravação de Tela')
  }
  const visible = hide.filter((w) => !w.isDestroyed() && w.isVisible())
  visible.forEach((w) => w.setOpacity(0))
  try {
    await wait(120)
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    // Limita o maior lado: 1600px na nuvem, 1024px para modelos locais (menos tokens e mais rápido).
    const longest = Math.max(display.size.width, display.size.height) * display.scaleFactor
    const scale = Math.min(1, maxSide / longest)
    const thumbnailSize = {
      width: Math.round(display.size.width * display.scaleFactor * scale),
      height: Math.round(display.size.height * display.scaleFactor * scale)
    }
    const sources = await withTimeout(
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
      5000,
      'A captura de tela não respondeu'
    )
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) throw new ScreenPermissionError('Captura de tela vazia')
    return { mediaType: 'image/jpeg', base64: src.thumbnail.toJPEG(82).toString('base64') }
  } finally {
    visible.forEach((w) => !w.isDestroyed() && w.setOpacity(1))
  }
}
