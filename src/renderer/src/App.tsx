import { useEffect, useMemo, useRef, useState } from 'react'
import {
  APP_NAME,
  LANGUAGES,
  LOCK_THRESHOLD_MAX_MS,
  LOCK_THRESHOLD_MIN_MS,
  MAX_LIST,
  ROLES,
  type LogEntry,
  type Role,
  type RolePrefs,
  type Settings,
  type UiState
} from '@shared/index'
import { ChampionsContext, buildLookup, type ChampionLookup } from './champions'
import { DICTS, I18nContext, LANGUAGE_NAME } from './i18n'
import { RoleIcon } from './components/RoleIcon'
import { PriorityRow } from './components/PriorityRow'
import { ChampionPicker } from './components/ChampionPicker'
import { LivePanel } from './components/LivePanel'
import { Segmented, Stepper, Switch } from './components/Controls'

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
  const t = DICTS[ui?.settings.language ?? 'en']

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
    document.documentElement.lang = t.locale.slice(0, 2)
  }, [t])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, showLog])

  const blocked = useMemo(() => {
    const map = new Map<number, string>()
    if (!ui || !picker) return map
    const prefs = ui.roles[picker.role]
    for (const id of prefs.picks) map.set(id, t.inPicks)
    for (const id of prefs.bans) map.set(id, t.inBans)
    return map
  }, [ui, picker, t])

  if (!ui) return <div className="boot">{t.boot}</div>

  const s = ui.settings
  const paused = !s.masterEnabled
  const prefs = ui.roles[tab]

  const setSettings = (partial: Partial<Settings>): void => {
    setUi({ ...ui, settings: { ...s, ...partial } })
    void window.api.setSettings(partial).then(setUi)
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
    <I18nContext.Provider value={t}>
      <ChampionsContext.Provider value={champs}>
        <div className={`app ${paused ? 'is-paused' : ''}`}>
          <header className="titlebar">
            <div className="brand">
              <Logo />
              <span className="brand-name">{APP_NAME}</span>
              <span className="brand-version">{ui.version}</span>
            </div>
            <label className={`master ${s.masterEnabled ? 'is-on' : ''}`}>
              <span>{s.masterEnabled ? t.active : t.paused}</span>
              <Switch
                checked={s.masterEnabled}
                onChange={(v) => setSettings({ masterEnabled: v })}
                label={t.masterLabel}
              />
            </label>
          </header>

          <main className="content">
            <div className="status">
              <span className={`status-conn ${connected ? 'is-ok' : 'is-wait'}`}>
                <span className="dot" aria-hidden />
                {connected ? t.connected : t.waiting}
              </span>
              {connected && ui.phase && <span className="status-phase">{t.phase[ui.phase]}</span>}
              {ui.summonerRiotId && <span className="status-summoner">{ui.summonerRiotId}</span>}
            </div>

            {paused && <p className="paused-note">{t.pausedNote}</p>}

            {ui.live && <LivePanel live={ui.live} />}

            <section className="roles" aria-label={t.rolesLabel}>
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
                      title={liveRole === r ? `${t.role[r]} ${t.liveRoleSuffix}` : t.role[r]}
                    >
                      <RoleIcon role={r} size={22} />
                      <span>{t.role[r]}</span>
                      {configured && <span className="role-mark" aria-hidden />}
                    </button>
                  )
                })}
              </div>

              <div className="role-body" role="tabpanel">
                {tab === 'none' && <p className="role-note">{t.noneNote}</p>}

                <div className="list-block">
                  <div className="list-head">
                    <h2>{t.picks}</h2>
                    <span className="list-help">{t.picksHelp}</span>
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
                    <h2>{t.bans}</h2>
                    <span className="list-help">{t.bansHelp}</span>
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

            <section className="settings">
              <div className="setting">
                <div className="setting-text">
                  <span>{t.autoAccept}</span>
                </div>
                <Switch
                  checked={s.autoAccept}
                  onChange={(v) => setSettings({ autoAccept: v })}
                  label={t.autoAccept}
                />
              </div>
              <div className="setting">
                <div className="setting-text">
                  <span>{t.autoPick}</span>
                  <small>{t.autoPickHint}</small>
                </div>
                <Switch
                  checked={s.autoPick}
                  onChange={(v) => setSettings({ autoPick: v })}
                  label={t.autoPick}
                />
              </div>
              <div className="setting">
                <div className="setting-text">
                  <span>{t.autoBan}</span>
                </div>
                <Switch
                  checked={s.autoBan}
                  onChange={(v) => setSettings({ autoBan: v })}
                  label={t.autoBan}
                />
              </div>
              <div className="setting">
                <div className="setting-text">
                  <span>{t.confirm}</span>
                  <small>{s.lockMode === 'auto-lock' ? t.confirmAuto : t.confirmHover}</small>
                </div>
                <Segmented
                  label={t.confirm}
                  value={s.lockMode}
                  options={[
                    { value: 'auto-lock', label: t.confirmAutoOption },
                    { value: 'hover-only', label: t.confirmHoverOption }
                  ]}
                  onChange={(v) => setSettings({ lockMode: v })}
                />
              </div>
              <div className="setting">
                <div className="setting-text">
                  <span>{t.lockTime}</span>
                  <small>{t.lockTimeHint}</small>
                </div>
                <Stepper
                  label={t.lockTime}
                  lessLabel={t.less}
                  moreLabel={t.more}
                  value={s.lockThresholdMs}
                  min={LOCK_THRESHOLD_MIN_MS}
                  max={LOCK_THRESHOLD_MAX_MS}
                  step={1000}
                  format={(v) => `${Math.round(v / 1000)} s`}
                  onChange={(v) => setSettings({ lockThresholdMs: v })}
                  disabled={s.lockMode !== 'auto-lock'}
                />
              </div>
              <div className="setting">
                <div className="setting-text">
                  <span>{t.language}</span>
                </div>
                <Segmented
                  label={t.language}
                  value={s.language}
                  options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAME[l] }))}
                  onChange={(v) => setSettings({ language: v })}
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
                {t.log}
              </button>
              {showLog && (
                <div className="log-list" ref={logRef}>
                  {logs.length === 0 && <div className="log-line">{t.logEmpty}</div>}
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
              title={t.addTitle(picker.kind === 'pick' ? t.pick : t.ban, t.role[picker.role])}
              blocked={blocked}
              onSelect={addChampion}
              onClose={() => setPicker(null)}
            />
          )}
        </div>
      </ChampionsContext.Provider>
    </I18nContext.Provider>
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
