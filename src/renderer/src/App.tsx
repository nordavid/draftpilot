import { useEffect, useMemo, useRef, useState } from 'react'
import {
  APP_NAME,
  LOCK_THRESHOLD_MAX_MS,
  LOCK_THRESHOLD_MIN_MS,
  MAX_LIST,
  ROLES,
  ROLE_LABEL,
  type GameflowPhase,
  type LogEntry,
  type Role,
  type RolePrefs,
  type Toggles,
  type UiState
} from '@shared/index'
import { ChampionsContext, buildLookup, type ChampionLookup } from './champions'
import { RoleIcon } from './components/RoleIcon'
import { PriorityRow } from './components/PriorityRow'
import { ChampionPicker } from './components/ChampionPicker'
import { LivePanel } from './components/LivePanel'
import { Segmented, Stepper, Switch } from './components/Controls'

const PHASE_LABEL: Record<GameflowPhase, string> = {
  None: 'Hauptmenü',
  Lobby: 'Lobby',
  Matchmaking: 'Suche Match',
  CheckedIntoTournament: 'Clash eingecheckt',
  ReadyCheck: 'Match gefunden',
  ChampSelect: 'Champ Select',
  GameStart: 'Spiel startet',
  FailedToLaunch: 'Start fehlgeschlagen',
  InProgress: 'Im Spiel',
  Reconnect: 'Reconnect',
  WaitingForStats: 'Warte auf Statistiken',
  PreEndOfGame: 'Spielende',
  EndOfGame: 'Spielende',
  TerminatedInError: 'Spiel abgebrochen'
}

const TAB_KEY = 'draftpilot.tab'

