// Frontend types & constants. They mirror the Rust model (src-tauri/src/model.rs), which
// arrives as JSON (camelCase) via Tauri commands/events.

export const APP_NAME = 'Draftpilot'

/** LCU gameflow phases (`/lol-gameflow/v1/gameflow-phase`). */
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

// --- Roles & preferences ------------------------------------------------------

/**
 * Role key = LCU `assignedPosition` values. `none` = no role assigned (Arena, custom
 * games): Draftpilot then stays idle for picks and bans.
 */
export type Role = 'top' | 'jungle' | 'middle' | 'bottom' | 'utility' | 'none'

/** Roles with their own lists (tabs). */
export const ROLES: readonly Role[] = ['top', 'jungle', 'middle', 'bottom', 'utility']

/** Maximum length of a pick/ban list (first choice + fallbacks). */
export const MAX_LIST = 6

/** Placeholder in a pick list: a random owned champion that fits the role. */
export const RANDOM_PICK = -1

/** Lobby position preference: a role or Fill. */
export type Position = Exclude<Role, 'none'> | 'fill'

/** Ordered lists for one role (numeric Riot champion IDs, first choice first). */
export interface RolePrefs {
  picks: number[]
  bans: number[]
  /** Second role "Find match" queues with (the first one is this role). */
  secondRole: Position
}

export type RolePrefsMap = Record<Role, RolePrefs>

/** 'auto-lock' = lock shortly before the timer ends; 'hover-only' = hover, the user locks. */
export type LockMode = 'auto-lock' | 'hover-only'

/** GUI language (English is the default). Logs are always English. */
export type Language = 'en' | 'de'

export const LANGUAGES: readonly Language[] = ['en', 'de']

/** Settings. The master switch overrides everything: when it's off, the tool does nothing. */
export interface Settings {
  language: Language
  masterEnabled: boolean
  autoAccept: boolean
  autoPick: boolean
  autoBan: boolean
  lockMode: LockMode
  /** Lock/ban once the remaining time of our action drops below this (ms). */
  lockThresholdMs: number
}

export const LOCK_THRESHOLD_MIN_MS = 1000
export const LOCK_THRESHOLD_MAX_MS = 15000

// --- Champions (Data Dragon / LCU) ------------------------------------------

export interface Champion {
  /** Numeric Riot ID (= LCU championId). */
  id: number
  /** Data Dragon key, e.g. "MonkeyKing" (for icon URLs). */
  alias: string
  /** Localized display name, e.g. "Wukong". */
  name: string
}

export interface ChampionCatalog {
  /** Data Dragon version for icons (null = list came from the LCU, no icons). */
  version: string | null
  champions: Champion[]
}

// --- Live champ select state ---------------------------------------------------

export type ActionStatus =
  | 'waiting' // target known, our action isn't active yet
  | 'hovering' // hovered, lock follows shortly before the timer ends
  | 'hover-only' // hovered, lock mode "hover only"
  | 'done' // locked in / banned
  | 'manual' // the user chose manually -> automation paused
  | 'none' // no champion from the list available
  | 'empty' // list for this role is empty
  | 'off' // feature disabled

export interface ActionView {
  status: ActionStatus
  championId: number | null
  /** Planned lock time (epoch ms) for the GUI countdown, otherwise null. */
  lockAt: number | null
}

export interface LiveView {
  role: Role
  pick: ActionView | null
  ban: ActionView | null
}

// --- GUI <-> backend contract (Rust counterpart: src-tauri/src/model.rs) -------

export type LcuStatus = 'searching' | 'connected'

/** Full UI state the backend pushes to the GUI. */
export interface UiState {
  version: string
  lcu: LcuStatus
  phase: GameflowPhase | null
  summonerRiotId: string | null
  settings: Settings
  roles: RolePrefsMap
  /** Only set during a champ select. */
  live: LiveView | null
  /** Newer version to install (updater), otherwise null. */
  update: string | null
}

/** Result of "Find match": queue started, or roles set in someone else's party lobby. */
export type QueueOutcome = 'searching' | 'roles-set'

/** Why "Find match" didn't work (details in the log). Rust: src-tauri/src/queue.rs */
export type QueueError = 'offline' | 'busy' | 'not-leader' | 'failed'

/** Phases from which "Find match" can open a lobby: home, lobby, post game. */
export const QUEUE_IDLE_PHASES: readonly GameflowPhase[] = ['None', 'Lobby', 'EndOfGame']

/** Backend interface for the GUI (Tauri commands + events, see src/api.ts). */
export interface DraftpilotApi {
  getState(): Promise<UiState>
  getLogs(): Promise<LogEntry[]>
  getChampions(): Promise<ChampionCatalog>
  setSettings(partial: Partial<Settings>): Promise<UiState>
  setRole(role: Role, prefs: RolePrefs): Promise<UiState>
  /** Ranked Solo/Duo with `role` first and its second role; rejects with a QueueError. */
  findMatch(role: Role): Promise<QueueOutcome>
  cancelSearch(): Promise<void>
  /** Downloads + installs the update; the app quits and restarts in the process. */
  installUpdate(): Promise<void>
  onState(cb: (state: UiState) => void): () => void
  onLog(cb: (entry: LogEntry) => void): () => void
  onChampions(cb: (catalog: ChampionCatalog) => void): () => void
}
