import { useEffect, useState } from 'react'
import { ROLE_LABEL, type ActionView, type LiveView } from '@shared/index'
import { Portrait, championName, useChampions } from '../champions'
import { RoleIcon } from './RoleIcon'

// Live-Anzeige waehrend der Champ Select: Rolle, Pick- und Ban-Ziel mit Status/Countdown.

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [active])
  return now
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  })
}

function describe(kind: 'pick' | 'ban', v: ActionView, now: number): string {
  switch (v.status) {
    case 'waiting':
      return kind === 'pick' ? 'Vorgemerkt, wartet auf deinen Zug' : 'Vorgemerkt, wartet auf die Ban-Runde'
    case 'hovering':
      return v.lockAt !== null
        ? `${kind === 'pick' ? 'Lockt' : 'Bannt'} in ${seconds(v.lockAt - now)} s`
        : 'Gehovert'
    case 'hover-only':
      return 'Gehovert, du lockst selbst'
    case 'done':
      return kind === 'pick' ? 'Gelockt' : 'Gebannt'
    case 'manual':
      return 'Du hast übernommen, Automatik pausiert'
    case 'none':
      return 'Kein Champion deiner Liste verfügbar'
    case 'empty':
      return 'Liste für diese Rolle ist leer'
    case 'off':
      return kind === 'pick' ? 'Auto-Pick ist aus' : 'Auto-Ban ist aus'
  }
}

function Lane(props: { kind: 'pick' | 'ban'; view: ActionView | null; now: number }): React.JSX.Element {
  const lookup = useChampions()
  const { kind, view } = props
  const title = kind === 'pick' ? 'Pick' : 'Ban'
  if (!view) {
    return (
      <div className={`lane lane-${kind} is-idle`}>
        <div className="lane-portrait empty" />
        <div className="lane-text">
          <span className="lane-title">{title}</span>
          <span className="lane-status">{kind === 'ban' ? 'Keine Ban-Phase' : 'Kein Pick in diesem Modus'}</span>
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
        <span className="lane-status">{describe(kind, view, props.now)}</span>
      </div>
    </div>
  )
}

export function LivePanel(props: { live: LiveView }): React.JSX.Element {
  const { live } = props
  const counting = live.pick?.lockAt != null || live.ban?.lockAt != null
  const now = useNow(counting)
  return (
    <section className="live" aria-live="polite">
      <div className="live-head">
        <span className="live-pulse" aria-hidden />
        <span>Champ Select</span>
        <span className="live-role">
          <RoleIcon role={live.role} size={16} />
          {ROLE_LABEL[live.role]}
        </span>
      </div>
      <div className="live-lanes">
        <Lane kind="pick" view={live.pick} now={now} />
        <Lane kind="ban" view={live.ban} now={now} />
      </div>
    </section>
  )
}
