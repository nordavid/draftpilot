import { EventEmitter } from 'node:events'
import {
  ROLES,
  type GameflowPhase,
  type LcuStatus,
  type LiveView,
  type RolePrefsMap,
  type Settings
} from '@shared/index'

// Zentraler Laufzeit-Zustand: Quelle der Wahrheit fuer Settings, Rollen-Listen,
// Verbindungsstatus und den Live-Stand der Champ Select. Mutationen rufen `touch()`;
// die GUI-Bruecke pusht daraufhin (debounced) einen Snapshot und persistiert.

function emptyRoles(): RolePrefsMap {
  const roles = {} as RolePrefsMap
  for (const r of ROLES) roles[r] = { picks: [], bans: [] }
  return roles
}

export class Store extends EventEmitter {
  lcuStatus: LcuStatus = 'searching'
  phase: GameflowPhase | null = null
  summonerRiotId: string | null = null
  live: LiveView | null = null

  readonly settings: Settings = {
    language: 'en',
    masterEnabled: true,
    autoAccept: true,
    autoPick: true,
    autoBan: true,
    lockMode: 'auto-lock',
    lockThresholdMs: 3000
  }

  readonly roles: RolePrefsMap = emptyRoles()

  /** Signalisiert eine Zustandsaenderung (fuer die GUI-Bruecke). */
  touch(): void {
    this.emit('change')
  }
}
