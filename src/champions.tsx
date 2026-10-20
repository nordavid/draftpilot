import { createContext, useContext, useState } from 'react'
import { RANDOM_PICK, type Champion, type ChampionCatalog } from '@shared/index'

// Champion-Katalog fuer die ganze GUI (Namen + Portrait-URLs von Data Dragon).

export interface ChampionLookup {
  catalog: ChampionCatalog
  byId: Map<number, Champion>
}

export function buildLookup(catalog: ChampionCatalog): ChampionLookup {
  const champions = [...catalog.champions].sort((a, b) => a.name.localeCompare(b.name))
  return {
    catalog: { ...catalog, champions },
    byId: new Map(champions.map((c) => [c.id, c]))
  }
}

export const ChampionsContext = createContext<ChampionLookup>(
  buildLookup({ version: null, champions: [] })
)

export function useChampions(): ChampionLookup {
  return useContext(ChampionsContext)
}

/** Anzeigename; `randomLabel` fuer den Zufalls-Platzhalter in Pick-Listen. */
export function championName(lookup: ChampionLookup, id: number | null, randomLabel = ''): string {
  if (id === null) return ''
  if (id === RANDOM_PICK) return randomLabel
  return lookup.byId.get(id)?.name ?? `#${id}`
}

/** Quadratisches Champion-Portrait; Zufall = Wuerfel; ohne Data-Dragon-Icon die Initialen. */
export function Portrait(props: {
  id: number | null
  size: number
  className?: string
}): React.JSX.Element {
  const { catalog, byId } = useChampions()
  const [failed, setFailed] = useState<string | null>(null)
  const style = { width: props.size, height: props.size }
  const cls = `portrait ${props.className ?? ''}`

  if (props.id === RANDOM_PICK) {
    return (
      <span className={`${cls} portrait-random`} style={style} aria-hidden>
        <Dice size={Math.round(props.size * 0.74)} />
      </span>
    )
  }

  const champ = props.id !== null ? byId.get(props.id) : undefined
  const src =
    champ && catalog.version
      ? `https://ddragon.leagueoflegends.com/cdn/${catalog.version}/img/champion/${champ.alias}.png`
      : null
  if (src && failed !== src) {
    return (
      <img
        className={cls}
        style={style}
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed(src)}
      />
    )
  }
  return (
    <span className={`${cls} portrait-fallback`} style={style} aria-hidden>
      {champ ? champ.name.slice(0, 2) : '?'}
    </span>
  )
}

function Dice(props: { size: number }): React.JSX.Element {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {[
        [7.5, 7.5],
        [16.5, 7.5],
        [12, 12],
        [7.5, 16.5],
        [16.5, 16.5]
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.9" fill="currentColor" />
      ))}
    </svg>
  )
}
