# Draftpilot

A small autopilot for League of Legends champ select. It runs next to the League client and
talks to it through the local client API (LCU). The interface is in English, with German as
an optional language.

- **Find match:** one click on a role tab opens a Ranked Solo/Duo lobby with that role
  first (the second role is picked per tab) and starts the queue.
- **Accept matches:** accepts the ready check automatically.
- **Picks per role:** first choice + fallbacks for Top, Jungle, Mid, Bot and Support. If a
  champion is banned, already taken, not owned or wanted by a teammate, the next one steps
  in. "Random" rolls an owned champion that Riot recommends for the role. Without an
  assigned role (Arena, custom games) picks and bans stay manual.
- **Bans per role:** also with fallbacks. Draftpilot never bans what a teammate (or you)
  want to play, and skips what a teammate is already hovering to ban.
- **Your pick wins:** if you choose a different champion yourself, Draftpilot stays out of
  that pick for the rest of the champ select.
- Locks in shortly before the timer ends (configurable), so you can still change your
  mind. Alternatively "Hover only".
- A master switch in the top right pauses everything.

## Tech

[Tauri v2](https://tauri.app): Rust backend, React UI in Windows' WebView2. That keeps the
app at a few MB instead of ~100 MB with Electron.

## Development

Requirements: Node.js, Rust (rustup, MSVC toolchain), Visual Studio C++ Build Tools.

```bash
npm install
npm run dev
```

- `npm run build` — release EXE (`src-tauri/target/release/draftpilot.exe`, runs without
  installation) and installer (`src-tauri/target/release/bundle/nsis/`)
- `npm run typecheck` — check TypeScript
- `cargo test` (in `src-tauri/`) — engine tests with simulated champ selects
- `npm run vite:dev` — the UI alone in a browser, with sample data

## Updates

The installed app checks for a newer version on start (GitHub Releases) and then shows
"Update available – Install" at the top. One click downloads the update, verifies its
signature, installs it and restarts.

Publishing a release (locally, without GitHub Actions):

```bash
npm run release -- "Short note in English"
git push
npm run upload
```

`npm run release` needs the private signing key at `%USERPROFILE%\.tauri\draftpilot.key`
(not in the repo) and puts the installer, `.sig`, `latest.json` and the portable EXE into
`dist/<version>/`. `npm run upload` uploads them with `gh release create` (run
`gh auth login` once).

Settings and lists are stored in `%APPDATA%\Draftpilot\config.json`. The champion list comes
from Riot's Data Dragon, is synced with the current patch on every start and cached per
language next to it.
