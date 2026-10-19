import { EventEmitter } from 'node:events'
import type { GameflowPhase } from '@shared/index'
import type { Logger } from '../logger'
import { GAMEFLOW_PHASE_URI, type LcuConnector } from '../lcu/connector'

// Beobachtet die Gameflow-Phase und loggt jeden Wechsel.
// Emittiert 'phase' (neuePhase, vorherigePhase) fuer nachgelagerte Features (Auto-Accept ...).

export interface GameflowWatcher {
  on(
    event: 'phase',
    listener: (phase: GameflowPhase | null, previous: GameflowPhase | null) => void
  ): this
}

export class GameflowWatcher extends EventEmitter {
  private current: GameflowPhase | null = null

  constructor(connector: LcuConnector, private readonly log: Logger) {
    super()
    connector.on('event', (e) => {
      if (e.uri === GAMEFLOW_PHASE_URI) this.handle(e.data)
    })
    connector.on('disconnected', () => {
      const previous = this.current
      this.current = null
      if (previous !== null) this.emit('phase', null, previous)
    })
  }

  private handle(data: unknown): void {
    if (typeof data !== 'string') return
    const phase = data as GameflowPhase
    if (phase === this.current) return

    const previous = this.current
    this.current = phase
    this.log.event(`Gameflow phase: ${previous ?? '-'} -> ${phase}`)
    this.emit('phase', phase, previous)
  }
}
