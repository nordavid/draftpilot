import type { ActionStatus, ActionView, LiveView, Role } from '@shared/index'
import type { Logger } from '../logger'
import type { Store } from '../state/store'
import { CHAMP_SELECT_SESSION_URI, type LcuConnector } from '../lcu/connector'

// Champ-Select-Engine. Reagiert auf jedes /lol-champ-select/v1/session-Event:
//  - Rolle aus `assignedPosition` bestimmen (leer -> Liste "Ohne Rolle"),
//  - Pick: ersten verfuegbaren Champion der Rollen-Pickliste hovern (in der Planning-Phase
//    schon vorab) und kurz vor Ablauf der eigenen Pick-Action locken,
//  - Ban: ersten erlaubten Champion der Rollen-Banliste hovern und kurz vor Ablauf bannen.
//    Nie bannen, was ein Teammate (oder wir selbst) picken will.
//
// Der echte Pick des Nutzers hat IMMER Vorrang: Wir merken uns jeden Champion, den wir
// selbst in eine Action geschrieben haben. Taucht dort ein anderer auf, war es der Nutzer
// -> Automatik fuer diese Action in dieser Champ Select pausieren (kein Hover, kein Lock).

const PICKABLE_PATH = '/lol-champ-select/v1/pickable-champion-ids'
const BANNABLE_PATH = '/lol-champ-select/v1/bannable-champion-ids'
const ACTIONS_PATH = '/lol-champ-select/v1/session/actions'
/** Timer fortrechnen, da Champ-Select-Events nicht kontinuierlich feuern. */
const TICK_MS = 250
/** Draft-Declare-Phase: Pick-Absicht darf gehovert, aber nichts gelockt/gebannt werden. */
const PLANNING = 'PLANNING'
/** Echte Ban-/Pick-Runde. In PLANNING ist die Ban-Action zwar schon "isInProgress",
 *  ein Complete waere dort aber wirkungslos -> Bans nur in dieser Phase. */
const BAN_PICK = 'BAN_PICK'

type ActionType = 'pick' | 'ban'

interface ChampSelectAction {
  id: number
  actorCellId: number
  championId: number
  completed: boolean
  isInProgress: boolean
  type: string
}

interface ChampSelectPlayer {
  cellId: number
  championId: number
  championPickIntent: number
  assignedPosition: string
}

interface ChampSelectSession {
  localPlayerCellId: number
  actions: ChampSelectAction[][]
  myTeam?: ChampSelectPlayer[]
  bans?: { myTeamBans?: number[]; theirTeamBans?: number[] }
  timer?: { adjustedTimeLeftInPhase?: number; phase?: string }
}

function isSession(data: unknown): data is ChampSelectSession {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as ChampSelectSession).localPlayerCellId === 'number' &&
    Array.isArray((data as ChampSelectSession).actions)
  )
}

/** LCU-`assignedPosition` -> Rollen-Schluessel (leer/unbekannt -> 'none'). */
function toRole(assigned: string | undefined): Role {
  switch ((assigned ?? '').toLowerCase()) {
    case 'top':
      return 'top'
    case 'jungle':
      return 'jungle'
    case 'middle':
      return 'middle'
    case 'bottom':
      return 'bottom'
    case 'utility':
      return 'utility'
    default:
      return 'none'
  }
}

/** Automatik-Zustand einer eigenen Action (Pick bzw. Ban) innerhalb einer Champ Select. */
class Track {
  actionId: number | null = null
  target: number | null = null
  /** Alle Champions, die WIR in diese Action geschrieben haben (Hover/Lock). */
  writes = new Set<number>()
  /** Nutzer hat selbst gewaehlt -> Automatik fuer diese Action pausiert. */
  manual = false
  /** Wir haben die Action abgeschlossen (bzw. es laeuft gerade ein Versuch). */
  locked = false
  /** Timer-Snapshot fuer die zeitbasierte Lock-Entscheidung. */
  timeLeftMs = 0
  timeLeftAt = 0
  /** Lock-Zeitpunkt (epoch ms) fuer den GUI-Countdown, sonst null. */
  lockAt: number | null = null
  view: ActionView | null = null
  // Log-Dedup
  loggedTarget: number | null = null
  loggedNone = false
  loggedUnavailable = new Set<number>()
  lastError: string | null = null

