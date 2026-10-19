import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { LcuCredentials } from './credentials'

// LCU-Event-Stream: WAMP über WebSocket.
// Nach Connect: Subscribe `[5, "OnJsonApiEvent"]`.
// Events kommen als `[8, "OnJsonApiEvent", { uri, eventType, data }]`.

export interface LcuEvent {
  uri: string
  eventType: string
  data: unknown
}

export interface LcuEventStream {
  on(event: 'open', listener: () => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'event', listener: (e: LcuEvent) => void): this
}

export class LcuEventStream extends EventEmitter {
  private ws?: WebSocket

  constructor(private readonly creds: LcuCredentials) {
    super()
  }

  connect(): void {
    const ws = new WebSocket(this.creds.wsUrl, {
      rejectUnauthorized: false,
      headers: { Authorization: this.creds.authHeader }
    })
    this.ws = ws

    ws.on('open', () => {
      ws.send(JSON.stringify([5, 'OnJsonApiEvent']))
      this.emit('open')
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: unknown
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      // Nur Event-Frames: [8, "OnJsonApiEvent", payload]
      if (Array.isArray(msg) && msg[0] === 8 && msg[2]) {
        const p = msg[2] as { uri?: string; eventType?: string; data?: unknown }
        if (p.uri) {
          this.emit('event', {
            uri: p.uri,
            eventType: p.eventType ?? '',
            data: p.data
          })
        }
      }
    })

    ws.on('close', () => this.emit('close'))
    ws.on('error', (err) => this.emit('error', err))
  }

  close(): void {
    if (!this.ws) return
    try {
      this.ws.removeAllListeners()
      this.ws.terminate()
    } catch {
      // egal — wir verwerfen die Instanz ohnehin
    }
    this.ws = undefined
  }
}
