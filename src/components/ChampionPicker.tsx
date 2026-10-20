import { useEffect, useMemo, useRef, useState } from 'react'
import { RANDOM_PICK } from '@shared/index'
import { Portrait, useChampions } from '../champions'
import { useT } from '../i18n'

// Auswahl-Sheet: Suche + Portrait-Raster. Enter nimmt den ersten Treffer, Esc schliesst.
// Bei Picks steht "Zufall" als eigene Option ueber dem Raster.

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
  /** Champions, die schon in einer Liste dieser Rolle stehen. */
  blocked: Set<number>
  onSelect: (id: number) => void
  onClose: () => void
}): React.JSX.Element {
  const { catalog } = useChampions()
  const t = useT()
  const [query, setQuery] = useState('')
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
    <div className="sheet-backdrop" onMouseDown={props.onClose}>
      <div
        className={`sheet sheet-${props.kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label={t.close}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2 2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <input
          ref={inputRef}
          className="search"
          placeholder={t.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) props.onSelect(first.id)
          }}
        />
        {showRandom && (
          <button type="button" className="random-option" onClick={() => props.onSelect(RANDOM_PICK)}>
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
                onClick={() => props.onSelect(c.id)}
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
