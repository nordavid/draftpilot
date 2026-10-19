import { EventEmitter } from 'node:events'
import type { Logger } from '../logger'
import { discoverCredentials, type LcuCredentials } from './credentials'
import { LcuHttpClient } from './httpClient'
import { LcuEventStream, type LcuEvent } from './eventStream'

export const GAMEFLOW_PHASE_URI = '/lol-gameflow/v1/gameflow-phase'
export const CHAMP_SELECT_SESSION_URI = '/lol-champ-select/v1/session'

const POLL_MS = 4000 // Suche nach offenem Client
const RECONNECT_MS = 2000 // nach Verbindungsabbruch

// Orchestriert die LCU-Anbindung: Credentials finden, HTTP-Client bauen, Event-Stream
// oeffnen, Events weiterreichen, bei Client-Neustart neu verbinden.
//
// Emittierte Events:
//   'connected'    (creds)        — Verbindung steht
//   'disconnected' ()             — Verbindung verloren
//   'event'        (LcuEvent)     — jedes LCU-Event (inkl. initialer Gameflow-Phase)

export interface LcuConnector {
  on(event: 'connected', listener: (creds: LcuCredentials) => void): this
  on(event: 'disconnected', listener: () => void): this
  on(event: 'event', listener: (e: LcuEvent) => void): this
}

export class LcuConnector extends EventEmitter {
  private http: LcuHttpClient | null = null
  private stream?: LcuEventStream
  private running = false
  private announcedSearching = false
  private timer?: NodeJS.Timeout

  constructor(private readonly log: Logger) {
    super()
  }

  /** HTTP-Client der aktiven Verbindung (null, solange kein Client verbunden ist). */
  get client(): LcuHttpClient | null {
    return this.http
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.log.info('LCU connector started - looking for the League client...')
    void this.loop()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.teardown()
  }

  private schedule(ms: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => void this.loop(), ms)
  }

  private async loop(): Promise<void> {
    if (!this.running) return

    const creds = await discoverCredentials()
    if (!creds) {
      if (!this.announcedSearching) {
        this.log.warn('No League client found - waiting (is it running?)...')
        this.announcedSearching = true
      }
      this.schedule(POLL_MS)
      return
    }

    // Credentials gefunden -> Verbindung verifizieren (gleichzeitig initiale Phase holen).
    this.http = new LcuHttpClient(creds)
    let phase: unknown
    try {
      const res = await this.http.get(GAMEFLOW_PHASE_URI)
      phase = res.data
    } catch {
      // Client startet evtl. gerade hoch -> kurz warten, erneut versuchen.
      this.teardown()
      this.schedule(POLL_MS)
      return
    }

    this.announcedSearching = false
    this.log.info(`LCU connected (port ${creds.port}, source: ${creds.source}).`)
    this.emit('connected', creds)
    // Initiale Phase als synthetisches Event, damit Watcher den Ist-Zustand kennen.
    this.emit('event', { uri: GAMEFLOW_PHASE_URI, eventType: 'Update', data: phase })

    const stream = new LcuEventStream(creds)
    this.stream = stream
    stream.on('open', () => this.log.info('Event stream subscribed (OnJsonApiEvent).'))
    stream.on('event', (e) => this.emit('event', e))
    stream.on('error', (err) => this.log.warn(`Event stream error: ${err.message}`))
    stream.on('close', () => this.handleDrop())
    stream.connect()
  }

  private handleDrop(): void {
    if (!this.running && !this.http) return
    this.log.warn('LCU connection lost - reconnecting...')
    this.teardown()
    this.emit('disconnected')
    this.schedule(RECONNECT_MS)
  }

  private teardown(): void {
    this.stream?.close()
    this.stream = undefined
    this.http?.destroy()
    this.http = null
  }
}
