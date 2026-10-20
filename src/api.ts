import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import type { DraftpilotApi } from '@shared/index'

// Backend-Anbindung: in Tauri ueber Befehle + Events (Rust: src-tauri/src/app.rs).
// Im normalen Browser (`npm run vite:dev`) laeuft die GUI gegen Beispieldaten (mockApi).

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null
  let cancelled = false
  void listen<T>(event, (e) => cb(e.payload)).then((off) => {
    if (cancelled) off()
    else unlisten = off
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

const tauriApi: DraftpilotApi = {
  getState: () => invoke('get_state'),
  getLogs: () => invoke('get_logs'),
  getChampions: () => invoke('get_champions'),
  setSettings: (patch) => invoke('set_settings', { patch }),
  setRole: (role, prefs) => invoke('set_role', { role, prefs }),
  installUpdate: () => invoke('install_update'),
  onState: (cb) => subscribe('state', cb),
  onLog: (cb) => subscribe('log', cb),
  onChampions: (cb) => subscribe('champions', cb)
}

export const isTauri = '__TAURI_INTERNALS__' in window

export async function loadApi(): Promise<DraftpilotApi> {
  if (isTauri) return tauriApi
  const { mockApi } = await import('./mockApi')
  return mockApi
}

const MIN_HEIGHT = 420

/** Fensterhoehe auf den Inhalt bringen (begrenzt durch den Bildschirm). Waechst das Fenster
 *  ueber den unteren Rand, rueckt es nach oben. `center` nur beim ersten Anzeigen. */
export async function fitWindow(height: number, center = false): Promise<void> {
  if (!isTauri || height <= 0) return
  const win = getCurrentWindow()
  try {
    const { availTop, availHeight } = window.screen as Screen & { availTop: number }
    const target = Math.round(Math.min(Math.max(height, MIN_HEIGHT), availHeight - 16))
    if (Math.abs(target - window.innerHeight) > 1) {
      await win.setSize(new LogicalSize(window.innerWidth, target))
    }
    if (center) {
      await win.center()
      return
    }
    const overflow = window.screenY + target - (availTop + availHeight)
    if (overflow > 0) {
      const y = Math.max(availTop, window.screenY - overflow)
      await win.setPosition(new LogicalPosition(window.screenX, y))
    }
  } catch {
    // Groesse ist Kosmetik - Hauptsache, das Fenster ist da.
  }
}

/** Das Fenster startet unsichtbar (dunkler Hintergrund); nach dem Einpassen einblenden. */
export async function showWindow(): Promise<void> {
  if (isTauri) await getCurrentWindow().show()
}
