import { app, BrowserWindow, ipcMain } from 'electron'
import {
  IPC,
  ROLES,
  ROLE_LABEL,
  type LogEntry,
  type Role,
  type RolePrefs,
  type Toggles,
  type UiState
} from '@shared/index'
import { getLogHistory, setLogSink, type Logger } from './logger'
import { applyToggles, sanitizeRolePrefs, save } from './settings'
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
    toggles: { ...store.toggles },
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

  ipcMain.handle(IPC.stateGet, () => buildState(store))
  ipcMain.handle(IPC.logsGet, () => getLogHistory())
  ipcMain.handle(IPC.championsGet, () => champions.get())

  ipcMain.handle(IPC.togglesSet, (_e, partial: Partial<Toggles>) => {
    applyToggles(store.toggles, partial ?? {})
    log.info(`Einstellung geaendert: ${JSON.stringify(partial)}`)
    store.touch()
    engine.refresh()
    return buildState(store)
  })

  ipcMain.handle(IPC.roleSet, (_e, role: Role, prefs: RolePrefs) => {
    if (!ROLES.includes(role)) return buildState(store)
    store.roles[role] = sanitizeRolePrefs(prefs)
    const fmt = (ids: number[]): string => ids.map((id) => champions.name(id)).join(', ') || '-'
    log.info(
      `${ROLE_LABEL[role]}: Picks [${fmt(store.roles[role].picks)}], ` +
        `Bans [${fmt(store.roles[role].bans)}]`
    )
    store.touch()
    engine.refresh()
    return buildState(store)
  })
}
