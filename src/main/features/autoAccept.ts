import type { GameflowPhase } from '@shared/index'
import type { Logger } from '../logger'
import type { LcuConnector } from '../lcu/connector'
import type { GameflowWatcher } from './gameflowWatcher'
import type { Store } from '../state/store'

// Auto-Accept: bei Phasenwechsel zu ReadyCheck den Ready-Check annehmen,
// gated durch Master-Toggle UND Auto-Accept-Toggle.

const ACCEPT_PATH = '/lol-matchmaking/v1/ready-check/accept'

export class AutoAccept {
  constructor(
    private readonly connector: LcuConnector,
    watcher: GameflowWatcher,
    private readonly store: Store,
    private readonly log: Logger
  ) {
    watcher.on('phase', (phase) => void this.onPhase(phase))
  }

  private async onPhase(phase: GameflowPhase | null): Promise<void> {
    if (phase !== 'ReadyCheck') return

    if (!this.store.settings.masterEnabled) {
      this.log.info('Ready check - Draftpilot is paused, ignoring.')
      return
    }
    if (!this.store.settings.autoAccept) {
      this.log.info('Ready check - auto-accept is off, ignoring.')
      return
    }

    const http = this.connector.client
    if (!http) return

    try {
      const { status } = await http.post(ACCEPT_PATH)
      if (status >= 400) this.log.warn(`Accepting the ready check failed (HTTP ${status}).`)
      else this.log.event('Match accepted.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log.error(`Accept failed: ${msg}`)
    }
  }
}
