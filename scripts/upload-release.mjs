// Uploads dist/<version>/ as GitHub release v<version> (gh CLI, `gh auth login` first).
// Installed older versions then offer the update (latest.json in the newest release).
// No GitHub Actions: builds are made locally with `npm run release`.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const dir = join('dist', version)
const files = [`Draftpilot_${version}_x64-setup.exe`, 'latest.json', 'Draftpilot.exe'].map((f) => join(dir, f))
const missing = files.filter((f) => !existsSync(f))
if (missing.length > 0) {
  console.error(`Missing (run \`npm run release\` first): ${missing.join(', ')}`)
  process.exit(1)
}
const { notes } = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))

const { status } = spawnSync(
  'gh',
  ['release', 'create', `v${version}`, ...files, '--title', `Draftpilot ${version}`, '--notes', notes],
  { stdio: 'inherit' }
)
process.exit(status ?? 1)
