import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DraftpilotApi } from '@shared/index'

// Typsichere, minimale API fuer den Renderer (contextIsolation an).
// Channel-Namen kommen aus dem geteilten IPC-Vertrag (src/shared).

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DraftpilotApi = {
  getState: () => ipcRenderer.invoke(IPC.stateGet),
  getLogs: () => ipcRenderer.invoke(IPC.logsGet),
  getChampions: () => ipcRenderer.invoke(IPC.championsGet),
  setSettings: (partial) => ipcRenderer.invoke(IPC.settingsSet, partial),
  setRole: (role, prefs) => ipcRenderer.invoke(IPC.roleSet, role, prefs),
  onState: (cb) => subscribe(IPC.stateUpdate, cb),
  onLog: (cb) => subscribe(IPC.logAppend, cb),
  onChampions: (cb) => subscribe(IPC.championsUpdate, cb)
}

contextBridge.exposeInMainWorld('api', api)
