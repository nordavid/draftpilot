// `tauri build` mit Updater-Signatur. Der private Schluessel liegt bewusst ausserhalb des
// Repos: Standard %USERPROFILE%\.tauri\draftpilot.key (ohne Passwort), ueberschreibbar per
// TAURI_SIGNING_PRIVATE_KEY (Pfad oder Inhalt) / TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
// Weitere Argumente gehen an `tauri build` (z. B. `npm run build -- --config ...`).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const env = { ...process.env }
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const key = join(homedir(), '.tauri', 'draftpilot.key')
  if (!existsSync(key)) {
    console.error(`Updater-Schluessel fehlt: ${key} (siehe CLAUDE.md, Abschnitt Updates).`)
    process.exit(1)
  }
  env.TAURI_SIGNING_PRIVATE_KEY = key
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= ''
}

const { status } = spawnSync('npx', ['tauri', 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env
})
process.exit(status ?? 1)
