import type { Logger } from '../logger'
import type { LcuConnector } from '../lcu/connector'
import type { Store } from '../state/store'

// Ermittelt den im League-Client eingeloggten Summoner (nur zur Anzeige in der GUI).
// Direkt nach dem Connect antwortet current-summoner oft mit 404 ("noch nicht bereit"),
// daher mit Retry, bis es klappt.

const RETRY_DELAY_MS = 2000
const MAX_ATTEMPTS = 15

interface CurrentSummonerResponse {
  gameName?: string
  tagLine?: string
  displayName?: string
}

export class SummonerWatcher {
  private retryTimer: NodeJS.Timeout | null = null
  private attempts = 0

  constructor(
    private readonly connector: LcuConnector,
    private readonly store: Store,
    private readonly log: Logger
  ) {
    connector.on('connected', () => {
      this.cancelRetry()
      this.attempts = 0
      void this.tryFetch()
    })
    connector.on('disconnected', () => {
      this.cancelRetry()
      this.store.summonerRiotId = null
      this.store.touch()
    })
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private scheduleRetry(): void {
    if (this.attempts >= MAX_ATTEMPTS) return
    this.retryTimer = setTimeout(() => void this.tryFetch(), RETRY_DELAY_MS)
  }

  private async tryFetch(): Promise<void> {
    const http = this.connector.client
    if (!http) return
    this.attempts++

    try {
      const { status, data } = await http.get<CurrentSummonerResponse>(
        '/lol-summoner/v1/current-summoner'
      )
      const gameName = data?.gameName || data?.displayName || ''
      if (status !== 200 || !gameName) {
        this.scheduleRetry()
        return
      }
      const tagLine = data?.tagLine || ''
      this.store.summonerRiotId = tagLine ? `${gameName}#${tagLine}` : gameName
      this.store.touch()
      this.log.info(`Eingeloggt als ${this.store.summonerRiotId}.`)
    } catch {
      this.scheduleRetry()
    }
  }
}
