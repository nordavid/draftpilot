import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import {
  LANGUAGES,
  LOCK_THRESHOLD_MAX_MS,
  LOCK_THRESHOLD_MIN_MS,
  MAX_LIST,
  ROLES,
  type RolePrefs,
  type Settings
} from '@shared/index'
import type { Logger } from './logger'
import type { Store } from './state/store'

// Einstellungen: Validierung (gemeinsam fuer config.json und GUI-Eingaben) und
// Persistenz in userData/config.json.

interface PersistedConfig {
  settings?: Partial<Settings>
  /** Schluessel aus v1.0.0 (damals "toggles"), wird beim Laden noch gelesen. */
  toggles?: Partial<Settings>
  roles?: Record<string, Partial<RolePrefs>>
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/** Uebernimmt nur gueltige Felder aus `input` in `target`. */
export function applySettings(target: Settings, input: Partial<Settings>): void {
  if (input.language && LANGUAGES.includes(input.language)) target.language = input.language
  if (typeof input.masterEnabled === 'boolean') target.masterEnabled = input.masterEnabled
  if (typeof input.autoAccept === 'boolean') target.autoAccept = input.autoAccept
  if (typeof input.autoPick === 'boolean') target.autoPick = input.autoPick
  if (typeof input.autoBan === 'boolean') target.autoBan = input.autoBan
  if (input.lockMode === 'auto-lock' || input.lockMode === 'hover-only') {
    target.lockMode = input.lockMode
  }
  if (typeof input.lockThresholdMs === 'number' && Number.isFinite(input.lockThresholdMs)) {
    target.lockThresholdMs = Math.min(
      LOCK_THRESHOLD_MAX_MS,
      Math.max(LOCK_THRESHOLD_MIN_MS, Math.round(input.lockThresholdMs))
    )
  }
}

/** Positive, eindeutige Champion-IDs in Eingabereihenfolge, gekappt auf MAX_LIST. */
function sanitizeList(input: unknown): number[] {
  if (!Array.isArray(input)) return []
  const out: number[] = []
  for (const v of input) {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0 && !out.includes(v)) out.push(v)
    if (out.length >= MAX_LIST) break
  }
  return out
}

export function sanitizeRolePrefs(input: Partial<RolePrefs> | undefined): RolePrefs {
  return { picks: sanitizeList(input?.picks), bans: sanitizeList(input?.bans) }
}

export function loadInto(store: Store, log: Logger): void {
  let data: PersistedConfig
  try {
    data = JSON.parse(readFileSync(configPath(), 'utf8')) as PersistedConfig
  } catch {
    log.info('No config.json yet - starting with defaults.')
    return
  }
  const settings = data.settings ?? data.toggles
  if (settings) applySettings(store.settings, settings)
  for (const role of ROLES) {
    const prefs = data.roles?.[role]
    if (prefs) store.roles[role] = sanitizeRolePrefs(prefs)
  }
  log.info('Settings loaded from config.json.')
}

export function save(store: Store): void {
  const data: PersistedConfig = { settings: store.settings, roles: store.roles }
  try {
    writeFileSync(configPath(), JSON.stringify(data, null, 2), 'utf8')
  } catch {
    // Schreibfehler nicht fatal.
  }
}
