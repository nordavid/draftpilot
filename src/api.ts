import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
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

const MIN_HEIGHT = 620

/** Das Fenster startet unsichtbar (dunkler Hintergrund). Sobald die GUI steht: auf die
 *  gemessene Hoehe bringen (begrenzt durch den Bildschirm), zentrieren, einblenden. */
export async function fitAndShowWindow(height: number): Promise<void> {
  if (!isTauri) return
  const win = getCurrentWindow()
  try {
    const max = window.screen.availHeight - 24
    const target = Math.round(Math.min(Math.max(height, MIN_HEIGHT), max))
    if (Math.abs(target - window.innerHeight) > 2) {
      await win.setSize(new LogicalSize(window.innerWidth, target))
      await win.center()
    }
  } catch {
    // Groesse ist Kosmetik - Hauptsache, das Fenster erscheint.
  }
  await win.show()
}
