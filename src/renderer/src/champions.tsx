import { createContext, useContext, useState } from 'react'
import type { Champion, ChampionCatalog } from '@shared/index'

// Champion-Katalog fuer die ganze GUI (Namen + Portrait-URLs von Data Dragon).

export interface ChampionLookup {
  catalog: ChampionCatalog
  byId: Map<number, Champion>
}

export function buildLookup(catalog: ChampionCatalog): ChampionLookup {
  return { catalog, byId: new Map(catalog.champions.map((c) => [c.id, c])) }
}

export const ChampionsContext = createContext<ChampionLookup>(
  buildLookup({ version: null, champions: [] })
)

export function useChampions(): ChampionLookup {
  return useContext(ChampionsContext)
}

export function championName(lookup: ChampionLookup, id: number | null): string {
  if (id === null) return ''
  return lookup.byId.get(id)?.name ?? `#${id}`
}

/** Quadratisches Champion-Portrait; ohne Data-Dragon-Icon die Initialen. */
export function Portrait(props: {
  id: number | null
  size: number
  className?: string
}): React.JSX.Element {
  const { catalog, byId } = useChampions()
  const [failed, setFailed] = useState<string | null>(null)
  const champ = props.id !== null ? byId.get(props.id) : undefined
  const src =
    champ && catalog.version
      ? `https://ddragon.leagueoflegends.com/cdn/${catalog.version}/img/champion/${champ.alias}.png`
      : null

  const style = { width: props.size, height: props.size }
  const cls = `portrait ${props.className ?? ''}`
  if (src && failed !== src) {
    return (
      <img
        className={cls}
        style={style}
        src={src}
        alt={champ?.name ?? ''}
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
