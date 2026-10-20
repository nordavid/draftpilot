// Kopiert die Release-Artefakte nach dist/<version>/, damit eine dort gestartete App
// den naechsten Build nicht blockiert (target/release/draftpilot.exe waere sonst gesperrt).
// Schreibt dazu latest.json fuer den Updater (zeigt auf das GitHub-Release v<version>).
// Optional: Release-Notizen als Argument, z. B. `npm run release -- "Neu: ..."`.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RELEASES = 'https://github.com/nordavid/draftpilot/releases'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const release = join('src-tauri', 'target', 'release')
const nsis = join(release, 'bundle', 'nsis')
const setup = `Draftpilot_${version}_x64-setup.exe`
const out = join('dist', version)

mkdirSync(out, { recursive: true })
copyFileSync(join(nsis, setup), join(out, setup))
copyFileSync(join(nsis, `${setup}.sig`), join(out, `${setup}.sig`))

const latest = {
  version,
  notes: process.argv.slice(2).join(' ') || `Draftpilot ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(nsis, `${setup}.sig`), 'utf8').trim(),
      url: `${RELEASES}/download/v${version}/${setup}`
    }
  }
}
writeFileSync(join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`)

copyFileSync(join(release, 'draftpilot.exe'), join(out, 'Draftpilot.exe'))
console.log(`Release ${version} -> ${out}`)
