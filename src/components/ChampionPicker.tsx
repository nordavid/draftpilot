import { useEffect, useMemo, useRef, useState } from 'react'
import { RANDOM_PICK } from '@shared/index'
import { Portrait, useChampions } from '../champions'
import { useT } from '../i18n'

// Picker sheet: search + portrait grid. Enter takes the first match, Esc closes.
// For picks, "Random" is a separate option above the grid. Pointer actions close with a
// short exit animation; keyboard actions (Enter/Esc) close instantly.

const EXIT_MS = 160

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

export function ChampionPicker(props: {
  title: string
  kind: 'pick' | 'ban'
  /** Champions already in one of this role's lists. */
  blocked: Set<number>
  onSelect: (id: number) => void
  onClose: () => void
}): React.JSX.Element {
  const { catalog } = useChampions()
  const t = useT()
  const [query, setQuery] = useState('')
  const [closing, setClosing] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const closeAnimated = (): void => {
    if (closing) return
    setClosing(true)
    setTimeout(() => closeRef.current(), EXIT_MS)
  }
  const pick = (id: number): void => {
    if (closing) return
    props.onSelect(id)
    closeAnimated()
  }

  const results = useMemo(() => {
    const q = normalize(query)
    if (!q) return catalog.champions
    const starts = catalog.champions.filter((c) => normalize(c.name).startsWith(q))
    const contains = catalog.champions.filter(
      (c) => !normalize(c.name).startsWith(q) && normalize(c.name).includes(q)
    )
    return [...starts, ...contains]
  }, [catalog, query])

  const first = results.find((c) => !props.blocked.has(c.id))
  const showRandom = props.kind === 'pick' && !query && !props.blocked.has(RANDOM_PICK)

  return (
    <div className={`sheet-backdrop ${closing ? 'is-closing' : ''}`} onMouseDown={closeAnimated}>
      <div
        className={`sheet sheet-${props.kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" onClick={closeAnimated} aria-label={t.close}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2 2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="search-wrap">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M9.5 9.5 12.6 12.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="search"
            placeholder={t.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && first) {
                props.onSelect(first.id)
                props.onClose()
              }
            }}
          />
        </div>
        {showRandom && (
          <button type="button" className="random-option" onClick={() => pick(RANDOM_PICK)}>
            <Portrait id={RANDOM_PICK} size={40} />
            <span className="random-text">
              <span>{t.random}</span>
              <small>{t.randomHint}</small>
            </span>
          </button>
        )}
        {catalog.champions.length === 0 ? (
          <p className="sheet-empty">{t.catalogLoading}</p>
        ) : results.length === 0 ? (
          <p className="sheet-empty">{t.noMatch(query)}</p>
        ) : (
          <div className="champ-grid">
            {results.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`champ ${c.id === first?.id && query ? 'is-first' : ''}`}
                disabled={props.blocked.has(c.id)}
                onClick={() => pick(c.id)}
              >
                <Portrait id={c.id} size={48} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
