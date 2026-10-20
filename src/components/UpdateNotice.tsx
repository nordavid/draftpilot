import { useState } from 'react'
import { useT } from '../i18n'

// Hinweis unter der Titelleiste, sobald der Updater eine neuere Version gefunden hat.
// Klick laedt + installiert; die App beendet sich dabei und startet neu.

export function UpdateNotice(props: { version: string; onInstall: () => Promise<void> }): React.JSX.Element {
  const t = useT()
  const [status, setStatus] = useState<'idle' | 'installing' | 'failed'>('idle')

  const install = (): void => {
    setStatus('installing')
    props.onInstall().catch(() => setStatus('failed'))
  }

  return (
    <div className={`update ${status === 'failed' ? 'is-failed' : ''}`}>
      <span className="update-text">{status === 'failed' ? t.updateFailed : t.updateAvailable}</span>
      <span className="update-version">{props.version}</span>
      <button type="button" onClick={install} disabled={status === 'installing'}>
        {status === 'installing' ? t.updateInstalling : t.updateInstall}
      </button>
    </div>
  )
}
