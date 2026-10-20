// Typen & Konstanten des Frontends. Spiegeln das Rust-Modell (src-tauri/src/model.rs),
// das per Tauri-Befehl/Event als JSON (camelCase) ankommt.

export const APP_NAME = 'Draftpilot'

/** Gameflow-Phasen des LCU (`/lol-gameflow/v1/gameflow-phase`). */
export type GameflowPhase =
  | 'None'
  | 'Lobby'
  | 'Matchmaking'
  | 'CheckedIntoTournament'
  | 'ReadyCheck'
  | 'ChampSelect'
  | 'GameStart'
  | 'FailedToLaunch'
  | 'InProgress'
  | 'Reconnect'
  | 'WaitingForStats'
  | 'PreEndOfGame'
  | 'EndOfGame'
  | 'TerminatedInError'

export type LogLevel = 'info' | 'warn' | 'error' | 'event'

export interface LogEntry {
  ts: number
  scope: string
  level: LogLevel
  message: string
}

// --- Rollen & Praeferenzen ---------------------------------------------------

/**
 * Rollen-Schluessel = LCU-`assignedPosition`-Werte. `none` greift, wenn der Client
 * keine Rolle zuweist (Blind Pick, Normal ohne Rollenwahl).
 */
export type Role = 'top' | 'jungle' | 'middle' | 'bottom' | 'utility' | 'none'

export const ROLES: readonly Role[] = ['top', 'jungle', 'middle', 'bottom', 'utility', 'none']

/** Maximale Laenge je Pick-/Ban-Liste (Erstwahl + Fallbacks). */
export const MAX_LIST = 6

/** Platzhalter in der Pick-Liste: zufaelliger eigener Champion, der zur Rolle passt. */
export const RANDOM_PICK = -1

/** Geordnete Wunschlisten einer Rolle (numerische Riot-Champion-IDs, Erstwahl zuerst). */
export interface RolePrefs {
  picks: number[]
  bans: number[]
}

export type RolePrefsMap = Record<Role, RolePrefs>

/** 'auto-lock' = kurz vor Ablauf locken; 'hover-only' = nur hovern, Nutzer lockt selbst. */
export type LockMode = 'auto-lock' | 'hover-only'

/** GUI-Sprache (Englisch ist Standard). Logs sind immer Englisch. */
export type Language = 'en' | 'de'

export const LANGUAGES: readonly Language[] = ['en', 'de']

/** Einstellungen. Master uebersteuert alles: ist er aus, tut das Tool nichts. */
export interface Settings {
  language: Language
  masterEnabled: boolean
  autoAccept: boolean
  autoPick: boolean
  autoBan: boolean
  lockMode: LockMode
  /** Locken/Bannen, sobald die Restzeit der eigenen Action darunter faellt (ms). */
  lockThresholdMs: number
}

export const LOCK_THRESHOLD_MIN_MS = 1000
export const LOCK_THRESHOLD_MAX_MS = 15000

// --- Champions (Data Dragon / LCU) ------------------------------------------

export interface Champion {
  /** Numerische Riot-ID (= LCU championId). */
  id: number
  /** Data-Dragon-Key, z. B. "MonkeyKing" (fuer Icon-URLs). */
  alias: string
  /** Lokalisierter Anzeigename, z. B. "Wukong". */
  name: string
}

export interface ChampionCatalog {
  /** Data-Dragon-Version der Icons (null = Liste stammt aus der LCU, keine Icons). */
  version: string | null
  champions: Champion[]
}

// --- Live-Zustand der Champ Select -----------------------------------------

export type ActionStatus =
  | 'waiting' // Ziel steht fest, unsere Action ist noch nicht dran
  | 'hovering' // gehovert, Lock folgt kurz vor Ablauf
  | 'hover-only' // gehovert, Lock-Modus "nur hovern"
  | 'done' // gelockt / gebannt
  | 'manual' // Nutzer hat selbst gewaehlt -> Automatik pausiert
  | 'none' // kein Champion der Liste verfuegbar
  | 'empty' // Liste fuer diese Rolle leer
  | 'off' // Feature deaktiviert

export interface ActionView {
  status: ActionStatus
  championId: number | null
  /** Geplanter Lock-Zeitpunkt (epoch ms) fuer den GUI-Countdown, sonst null. */
  lockAt: number | null
}

export interface LiveView {
  role: Role
  pick: ActionView | null
  ban: ActionView | null
}

// --- GUI <-> Backend-Vertrag (Rust-Gegenstueck: src-tauri/src/model.rs) ------

export type LcuStatus = 'searching' | 'connected'

/** Vollstaendiger UI-Zustand, den das Backend an die GUI pusht. */
export interface UiState {
  version: string
  lcu: LcuStatus
  phase: GameflowPhase | null
  summonerRiotId: string | null
  settings: Settings
  roles: RolePrefsMap
  /** Nur waehrend einer Champ Select gesetzt. */
  live: LiveView | null
}

/** Backend-Schnittstelle fuer die GUI (Tauri-Befehle + Events, siehe src/api.ts). */
export interface DraftpilotApi {
  getState(): Promise<UiState>
  getLogs(): Promise<LogEntry[]>
  getChampions(): Promise<ChampionCatalog>
  setSettings(partial: Partial<Settings>): Promise<UiState>
  setRole(role: Role, prefs: RolePrefs): Promise<UiState>
  onState(cb: (state: UiState) => void): () => void
  onLog(cb: (entry: LogEntry) => void): () => void
  onChampions(cb: (catalog: ChampionCatalog) => void): () => void
}
