// `tauri build` with the updater signature. The private key deliberately lives outside the
// repo: default %USERPROFILE%\.tauri\draftpilot.key (no password), overridable via
// TAURI_SIGNING_PRIVATE_KEY (path or content) / TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
// Extra arguments go to `tauri build` (e.g. `npm run build -- --config ...`).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const env = { ...process.env }
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const key = join(homedir(), '.tauri', 'draftpilot.key')
  if (!existsSync(key)) {
    console.error(`Updater signing key missing: ${key} (see CLAUDE.md, section Updates).`)
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
