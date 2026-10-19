// Kopiert die Release-Artefakte nach dist/<version>/, damit eine dort gestartete App
// den naechsten Build nicht blockiert (target/release/draftpilot.exe waere sonst gesperrt).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const release = join('src-tauri', 'target', 'release')
const out = join('dist', version)

mkdirSync(out, { recursive: true })
copyFileSync(join(release, 'draftpilot.exe'), join(out, 'Draftpilot.exe'))
copyFileSync(
  join(release, 'bundle', 'nsis', `Draftpilot_${version}_x64-setup.exe`),
  join(out, `Draftpilot_${version}_x64-setup.exe`)
)
console.log(`Release ${version} -> ${out}`)
