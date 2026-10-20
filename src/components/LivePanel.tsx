import { useEffect, useState } from 'react'
import type { ActionView, LiveView } from '@shared/index'
import { Portrait, championName, useChampions } from '../champions'
import { useT, type Dict } from '../i18n'
import { RoleIcon } from './RoleIcon'

// Live-Anzeige waehrend der Champ Select: Rolle, Pick- und Ban-Ziel mit Status/Countdown.

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function describe(t: Dict, kind: 'pick' | 'ban', v: ActionView, now: number): string {
  switch (v.status) {
    case 'waiting':
      return t.queued
    case 'hovering': {
      if (v.lockAt === null) return t.hovered
      const s = (Math.max(0, v.lockAt - now) / 1000).toLocaleString(t.locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      })
      return kind === 'pick' ? t.locksIn(s) : t.bansIn(s)
    }
    case 'hover-only':
      return t.hovered
    case 'done':
      return kind === 'pick' ? t.locked : t.banned
    case 'manual':
      return t.manual
    case 'none':
      return t.noneAvailable
    case 'empty':
      return t.emptyList
    case 'off':
      return kind === 'pick' ? t.pickOff : t.banOff
  }
}

function Lane(props: { kind: 'pick' | 'ban'; view: ActionView | null; now: number }): React.JSX.Element {
  const lookup = useChampions()
  const t = useT()
  const { kind, view } = props
  const title = kind === 'pick' ? t.pick : t.ban
  if (!view) {
    return (
      <div className={`lane lane-${kind} is-idle`}>
        <div className="lane-portrait empty" />
        <div className="lane-text">
          <span className="lane-title">{title}</span>
          <span className="lane-status">{kind === 'ban' ? t.noBanPhase : t.noPickMode}</span>
        </div>
      </div>
    )
  }
  return (
    <div className={`lane lane-${kind} status-${view.status}`}>
      <div className="lane-portrait">
        {view.championId !== null ? <Portrait id={view.championId} size={52} /> : <div className="lane-blank" />}
      </div>
      <div className="lane-text">
        <span className="lane-title">
          {title}
          {view.championId !== null && <strong>{championName(lookup, view.championId)}</strong>}
        </span>
        <span className="lane-status">{describe(t, kind, view, props.now)}</span>
      </div>
    </div>
  )
}

export function LivePanel(props: { live: LiveView }): React.JSX.Element {
  const t = useT()
  const { live } = props
  const counting = live.pick?.lockAt != null || live.ban?.lockAt != null
  const now = useNow(counting)
  return (
    <section className="live" aria-live="polite">
      <div className="live-head">
        <span className="live-pulse" aria-hidden />
        <span>{t.champSelect}</span>
        <span className="live-role">
          <RoleIcon role={live.role} size={16} />
          {t.role[live.role]}
        </span>
      </div>
      {live.role === 'none' ? (
        <p className="live-note">{t.noRole}</p>
      ) : (
        <div className="live-lanes">
          <Lane kind="pick" view={live.pick} now={now} />
          <Lane kind="ban" view={live.ban} now={now} />
        </div>
      )}
    </section>
  )
}
