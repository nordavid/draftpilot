import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import type { Champion, ChampionCatalog, Language } from '@shared/index'
import type { Logger } from '../logger'
import type { LcuHttpClient } from '../lcu/httpClient'

// Champion-Katalog (ID, Name, Icon-Key) fuer die GUI-Auswahl und lesbare Logs.
// Quelle: Riots oeffentliches Data Dragon (funktioniert auch ohne laufenden Client).
// Bei jedem Start (und Sprachwechsel) wird gegen die aktuelle Patch-Version abgeglichen;
// neue Champions kommen so automatisch dazu. Gecacht je Sprache in
// userData/champions-<locale>.json. Ist Data Dragon nicht erreichbar und kein Cache
// vorhanden, dient die LCU (champion-summary) als Fallback - dann ohne Icons.

const DDRAGON = 'https://ddragon.leagueoflegends.com'
const FETCH_TIMEOUT_MS = 10000
const LOCALE: Record<Language, string> = { en: 'en_US', de: 'de_DE' }

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

interface CachedCatalog extends ChampionCatalog {
  locale?: string
}

export interface ChampionData {
  on(event: 'change', listener: (catalog: ChampionCatalog) => void): this
}

export class ChampionData extends EventEmitter {
  private catalog: ChampionCatalog = { version: null, champions: [] }
  private byId = new Map<number, Champion>()
  /** Data-Dragon-Locale des aktuellen Katalogs (null = aus der LCU). */
  private catalogLocale: string | null = null
  private language: Language = 'en'
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

  /** Cache der Sprache laden, dann im Hintergrund gegen Data Dragon abgleichen. */
  init(language: Language): void {
    this.language = language
    this.loadCache()
    this.ddragon = this.refreshFromDDragon()
  }

  /** Sprachwechsel: Namen in der neuen Sprache laden (Cache sofort, dann Abgleich). */
  setLanguage(language: Language): void {
    if (language === this.language) return
    this.language = language
    this.loadCache()
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
      this.set({ version: null, champions: this.sortByName(champions) }, null, false)
      this.log.info(`Champion list loaded from the League client (${champions.length}).`)
    } catch {
      // egal - GUI zeigt dann eben noch keine Auswahl
    }
  }

  private loadCache(): void {
    try {
      const cached = JSON.parse(readFileSync(this.cachePath(), 'utf8')) as CachedCatalog
      if (Array.isArray(cached.champions) && cached.champions.length > 0) {
        const locale = LOCALE[this.language]
        this.set({ version: cached.version, champions: cached.champions }, locale, false)
      }
    } catch {
      // Kein Cache fuer diese Sprache -> wird gleich geladen.
    }
  }

  private async refreshFromDDragon(): Promise<void> {
    const language = this.language
    const locale = LOCALE[language]
    try {
      const versions = await fetchJson<string[]>(`${DDRAGON}/api/versions.json`)
      const version = versions[0]
      if (!version) return
      const current = version === this.catalog.version && this.catalogLocale === locale
      if (current && this.catalog.champions.length > 0) return

      const json = await fetchJson<{ data: Record<string, DDragonChampion> }>(
        `${DDRAGON}/cdn/${version}/data/${locale}/champion.json`
      )
      if (language !== this.language) return // inzwischen umgestellt
      const champions = Object.values(json.data)
        .map((c) => ({ id: Number(c.key), alias: c.id, name: c.name }))
        .filter((c) => Number.isInteger(c.id) && c.id > 0)
      this.set({ version, champions: this.sortByName(champions) }, locale, true)
      this.log.info(`Champion list updated (patch ${version}, ${champions.length} champions).`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.warn(`Data Dragon unreachable (${msg}) - using cache or League client.`)
    }
  }

  /** Katalog setzen; mit `persist` zusaetzlich als Cache dieser Sprache speichern. */
  private set(catalog: ChampionCatalog, locale: string | null, persist: boolean): void {
    this.catalog = catalog
    this.catalogLocale = locale
    this.byId = new Map(catalog.champions.map((c) => [c.id, c]))
    this.emit('change', catalog)
    if (!persist || !locale) return
    try {
      const data: CachedCatalog = { ...catalog, locale }
      writeFileSync(this.cachePath(), JSON.stringify(data), 'utf8')
    } catch {
      // Cache ist optional.
    }
  }

  private cachePath(): string {
    return join(app.getPath('userData'), `champions-${LOCALE[this.language]}.json`)
  }

  private sortByName(list: Champion[]): Champion[] {
    return [...list].sort((a, b) => a.name.localeCompare(b.name, this.language))
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}
