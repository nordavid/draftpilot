import { useEffect, useRef, useState } from 'react'
import { MAX_LIST } from '@shared/index'
import { Portrait, championName, useChampions } from '../champions'
import { useT } from '../i18n'

// Geordnete Champion-Liste einer Rolle: Erstwahl gross, Fallbacks kleiner, Pfeile zeigen
// die Ausweich-Reihenfolge. Sortieren per Drag & Drop oder Pfeiltasten, Entfernen per x/Entf.

const FIRST = 64
const REST = 50

function move(list: number[], from: number, to: number): number[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function PriorityRow(props: {
  kind: 'pick' | 'ban'
  ids: number[]
  onChange: (ids: number[]) => void
  onAdd: () => void
}): React.JSX.Element {
  const { kind, ids, onChange } = props
  const lookup = useChampions()
  const t = useT()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [focusId, setFocusId] = useState<number | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // Fokus bleibt nach dem Verschieben per Tastatur auf dem verschobenen Champion.
  useEffect(() => {
    if (focusId === null) return
    rowRef.current?.querySelector<HTMLButtonElement>(`[data-id="${focusId}"]`)?.focus()
    setFocusId(null)
  }, [ids, focusId])

  const remove = (i: number): void => onChange(ids.filter((_, j) => j !== i))

  const onKey = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === 'ArrowLeft' && i > 0) {
      setFocusId(ids[i])
      onChange(move(ids, i, i - 1))
    } else if (e.key === 'ArrowRight' && i < ids.length - 1) {
      setFocusId(ids[i])
      onChange(move(ids, i, i + 1))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      remove(i)
    } else {
      return
    }
    e.preventDefault()
  }

  const noun = kind === 'pick' ? t.pick : t.ban
  const canAdd = ids.length < MAX_LIST

  return (
    <div className={`prio-row prio-${kind}`} ref={rowRef}>
      {ids.map((id, i) => {
        const name = championName(lookup, id)
        const size = i === 0 ? FIRST : REST
        return (
          <div className="prio-item" key={id}>
            {i > 0 && <Chevron />}
            <div className={`slot ${dragOver === i && dragFrom !== i ? 'is-over' : ''}`}>
              <div className="slot-box">
                <div className="tile-wrap">
                  <button
                    type="button"
                    data-id={id}
                    className={`tile ${dragFrom === i ? 'is-dragging' : ''}`}
                    style={{ width: size, height: size }}
                    draggable
                    title={`${name} (${i === 0 ? t.firstChoice : t.fallbackN(i)}) - ${t.reorderHint}`}
                    aria-label={`${noun} ${i + 1}: ${name}`}
                    onKeyDown={(e) => onKey(e, i)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setDragFrom(i)
                    }}
                    onDragOver={(e) => {
                      if (dragFrom === null) return
                      e.preventDefault()
                      setDragOver(i)
                    }}
                    onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragFrom !== null && dragFrom !== i) onChange(move(ids, dragFrom, i))
                      setDragFrom(null)
                      setDragOver(null)
                    }}
                    onDragEnd={() => {
                      setDragFrom(null)
                      setDragOver(null)
                    }}
                  >
                    <Portrait id={id} size={size} />
                    <span className="rank">{i + 1}</span>
                  </button>
                  <button
                    type="button"
                    className="tile-remove"
                    aria-label={t.removeName(name)}
                    title={t.remove}
                    onClick={() => remove(i)}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>
              <span className="slot-name">{name}</span>
            </div>
          </div>
        )
      })}

      {canAdd && (
        <div className="prio-item">
          {ids.length > 0 && <Chevron faint />}
          <div className="slot">
            <div className="slot-box">
              <button
                type="button"
                className="tile tile-add"
                style={{ width: ids.length === 0 ? FIRST : REST, height: ids.length === 0 ? FIRST : REST }}
                onClick={props.onAdd}
                aria-label={ids.length === 0 ? t.addFirst(noun) : t.addFallback(noun)}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                  <path d="M9 3v12M3 9h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <span className="slot-name muted">{ids.length === 0 ? t.firstChoice : t.fallback}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function Chevron(props: { faint?: boolean }): React.JSX.Element {
  return (
    <svg
      className={`prio-chevron ${props.faint ? 'is-faint' : ''}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden
    >
      <path
        d="M5 3l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
