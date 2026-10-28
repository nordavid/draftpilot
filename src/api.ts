import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import type { DraftpilotApi } from '@shared/index'

// Backend bridge: in Tauri via commands + events (Rust: src-tauri/src/app.rs).
// In a plain browser (`npm run vite:dev`) the GUI runs against sample data (mockApi).

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
  findMatch: (role) => invoke('find_match', { role }),
  cancelSearch: () => invoke('cancel_search'),
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

/** Fit the window height to the content (capped by the screen). If the window would grow
 *  past the bottom edge, it moves up. `center` only on first show. */
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
    // Size is cosmetic - what matters is that the window is there.
  }
}

/** The window starts hidden (dark background); show it after fitting. */
export async function showWindow(): Promise<void> {
  if (isTauri) await getCurrentWindow().show()
}
