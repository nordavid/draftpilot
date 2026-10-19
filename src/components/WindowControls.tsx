import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '../api'

// Fenster-Buttons der eigenen Titelleiste (Fenster ist ohne native Dekoration).

export function WindowControls(props: { minimizeLabel: string; closeLabel: string }): React.JSX.Element | null {
  if (!isTauri) return null
  const win = getCurrentWindow()
  return (
    <div className="window-controls">
      <button type="button" aria-label={props.minimizeLabel} title={props.minimizeLabel} onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        type="button"
        className="is-close"
        aria-label={props.closeLabel}
        title={props.closeLabel}
        onClick={() => void win.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  )
}