function loadTab(): Role {
  try {
    const v = localStorage.getItem(TAB_KEY) as Role | null
    if (v && ROLES.includes(v)) return v
  } catch {
    // Speicher nicht verfuegbar -> Standard
  }
  return 'middle'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

type PickerState = { role: Role; kind: 'pick' | 'ban' } | null

function App(): React.JSX.Element {
  const [ui, setUi] = useState<UiState | null>(null)
  const [champs, setChamps] = useState<ChampionLookup>(() =>
    buildLookup({ version: null, champions: [] })
  )
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [tab, setTab] = useState<Role>(loadTab)
  const [picker, setPicker] = useState<PickerState>(null)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)
  const liveRole = ui?.live?.role ?? null

  useEffect(() => {
    void window.api.getState().then(setUi)
    void window.api.getLogs().then(setLogs)
    void window.api.getChampions().then((c) => setChamps(buildLookup(c)))
    const offs = [
      window.api.onState(setUi),
      window.api.onLog((e) => setLogs((prev) => [...prev, e].slice(-300))),
      window.api.onChampions((c) => setChamps(buildLookup(c)))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Beim Betreten der Champ Select direkt die zugewiesene Rolle zeigen.
  useEffect(() => {
    if (liveRole) setTab(liveRole)
  }, [liveRole])

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      // egal
    }
  }, [tab])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, showLog])

  const blocked = useMemo(() => {
    const map = new Map<number, string>()
    if (!ui || !picker) return map
    const prefs = ui.roles[picker.role]
    for (const id of prefs.picks) map.set(id, 'Schon in deinen Picks')
    for (const id of prefs.bans) map.set(id, 'Schon in deinen Bans')
    return map
  }, [ui, picker])

  if (!ui) return <div className="boot">Draftpilot startet</div>

  const t = ui.toggles
  const paused = !t.masterEnabled
  const prefs = ui.roles[tab]

  const setToggles = (partial: Partial<Toggles>): void => {
    setUi({ ...ui, toggles: { ...t, ...partial } })
    void window.api.setToggles(partial).then(setUi)
  }
  const setRole = (role: Role, next: RolePrefs): void => {
    setUi({ ...ui, roles: { ...ui.roles, [role]: next } })
    void window.api.setRole(role, next).then(setUi)
  }
  const addChampion = (id: number): void => {
    if (!picker) return
    const cur = ui.roles[picker.role]
    const list = picker.kind === 'pick' ? cur.picks : cur.bans
    if (!list.includes(id) && list.length < MAX_LIST) {
      setRole(
        picker.role,
        picker.kind === 'pick' ? { ...cur, picks: [...list, id] } : { ...cur, bans: [...list, id] }
      )
    }
    setPicker(null)
  }

  const connected = ui.lcu === 'connected'

  return (
    <ChampionsContext.Provider value={champs}>
      <div className={`app ${paused ? 'is-paused' : ''}`}>
        <header className="titlebar">
          <div className="brand">
            <Logo />
            <span className="brand-name">{APP_NAME}</span>
            <span className="brand-version">{ui.version}</span>
          </div>
          <label className={`master ${t.masterEnabled ? 'is-on' : ''}`}>
            <span>{t.masterEnabled ? 'Aktiv' : 'Pausiert'}</span>
            <Switch
              checked={t.masterEnabled}
              onChange={(v) => setToggles({ masterEnabled: v })}
              label="Draftpilot aktiv"
            />
          </label>
        </header>

        <main className="content">
          <div className="status">
            <span className={`status-conn ${connected ? 'is-ok' : 'is-wait'}`}>
              <span className="dot" aria-hidden />
              {connected ? 'Mit League verbunden' : 'Warte auf League-Client'}
            </span>
            {connected && ui.phase && <span className="status-phase">{PHASE_LABEL[ui.phase]}</span>}
            {ui.summonerRiotId && <span className="status-summoner">{ui.summonerRiotId}</span>}
          </div>

          {paused && (
            <p className="paused-note">
              Pausiert. Draftpilot nimmt keine Matches an und pickt oder bannt nichts.
            </p>
          )}

          {ui.live && <LivePanel live={ui.live} />}

          <section className="roles" aria-label="Champions pro Rolle">
            <div className="role-tabs" role="tablist">
              {ROLES.map((r) => {
                const p = ui.roles[r]
                const configured = p.picks.length + p.bans.length > 0
                return (
                  <button
                    type="button"
                    role="tab"
                    key={r}
                    aria-selected={tab === r}
                    className={`role-tab ${tab === r ? 'is-active' : ''} ${liveRole === r ? 'is-live' : ''}`}
                    onClick={() => setTab(r)}
                    title={liveRole === r ? `${ROLE_LABEL[r]} (aktuelle Champ Select)` : ROLE_LABEL[r]}
                  >
                    <RoleIcon role={r} size={20} />
                    <span>{r === 'none' ? 'Ohne' : ROLE_LABEL[r]}</span>
                    {configured && <span className="role-mark" aria-hidden />}
                  </button>
                )
              })}
            </div>

            <div className="role-body" role="tabpanel">
              {tab === 'none' && (
                <p className="role-note">
                  Gilt, wenn der Client keine Rolle zuweist, z. B. im Blind Pick.
                </p>
              )}

              <div className="list-block">
                <div className="list-head">
                  <h2>Picks</h2>
                  <span className="list-help">
                    Ist deine Erstwahl gebannt, weg oder nicht im Besitz, kommt der nächste dran.
                  </span>
                </div>
                <PriorityRow
                  kind="pick"
                  ids={prefs.picks}
                  onChange={(picks) => setRole(tab, { ...prefs, picks })}
                  onAdd={() => setPicker({ role: tab, kind: 'pick' })}
                />
              </div>

              <div className="list-block">
                <div className="list-head">
                  <h2>Bans</h2>
                  <span className="list-help">
                    Champions, die ein Teammate spielen will, werden übersprungen.
                  </span>
                </div>
                <PriorityRow
                  kind="ban"
                  ids={prefs.bans}
                  onChange={(bans) => setRole(tab, { ...prefs, bans })}
                  onAdd={() => setPicker({ role: tab, kind: 'ban' })}
                />
              </div>
            </div>
          </section>

          <section className="settings" aria-label="Automatik">
            <div className="setting">
              <div className="setting-text">
                <span>Match automatisch annehmen</span>
              </div>
              <Switch
                checked={t.autoAccept}
                onChange={(v) => setToggles({ autoAccept: v })}
                label="Match automatisch annehmen"
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span>Champion automatisch picken</span>
                <small>Wählst du selbst einen Champion, hält sich Draftpilot raus.</small>
              </div>
              <Switch
                checked={t.autoPick}
                onChange={(v) => setToggles({ autoPick: v })}
                label="Champion automatisch picken"
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span>Champion automatisch bannen</span>
              </div>
              <Switch
                checked={t.autoBan}
                onChange={(v) => setToggles({ autoBan: v })}
                label="Champion automatisch bannen"
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span>Bestätigen</span>
                <small>
                  {t.lockMode === 'auto-lock'
                    ? 'Hovert sofort und lockt kurz vor Ablauf, damit du noch umentscheiden kannst.'
                    : 'Hovert nur, den Lock-In klickst du selbst.'}
                </small>
              </div>
              <Segmented
                label="Bestätigen"
                value={t.lockMode}
                options={[
                  { value: 'auto-lock', label: 'Automatisch' },
                  { value: 'hover-only', label: 'Nur hovern' }
                ]}
                onChange={(v) => setToggles({ lockMode: v })}
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span>Lock-Zeitpunkt</span>
                <small>Sekunden vor Ablauf des Timers</small>
              </div>
              <Stepper
                label="Lock-Zeitpunkt"
                value={t.lockThresholdMs}
                min={LOCK_THRESHOLD_MIN_MS}
                max={LOCK_THRESHOLD_MAX_MS}
                step={1000}
                format={(v) => `${Math.round(v / 1000)} s`}
                onChange={(v) => setToggles({ lockThresholdMs: v })}
                disabled={t.lockMode !== 'auto-lock'}
              />
            </div>
          </section>

          <section className="log">
            <button
              type="button"
              className="log-toggle"
              aria-expanded={showLog}
              onClick={() => setShowLog((v) => !v)}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Protokoll
            </button>
            {showLog && (
              <div className="log-list" ref={logRef}>
                {logs.length === 0 && <div className="log-line">Noch keine Einträge.</div>}
                {logs.map((l, i) => (
                  <div key={i} className={`log-line lv-${l.level}`}>
                    <time>{fmtTime(l.ts)}</time>
                    <span>{l.message}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>

        {picker && (
          <ChampionPicker
            kind={picker.kind}
            title={`${picker.kind === 'pick' ? 'Pick' : 'Ban'} für ${ROLE_LABEL[picker.role]} hinzufügen`}
            blocked={blocked}
            onSelect={addChampion}
            onClose={() => setPicker(null)}
          />
        )}
      </div>
    </ChampionsContext.Provider>
  )
}

/** Wortmarke: Pfeil-Chevron (Pilot) im Pick-Teal. */
function Logo(): React.JSX.Element {
  return (
    <svg className="logo" width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <rect x="1" y="1" width="20" height="20" rx="6" fill="currentColor" opacity="0.14" />
      <path
        d="M7 15.5 11 6.5l4 9-4-2.2z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default App