  constructor(readonly type: ActionType) {}

  /** Neue Action (andere ID) -> frischer Zustand. */
  bind(actionId: number): void {
    if (this.actionId === actionId) return
    const type = this.type
    Object.assign(this, new Track(type))
    this.actionId = actionId
  }

  setView(status: ActionStatus, championId: number | null): void {
    this.view = { status, championId, lockAt: null }
  }
}

export class ChampSelectEngine {
  private active = false
  private session: ChampSelectSession | null = null
  private role: Role | null = null
  private pick = new Track('pick')
  private ban = new Track('ban')
  private tickTimer: NodeJS.Timeout | null = null
  private announcedPassive = false
  /** Serialisiert alle LCU-Schreibzugriffe, damit sich Hover/Lock nicht ueberholen. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly connector: LcuConnector,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly nameOf: (championId: number) => string
  ) {
    connector.on('event', (e) => {
      if (e.uri !== CHAMP_SELECT_SESSION_URI) return
      if (e.eventType === 'Delete' || !isSession(e.data)) {
        this.end()
        return
      }
      this.onSession(e.data)
    })
    connector.on('disconnected', () => this.end())
    // Tool waehrend laufender Champ Select gestartet: einmalig den Ist-Stand holen.
    connector.on('connected', () => this.enqueue(() => this.fetchInitial()))
  }

  /** Nach Aenderung von Toggles/Listen sofort neu bewerten (nicht erst beim naechsten Event). */
  refresh(): void {
    if (this.active) this.enqueue(() => this.evaluate())
  }

  private onSession(session: ChampSelectSession): void {
    this.session = session
    if (!this.active) {
      this.active = true
      this.log.event('Champ Select betreten.')
      this.startTicking()
    }
    this.enqueue(() => this.evaluate())
  }

