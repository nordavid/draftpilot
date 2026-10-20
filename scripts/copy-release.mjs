// Copies the release artifacts to dist/<version>/ so an app started from there doesn't
// block the next build (target/release/draftpilot.exe would be locked otherwise).
// Also writes latest.json for the updater (points to the GitHub release v<version>).
// Optional: release notes as argument (English), e.g. `npm run release -- "New: ..."`.
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
