import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import type { Champion, ChampionCatalog } from '@shared/index'
import type { Logger } from '../logger'
import type { LcuHttpClient } from '../lcu/httpClient'

// Champion-Katalog (ID, Name, Icon-Key) fuer die GUI-Auswahl und lesbare Logs.
// Quelle: Riots oeffentliches Data Dragon (funktioniert auch ohne laufenden Client),
// lokal in userData/champions.json gecacht. Ist Data Dragon nicht erreichbar und kein
// Cache vorhanden, dient die LCU (champion-summary) als Fallback - dann ohne Icons.

const DDRAGON = 'https://ddragon.leagueoflegends.com'
const LOCALE = 'de_DE'
const FETCH_TIMEOUT_MS = 10000

interface DDragonChampion {
  id: string
  key: string
  name: string
}

interface LcuChampionSummary {
  id: number
  name: string
  alias: string
}

export interface ChampionData {
  on(event: 'change', listener: (catalog: ChampionCatalog) => void): this
}

export class ChampionData extends EventEmitter {
  private catalog: ChampionCatalog = { version: null, champions: [] }
  private byId = new Map<number, Champion>()
  /** Laufender Data-Dragon-Abgleich; der LCU-Fallback wartet ihn ab. */
  private ddragon: Promise<void> = Promise.resolve()

  constructor(private readonly log: Logger) {
    super()
  }

  get(): ChampionCatalog {
    return this.catalog
  }

  name(id: number): string {
    return this.byId.get(id)?.name ?? `#${id}`
  }

  /** Cache laden, dann im Hintergrund gegen die aktuelle Data-Dragon-Version abgleichen. */
  init(): void {
    try {
      const cached = JSON.parse(readFileSync(this.cachePath(), 'utf8')) as ChampionCatalog
      if (Array.isArray(cached.champions) && cached.champions.length > 0) this.set(cached, false)
    } catch {
      // Kein Cache -> wird gleich geladen.
    }
    this.ddragon = this.refreshFromDDragon()
  }

  /** Fallback, falls Data Dragon nicht erreichbar war: Liste aus dem League-Client. */
  async fillFromLcu(http: LcuHttpClient): Promise<void> {
    await this.ddragon
    if (this.catalog.champions.length > 0) return
    try {
      const { status, data } = await http.get<LcuChampionSummary[]>(
        '/lol-game-data/assets/v1/champion-summary.json'
      )
      if (status !== 200 || !Array.isArray(data)) return
      // IDs ab 3000 sind Sondermodus-Varianten (z. B. Swarm), keine waehlbaren Champions.
      const champions = data
        .filter((c) => c.id > 0 && c.id < 3000)
        .map((c) => ({ id: c.id, alias: c.alias, name: c.name }))
      this.set({ version: null, champions: sortByName(champions) }, false)
      this.log.info(`Champion-Liste aus dem League-Client geladen (${champions.length}).`)
    } catch {
      // egal - GUI zeigt dann eben noch keine Auswahl
    }
  }

  private async refreshFromDDragon(): Promise<void> {
    try {
      const versions = await fetchJson<string[]>(`${DDRAGON}/api/versions.json`)
      const version = versions[0]
      if (!version) return
      if (version === this.catalog.version && this.catalog.champions.length > 0) return

      const json = await fetchJson<{ data: Record<string, DDragonChampion> }>(
        `${DDRAGON}/cdn/${version}/data/${LOCALE}/champion.json`
      )
      const champions = Object.values(json.data)
        .map((c) => ({ id: Number(c.key), alias: c.id, name: c.name }))
        .filter((c) => Number.isInteger(c.id) && c.id > 0)
      this.set({ version, champions: sortByName(champions) }, true)
      this.log.info(`Champion-Liste aktualisiert (Patch ${version}, ${champions.length} Champions).`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.warn(`Data Dragon nicht erreichbar (${msg}) - nutze Cache bzw. League-Client.`)
    }
  }

  private set(catalog: ChampionCatalog, persist: boolean): void {
    this.catalog = catalog
    this.byId = new Map(catalog.champions.map((c) => [c.id, c]))
    this.emit('change', catalog)
    if (!persist) return
    try {
      writeFileSync(this.cachePath(), JSON.stringify(catalog), 'utf8')
    } catch {
      // Cache ist optional.
    }
  }

  private cachePath(): string {
    return join(app.getPath('userData'), 'champions.json')
  }
}

function sortByName(list: Champion[]): Champion[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}