  private async fetchInitial(): Promise<void> {
    const http = this.connector.client
    if (!http) return
    try {
      const { status, data } = await http.get(CHAMP_SELECT_SESSION_URI)
      if (status === 200 && isSession(data)) this.onSession(data)
    } catch {
      // Keine aktive Champ Select -> ignorieren.
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Engine-Fehler: ${msg}`)
    })
  }

  private enabled(type: ActionType): boolean {
    const t = this.store.toggles
    return t.masterEnabled && (type === 'pick' ? t.autoPick : t.autoBan)
  }

  private label(id: number): string {
    return `${this.nameOf(id)} (${id})`
  }

  // --- Session-Auswertung ---------------------------------------------------

  /** Eigene Action eines Typs: aktive zuerst, dann naechste offene, sonst die letzte erledigte. */
  private findOwnAction(session: ChampSelectSession, type: ActionType): ChampSelectAction | null {
    let open: ChampSelectAction | null = null
    let done: ChampSelectAction | null = null
    for (const group of session.actions) {
      for (const a of group) {
        if (a.actorCellId !== session.localPlayerCellId || a.type !== type) continue
        if (!a.completed && a.isInProgress) return a
        if (!a.completed) open ??= a
        else done = a
      }
    }
    return open ?? done
  }

  /** Bereits gebannte oder gelockte Champions (beide Teams). */
  private collectUnavailable(session: ChampSelectSession): Set<number> {
    const set = new Set<number>()
    for (const group of session.actions) {
      for (const a of group) {
        if (a.completed && a.championId > 0 && (a.type === 'ban' || a.type === 'pick')) {
          set.add(a.championId)
        }
      }
    }
    for (const id of session.bans?.myTeamBans ?? []) if (id > 0) set.add(id)
    for (const id of session.bans?.theirTeamBans ?? []) if (id > 0) set.add(id)
    return set
  }

  private allyCells(session: ChampSelectSession): Set<number> {
    return new Set((session.myTeam ?? []).map((p) => p.cellId))
  }

  /**
   * Champions, die Teammates (ohne uns) picken wollen: Pick-Absicht aus der
   * Planning-Phase, aktuelle Auswahl und Hover in ihren Pick-Actions.
   */
  private teammateClaims(session: ChampSelectSession): Set<number> {
    const me = session.localPlayerCellId
    const claims = new Set<number>()
    for (const p of session.myTeam ?? []) {
      if (p.cellId === me) continue
      if (p.championPickIntent > 0) claims.add(p.championPickIntent)
      if (p.championId > 0) claims.add(p.championId)
    }
    const allies = this.allyCells(session)
    for (const group of session.actions) {
      for (const a of group) {
        if (a.type === 'pick' && a.actorCellId !== me && allies.has(a.actorCellId)) {
          if (a.championId > 0) claims.add(a.championId)
        }
      }
    }
    return claims
  }

  /** Champion-IDs von einem LCU-Endpoint (pickable/bannable); null bei Fehler. */
  private async fetchIds(path: string): Promise<Set<number> | null> {
    const http = this.connector.client
    if (!http) return null
    try {
      const { status, data } = await http.get<number[]>(path)
      if (status !== 200 || !Array.isArray(data)) return null
      return new Set(data)
    } catch {
      return null
    }
  }

  private async evaluate(): Promise<void> {
    const session = this.session
    if (!session) return

    const me = session.myTeam?.find((p) => p.cellId === session.localPlayerCellId)
    const role = toRole(me?.assignedPosition)
    if (this.role !== role) {
      this.role = role
      this.log.info(`Rolle: ${role === 'none' ? 'keine zugewiesen (Liste "Ohne Rolle")' : role}.`)
    }
    const prefs = this.store.roles[role]

    if (!this.findOwnAction(session, 'pick') && !this.announcedPassive) {
      this.log.info('Keine eigene Pick-Action (z. B. ARAM) - Pick-Automatik bleibt passiv.')
      this.announcedPassive = true
    }

    // Pick zuerst: der Pick-Kandidat fliesst in die Ban-Ausschluesse ein.
    await this.evaluatePick(session, prefs.picks)
    await this.evaluateBan(session, prefs.bans)
    this.publish()
  }

  /**
   * Gemeinsamer Teil fuer Pick und Ban: Action binden, erledigte/manuelle Faelle
   * abhandeln. Gibt die offene Action zurueck, wenn die Automatik weitermachen darf.
   */
  private prepare(
    session: ChampSelectSession,
    t: Track,
    list: number[]
  ): ChampSelectAction | null {
    const action = this.findOwnAction(session, t.type)
    if (!action) {
      t.view = null
      return null
    }
    t.bind(action.id)

    if (action.completed) {
      const id = action.championId > 0 ? action.championId : null
      const ours = id !== null && t.writes.has(id) && !t.manual
      t.setView(ours ? 'done' : 'manual', id)
      return null
    }

    if (!this.enabled(t.type)) {
      t.setView('off', null)
      return null
    }

    // Manuelle Wahl erkennen: ein echter Champion in der Action, den wir nie geschrieben haben.
    const live = action.championId
    if (!t.manual && live > 0 && !t.writes.has(live)) {
      t.manual = true
      this.log.event(
        `Manueller ${t.type === 'pick' ? 'Pick' : 'Ban'} erkannt (${this.label(live)}) - ` +
          'Automatik fuer diese Champ Select pausiert.'
      )
    }
    if (t.manual) {
      t.setView('manual', live > 0 ? live : null)
      return null
    }

    if (list.length === 0) {
      t.target = null
      t.setView('empty', null)
      return null
    }
    return action
  }

  /** Ziel gefunden/geaendert bzw. keins verfuegbar -> einmalig loggen. */
  private noteTarget(t: Track, target: number | null): void {
    t.target = target
    const what = t.type === 'pick' ? 'Pick' : 'Ban'
    if (target === null) {
      if (!t.loggedNone) {
        this.log.warn(`${what}: kein Champion der Liste verfuegbar - nichts zu tun.`)
        t.loggedNone = true
      }
      t.loggedTarget = null
      return
    }
    t.loggedNone = false
    if (t.loggedTarget !== target) {
      this.log.event(`${what}-Ziel: ${this.label(target)}.`)
      t.loggedTarget = target
    }
  }

  private noteUnavailable(t: Track, id: number, reason: string): void {
    if (t.loggedUnavailable.has(id)) return
    t.loggedUnavailable.add(id)
    this.log.info(`${t.type === 'pick' ? 'Pick' : 'Ban'}: ${this.label(id)} uebersprungen (${reason}).`)
  }

  /** Schreibt einen Hover in die Action (merkt ihn als unseren, bevor das Echo eintrifft). */
  private async hover(t: Track, action: ChampSelectAction, target: number): Promise<boolean> {
    if (action.championId === target) return true
    t.writes.add(target)
    try {
      await this.patchAction(action.id, { championId: target })
      // Lokalen Stand sofort nachziehen, damit der Lock nicht auf das Echo-Event wartet.
      action.championId = target
      this.log.info(`${t.type === 'pick' ? 'Hover' : 'Ban-Hover'}: ${this.label(target)}.`)
      t.lastError = null
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (t.lastError !== msg) {
        this.log.warn(`Hover ${this.label(target)} fehlgeschlagen: ${msg}`)
        t.lastError = msg
      }
      return false
    }
  }

  // --- Pick -----------------------------------------------------------------

  private async evaluatePick(session: ChampSelectSession, list: number[]): Promise<void> {
    const t = this.pick
    const action = this.prepare(session, t, list)
    if (!action) return

    const pickable = await this.fetchIds(PICKABLE_PATH)
    if (!pickable) return // Verfuegbarkeit unklar -> im Zweifel nichts tun

    const unavailable = this.collectUnavailable(session)
    const claims = this.teammateClaims(session)
    let target: number | null = null
    for (const c of list) {
      if (unavailable.has(c)) continue
      // Wer zuerst hovert, behaelt ihn: einen Champ, den wir schon halten, nicht abgeben.
      if (claims.has(c) && action.championId !== c) {
        this.noteUnavailable(t, c, 'Teammate will ihn spielen')
        continue
      }
      if (!pickable.has(c)) {
        this.noteUnavailable(t, c, 'nicht pickbar - nicht im Besitz?')
        continue
      }
      target = c
      break
    }
    this.noteTarget(t, target)
    if (target === null) {
      t.setView('none', null)
      return
    }

    const isOurTurn = action.isInProgress
    const inPlanning = session.timer?.phase === PLANNING
    if (!isOurTurn && !inPlanning) {
      t.setView('waiting', target) // z. B. waehrend der Ban-Phase: nur vormerken
      return
    }

    if (!(await this.hover(t, action, target))) return

    if (!isOurTurn) {
      t.setView('waiting', target) // Pre-Hover in der Planning-Phase
      return
    }
    t.timeLeftMs = session.timer?.adjustedTimeLeftInPhase ?? 0
    t.timeLeftAt = Date.now()
    this.setActiveView(t, target)
    await this.maybeLock(t)
  }

  // --- Ban ------------------------------------------------------------------

  private async evaluateBan(session: ChampSelectSession, list: number[]): Promise<void> {
    const t = this.ban
    const action = this.prepare(session, t, list)
    if (!action) return

    const me = session.localPlayerCellId
    const allies = this.allyCells(session)

    // Nie bannen, was Teammates spielen wollen - und auch nicht unsere eigene Pick-Absicht.
    const unavailable = this.collectUnavailable(session)
    const wanted = this.teammateClaims(session)
    const self = session.myTeam?.find((p) => p.cellId === me)
    if (self && self.championPickIntent > 0) wanted.add(self.championPickIntent)
    const ownPick = this.findOwnAction(session, 'pick')
    if (ownPick && ownPick.championId > 0) wanted.add(ownPick.championId)
    if (this.pick.target !== null) wanted.add(this.pick.target)

    // Keine Doppel-Bans: was ein Teammate gerade zum Bannen hovert, ueberspringen.
    const allyBanHovers = new Set<number>()
    for (const group of session.actions) {
      for (const a of group) {
        if (a.type === 'ban' && a.actorCellId !== me && allies.has(a.actorCellId)) {
          if (a.championId > 0) allyBanHovers.add(a.championId)
        }
      }
    }

    const bannable = await this.fetchIds(BANNABLE_PATH)
    let target: number | null = null
    for (const c of list) {
      if (unavailable.has(c)) continue
      if (wanted.has(c)) {
        this.noteUnavailable(t, c, 'Teammate oder du willst ihn spielen')
        continue
      }
      if (allyBanHovers.has(c) && action.championId !== c) {
        this.noteUnavailable(t, c, 'Teammate bannt ihn bereits')
        continue
      }
      if (bannable && !bannable.has(c)) continue
      target = c
      break
    }
    this.noteTarget(t, target)
    if (target === null) {
      t.setView('none', null)
      return
    }

    // Hovern und Bannen nur in der echten Ban-Runde (nie in PLANNING).
    if (!action.isInProgress || session.timer?.phase !== BAN_PICK) {
      t.setView('waiting', target)
      return
    }

    if (!(await this.hover(t, action, target))) return
    t.timeLeftMs = session.timer?.adjustedTimeLeftInPhase ?? 0
    t.timeLeftAt = Date.now()
    this.setActiveView(t, target)
    await this.maybeLock(t)
  }

  // --- Lock (Pick + Ban) ----------------------------------------------------

  private setActiveView(t: Track, target: number): void {
    const { lockMode, lockThresholdMs } = this.store.toggles
    if (lockMode === 'hover-only') {
      t.setView('hover-only', target)
      return
    }
    t.setView('hovering', target)
    if (t.view) t.view.lockAt = t.timeLeftAt + t.timeLeftMs - lockThresholdMs
  }

  /** Lockt/bannt das Ziel, sobald die (fortlaufend berechnete) Restzeit < Schwelle ist. */
  private async maybeLock(t: Track): Promise<void> {
    if (!this.enabled(t.type) || t.manual || t.locked) return
    const { lockMode, lockThresholdMs } = this.store.toggles
    if (lockMode !== 'auto-lock') return
    const session = this.session
    const target = t.target
    if (!session || target === null || t.actionId === null) return
    if (t.type === 'ban' && session.timer?.phase !== BAN_PICK) return

    const remainingMs = t.timeLeftMs - (Date.now() - t.timeLeftAt)
    if (remainingMs > lockThresholdMs) return

    // Action muss noch unsere, aktiv und offen sein.
    const action = this.findOwnAction(session, t.type)
    if (!action || action.id !== t.actionId || action.completed || !action.isInProgress) return

    // Harte Sicherung: nur locken, was gerade wirklich als unser Ziel gehovert ist.
    if (action.championId !== target) {
      if (action.championId > 0 && !t.writes.has(action.championId)) {
        t.manual = true
        this.log.event(
          `Anderer Champion gewaehlt (${this.label(action.championId)}) - Auto-Lock pausiert.`
        )
        t.setView('manual', action.championId)
        this.publish()
      }
      return
    }

    t.locked = true // optimistisch gegen Doppel-Lock; bei Fehler zuruecksetzen
    try {
      await this.patchAction(action.id, { championId: target, completed: true })
      this.log.event(
        `${t.type === 'pick' ? 'LOCK' : 'BAN'}: ${this.label(target)} bei ~` +
          `${Math.max(0, Math.round(remainingMs))}ms Restzeit.`
      )
      t.setView('done', target)
      this.publish()
    } catch (err) {
      t.locked = false
      const msg = err instanceof Error ? err.message : String(err)
      if (t.lastError !== msg) {
        this.log.error(`${t.type === 'pick' ? 'Lock' : 'Ban'} fehlgeschlagen: ${msg}`)
        t.lastError = msg
      }
    }
  }

  private async patchAction(
    actionId: number,
    body: { championId: number; completed?: boolean }
  ): Promise<void> {
    const http = this.connector.client
    if (!http) throw new Error('kein LCU-Client')
    const { status } = await http.patch(`${ACTIONS_PATH}/${actionId}`, body)
    if (status >= 400) throw new Error(`HTTP ${status}`)
  }

  // --- GUI / Lebenszyklus ---------------------------------------------------

  /** Live-Stand in den Store spiegeln (nur bei Aenderung pushen). */
  private publish(): void {
    const next: LiveView | null =
      this.active && this.role ? { role: this.role, pick: this.pick.view, ban: this.ban.view } : null
    if (JSON.stringify(next) === JSON.stringify(this.store.live)) return
    this.store.live = next
    this.store.touch()
  }

  private startTicking(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => {
      this.enqueue(() => this.maybeLock(this.pick))
      this.enqueue(() => this.maybeLock(this.ban))
    }, TICK_MS)
  }

  private end(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.active) this.log.info('Champ Select beendet - Engine zurueckgesetzt.')
    this.active = false
    this.session = null
    this.role = null
    this.pick = new Track('pick')
    this.ban = new Track('ban')
    this.announcedPassive = false
    this.publish()
  }
}
