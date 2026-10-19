import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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
