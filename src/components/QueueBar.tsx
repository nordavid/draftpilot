import { useEffect, useRef, useState } from 'react'
import {
  QUEUE_IDLE_PHASES,
  type GameflowPhase,
  type Position,
  type QueueError,
  type QueueOutcome,
  type Role
} from '@shared/index'
import { useT } from '../i18n'
import { RoleIcon } from './RoleIcon'
import { Segmented } from './Controls'

// "Find match" (footer of the role card): Ranked Solo/Duo with the tab's role first and a
// second role picked per tab. A manual action -> it also works while Draftpilot is paused.

const POSITIONS: readonly Position[] = ['top', 'jungle', 'middle', 'bottom', 'utility', 'fill']
/** How long the button shows a result ("Roles set", an error) before it resets. */
const NOTICE_MS = 3000

type Notice = { tone: 'ok' | 'error'; text: string } | null

export function QueueBar(props: {
  role: Role
  second: Position
  phase: GameflowPhase | null
  connected: boolean
  onSecond: (p: Position) => void
  findMatch: (role: Role) => Promise<QueueOutcome>
  cancelSearch: () => Promise<void>
}): React.JSX.Element {
  const t = useT()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const searching = props.phase === 'Matchmaking'
  const idle = props.phase !== null && QUEUE_IDLE_PHASES.includes(props.phase)
  const disabled = !props.connected || pending || !(searching || idle)

  const show = (next: Notice): void => {
    window.clearTimeout(timer.current)
    setNotice(next)
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const run = async (): Promise<void> => {
    setPending(true)
    setNotice(null)
    try {
      if (searching) {
        await props.cancelSearch()
      } else if ((await props.findMatch(props.role)) === 'roles-set') {
        show({ tone: 'ok', text: t.queueRolesSet })
      }
    } catch (err) {
      const code = (typeof err === 'string' ? err : 'failed') as QueueError
      show({ tone: 'error', text: code === 'not-leader' ? t.queueLeaderOnly : t.queueFailed })
    } finally {
      setPending(false)
    }
  }

  const tone = notice ? `is-${notice.tone}` : searching ? 'is-cancel' : 'is-find'
  return (
    <div className="queue">
      <div className="queue-text">
        <span>{t.soloDuo}</span>
        <small>{t.secondRole}</small>
      </div>
      <Segmented
        label={t.secondRole}
        value={props.second}
        options={POSITIONS.filter((p) => p !== props.role).map((p) => ({
          value: p,
          label: t.position[p],
          icon: <RoleIcon role={p === 'fill' ? 'none' : p} size={16} />
        }))}
        onChange={props.onSecond}
      />
      <button type="button" className={`queue-btn ${tone}`} disabled={disabled} onClick={() => void run()}>
        {notice ? (
          notice.text
        ) : searching ? (
          t.cancelSearch
        ) : (
          <>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M2.5 1.6v6.8L8.4 5z" fill="currentColor" />
            </svg>
            {t.findMatch}
          </>
        )}
      </button>
    </div>
  )
}
