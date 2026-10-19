import type { DraftpilotApi } from '@shared/index'

declare global {
  interface Window {
    api: DraftpilotApi
  }
}

export {}
