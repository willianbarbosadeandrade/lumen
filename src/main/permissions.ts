import { desktopCapturer, shell, systemPreferences } from 'electron'
import type { PermissionKind, PermissionState, PermissionsStatus } from '@shared/types'

const platform = process.platform

/** Onde cada permissão é liberada, em cada sistema. */
const PANES: Record<'darwin' | 'win32', Partial<Record<PermissionKind, string>>> = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  },
  win32: {
    microphone: 'ms-settings:privacy-microphone'
  }
}

export function permissionsStatus(): PermissionsStatus {
  if (platform === 'darwin') {
    return {
      microphone: systemPreferences.getMediaAccessStatus('microphone') as PermissionState,
      screen: systemPreferences.getMediaAccessStatus('screen') as PermissionState,
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
    }
  }
  if (platform === 'win32') {
    // No Windows, só o microfone tem chave de privacidade; tela e áudio do sistema não pedem permissão.
    const mic = systemPreferences.getMediaAccessStatus('microphone') as PermissionState
    return { microphone: mic === 'unknown' ? 'granted' : mic, screen: 'granted', accessibility: 'granted' }
  }
  // Linux: o áudio passa pelo PipeWire/PulseAudio e a tela pelo portal do sistema, sem lista de permissões.
  return { microphone: 'granted', screen: 'granted', accessibility: 'granted' }
}

export async function requestPermission(kind: PermissionKind): Promise<PermissionsStatus> {
  if (platform === 'darwin') {
    if (kind === 'microphone') {
      const st = systemPreferences.getMediaAccessStatus('microphone')
      if (st === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
      else if (st !== 'granted') await shell.openExternal(PANES.darwin.microphone!)
    } else if (kind === 'screen') {
      // Pedir as fontes faz o macOS registrar o Lumen na lista de Gravação de Tela e Áudio do Sistema.
      try {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      } catch {
        /* esperado quando ainda não há permissão */
      }
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') await shell.openExternal(PANES.darwin.screen!)
    } else {
      // Passar `true` abre o aviso do sistema e adiciona o app à lista de Acessibilidade.
      if (!systemPreferences.isTrustedAccessibilityClient(true)) await shell.openExternal(PANES.darwin.accessibility!)
    }
  } else if (platform === 'win32' && kind === 'microphone') {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'denied') await shell.openExternal(PANES.win32.microphone!)
  }
  return permissionsStatus()
}

export function openPermissionPane(kind: PermissionKind): void {
  const url = platform === 'darwin' ? PANES.darwin[kind] : platform === 'win32' ? PANES.win32[kind] : undefined
  if (url) void shell.openExternal(url)
}
