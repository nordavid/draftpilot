import { app, BrowserWindow, ipcMain } from 'electron'
import {
  IPC,
  ROLES,
  type LogEntry,
  type Role,
  type RolePrefs,
  type Settings,
  type UiState
} from '@shared/index'
import { getLogHistory, setLogSink, type Logger } from './logger'
import { applySettings, sanitizeRolePrefs, save } from './settings'
import type { Store } from './state/store'
import type { ChampionData } from './data/champions'
import type { ChampSelectEngine } from './features/champSelectEngine'

// GUI-Bruecke: beantwortet Renderer-Anfragen und pusht UI-State, Log-Eintraege und
// Champion-Katalog. Quelle der Wahrheit bleibt der Store.

function buildState(store: Store): UiState {
  return {
    version: app.getVersion(),
    lcu: store.lcuStatus,
    phase: store.phase,
    summonerRiotId: store.summonerRiotId,
    settings: { ...store.settings },
    roles: structuredClone(store.roles),
    live: store.live
  }
}

export function setupIpc(
  store: Store,
  champions: ChampionData,
  engine: ChampSelectEngine,
  log: Logger
): void {
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  setLogSink((entry: LogEntry) => broadcast(IPC.logAppend, entry))
  champions.on('change', (catalog) => broadcast(IPC.championsUpdate, catalog))

  // Debounced State-Push + Persistenz bei jeder Store-Aenderung.
  let stateTimer: NodeJS.Timeout | null = null
  let persistTimer: NodeJS.Timeout | null = null
  store.on('change', () => {
    if (!stateTimer) {
      stateTimer = setTimeout(() => {
        stateTimer = null
        broadcast(IPC.stateUpdate, buildState(store))
      }, 50)
    }
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null
        save(store)
      }, 500)
    }
  })

  // Beim Beenden ausstehende Aenderungen sofort schreiben (sonst gingen die letzten
  // ~500 ms nach einer Aenderung verloren).
  app.on('before-quit', () => {
    if (!persistTimer) return
    clearTimeout(persistTimer)
    persistTimer = null
    save(store)
  })

  ipcMain.handle(IPC.stateGet, () => buildState(store))
  ipcMain.handle(IPC.logsGet, () => getLogHistory())
  ipcMain.handle(IPC.championsGet, () => champions.get())

  ipcMain.handle(IPC.settingsSet, (_e, partial: Partial<Settings>) => {
    const languageBefore = store.settings.language
    applySettings(store.settings, partial ?? {})
    log.info(`Setting changed: ${JSON.stringify(partial)}`)
    if (store.settings.language !== languageBefore) champions.setLanguage(store.settings.language)
    store.touch()
    engine.refresh()
    return buildState(store)
  })

  ipcMain.handle(IPC.roleSet, (_e, role: Role, prefs: RolePrefs) => {
    if (!ROLES.includes(role)) return buildState(store)
    store.roles[role] = sanitizeRolePrefs(prefs)
    const fmt = (ids: number[]): string => ids.map((id) => champions.name(id)).join(', ') || '-'
    log.info(
      `Role ${role}: picks [${fmt(store.roles[role].picks)}], ` +
        `bans [${fmt(store.roles[role].bans)}]`
    )
    store.touch()
    engine.refresh()
    return buildState(store)
  })
}
