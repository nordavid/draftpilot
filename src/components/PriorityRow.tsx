import { useState } from 'react'
import { MAX_LIST } from '@shared/index'
import { Portrait, championName, useChampions } from '../champions'
import { useT } from '../i18n'

// Ordered champion list of a role: first choice large, fallbacks smaller, arrows show the
// fallback order. Drag a champion onto another to swap them, remove via x.

const FIRST = 64
const REST = 50

function swap(list: number[], a: number, b: number): number[] {
  const next = [...list]
  next[a] = list[b]
  next[b] = list[a]
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

  const remove = (i: number): void => onChange(ids.filter((_, j) => j !== i))
  const endDrag = (): void => {
    setDragFrom(null)
    setDragOver(null)
  }

  const noun = kind === 'pick' ? t.pick : t.ban
  const canAdd = ids.length < MAX_LIST

  return (
    <div className={`prio-row prio-${kind} ${dragFrom !== null ? 'is-sorting' : ''}`}>
      {ids.map((id, i) => {
        const name = championName(lookup, id, t.random)
        const size = i === 0 ? FIRST : REST
        return (
          <div className="prio-item" key={id}>
            {i > 0 && <Chevron />}
            <div
              className={`slot ${dragFrom !== null && dragOver === i && dragFrom !== i ? 'is-target' : ''}`}
              onDragOver={(e) => {
                if (dragFrom === null) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dragOver !== i) setDragOver(i)
              }}
              onDragLeave={(e) => {
                // Only when leaving the slot itself, not when moving between its children.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDragOver((o) => (o === i ? null : o))
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null && dragFrom !== i) onChange(swap(ids, dragFrom, i))
                endDrag()
              }}
            >
              <div className="slot-box">
                <div className="tile-wrap">
                  <button
                    type="button"
                    className={`tile ${dragFrom === i ? 'is-dragging' : ''}`}
                    style={{ width: size, height: size }}
                    draggable
                    aria-label={`${noun} ${i + 1}: ${name}`}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(id))
                      setDragFrom(i)
                    }}
                    onDragEnd={endDrag}
                  >
                    <Portrait id={id} size={size} />
                    <span className="rank">{i + 1}</span>
                  </button>
                  <button
                    type="button"
                    className="tile-remove"
                    aria-label={t.removeName(name)}
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
