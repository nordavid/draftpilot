# Draftpilot — CLAUDE.md

## Overview

Standalone desktop tool for League of Legends: ordered pick and ban lists per role (first
choice + fallbacks), auto-accept, hover + auto-lock shortly before the timer ends. A
**master switch** overrides everything. UI language: **English (default) or German**,
switchable in the settings; texts live in `src/i18n.ts`. Logs are always English.

Since v2.0.0 **Tauri instead of Electron** (a few MB instead of ~100 MB). The LCU logic
originally comes from the A2Z Companion (`../a2z-companion`, TypeScript) and was **ported**
to Rust — keep LCU fixes in sync both ways (another copy lives in league-control).

## Language (binding)

**English is the primary language for everything:** code, identifiers, comments, logs, UI
default, README/CLAUDE.md, commit messages, release notes (`npm run release -- "..."`,
GitHub release text, `latest.json`). Other languages are optional add-ons — currently only
the German UI translation in `src/i18n.ts`. Chat with the user may be German.

## Tech stack

- **Tauri v2**: Rust backend (`src-tauri/`), UI in **WebView2** (preinstalled on Win10/11).
- **Frontend:** Vite + React 19 + TypeScript (`src/`). Talks to the backend only through
  `src/api.ts` (Tauri commands `get_state`, `get_logs`, `get_champions`, `set_settings`,
  `set_role`, `install_update` + events `state`, `log`, `champions`). In a plain browser
  (`npm run vite:dev`) the UI runs against sample data (`src/mockApi.ts`, URL parameters
  `?live=0&lang=de&paused=1&update=2.3.0`).
- **LCU in Rust without a wrapper crate:** `reqwest` (native-tls, certificate checks off
  for 127.0.0.1 only) for REST, `tokio-tungstenite` for the WAMP event stream, `sysinfo`
  for the process arguments of `LeagueClientUx.exe`.
- Champion data: Riot **Data Dragon** (en_US/de_DE per UI language), synced with the
  current patch on every start, cached per language; offline fallback: LCU
  `champion-summary.json` (no icons).
- Role icons: original paths from `rcp-fe-lol-static-assets` (CommunityDragon) inlined in
  `src/components/RoleIcon.tsx` (five lanes only; the old "Blind" tab is gone since 2.3.0).
- **Never add GitHub Actions** (they burn the user's Claude quota).

## Look & feel

Modern and minimal in the spirit of the current **Riot Client** (v2.4.0 overhaul): neutral
near-black (`#0e0f11`), soft rounded cards (`.card`, radius 16, hairline borders),
Segoe UI Variable (Display for headings, Text for body), no serif/caps fonts. Gold
`#d9b56f` = selection / primary (logo, switches, first choice, tab underline), green
`#3fcf7c` = connected / locked in, red `#ff5d64` = ban. Role tabs are a pill bar with a
sliding active pill (`.tab-indicator`) whose gold underline sits **below** the pill, outside
the highlight, near the bar's bottom edge (as in the Riot Client); segmented controls slide
too (`.seg-indicator`). Champion images are cropped with `object-view-box: inset(7%)`:
Data Dragon squares have a dark vignette baked into their edge. Custom title bar (`decorations: false`, `data-tauri-drag-region`,
`WindowControls.tsx`). Keep texts short, no tooltips. During champ select the live panel
replaces the status line. Paused (master off): no extra text, live panel, roles and
automation settings just fade (layout never shifts). Drag & drop in a priority row
**swaps** the two champions; the tile under the cursor glows gold. All UI texts live in
`src/i18n.ts` (`en` + `de`).

**Motion follows Emil Kowalski's rules** (github.com/emilkowalski/skills): strong custom
easings (`--ease-out`, `--ease-in-out`, `--ease-drawer`), UI animations < 300 ms, only
`transform`/`opacity`, `scale(0.97)` press feedback, entries via `@starting-style` from
`scale(0.96)`/`translateY` (never `scale(0)`), exit faster than enter (picker sheet 280 ms
in, 160 ms out), keyboard actions (Enter/Esc) close instantly, hover styles only inside
`@media (hover: hover) and (pointer: fine)`, reduced motion keeps fades only.

The window starts `visible: false` + `backgroundColor` (no white flash). Its height
**always follows the content** (`.content-inner` + ResizeObserver -> `fitWindow` in
`api.ts`): fit, center and show on start; afterwards it grows/shrinks with the live panel
and the log, capped by `screen.availHeight`, and moves up instead of leaving the screen. No
reserved space (the user doesn't want empty space). Rust shows the window after 3 s as a
safety net. `dragDropEnabled: false` is required, otherwise Tauri swallows HTML5 drag &
drop on Windows.

## Structure

```
src-tauri/src/
  main.rs        entry point (release builds without console)
  app.rs         Tauri setup, commands, tasks: event router, engine task (250 ms tick),
                 GUI push (debounced), saving (debounced + flush on exit), auto-accept,
                 summoner, update check/install
  lcu/           creds.rs (lockfile/process), client.rs (HTTPS), stream.rs (WAMP), mod.rs
                 (connector with reconnect, LcuHandle)
  engine.rs      pick/ban automation (core) + tests against a fake LCU
  champions.rs   champion catalog (Data Dragon / LCU)
  settings.rs    validation + config.json
  state.rs       single source of truth (store + Notify for GUI/saving)
  model.rs       data model = JSON contract with the frontend (camelCase)
  log.rs         ring buffer + event to the GUI
src/             React UI (App, PriorityRow, ChampionPicker, LivePanel, UpdateNotice, i18n, api)
src/shared/index.ts  TS mirror of model.rs
```

## Champ select engine (core rules)

- **Role** from `myTeam[me].assignedPosition`. Empty (only Arena/custom games — all standard
  queues assign roles) -> picks and bans stay manual; the live panel says so. `none` stays
  in the data model only for old configs.
- **Pick target:** the first champion of the role's list that isn't banned/locked, is
  pickable (`pickable-champion-ids`) and isn't claimed by a teammate (pick intent,
  selection, hover). First to hover keeps it (no ping-pong).
- **Pre-hover** in `timer.phase === 'PLANNING'`; lock only while our own action is active.
- **Ban target:** the first champion of the role's ban list that isn't gone, that neither a
  teammate nor we want to play (incl. the resolved pick target) and that no teammate is
  already hovering to ban. Hover + ban **only in `BAN_PICK`**, never in PLANNING (the ban
  action is `isInProgress` there, but completing it has no effect).
- **No filter via `bannable-champion-ids`** (v2.0.1): it was empty in a live test and
  blocked every ban. The client validates; if it refuses a hover with an HTTP error, the
  champion goes into `Track.rejected` and the next one is used. `pickable-champion-ids`
  stays (ownership), but an **empty** list counts as "unknown" -> check again later.
- **Random** (`RANDOM_PICK = -1` in the pick list, UI: dice): an owned (`pickable`) champion
  that Riot recommends for the role (LCU `/lol-perks/v1/recommended-champion-positions`,
  cached per champ select), not gone, not claimed by teammates, not on our own ban list.
  The roll stays stable (`Track.random`) and only re-rolls when it becomes unavailable. No
  position data -> no random pick (no Janna jungle).
- **Re-evaluate ~1×/s even without events** (events are irregular, in a solo custom game
  absent). That's why the timer runs from the event's arrival (`session_at`), never from
  the evaluation.
- **Lock/ban** shortly before the timer ends (`lockThresholdMs`, 1–15 s, default 3 s).
  Mode `hover-only` only hovers.
- **The user wins:** the engine remembers every champion it wrote itself (`Track.writes`).
  If a different one shows up, the user chose it -> automation for that action pauses for
  this champ select (`manual`). Before locking, also check that our target is actually
  hovered.
- The engine runs as **one** task (`&mut self`) -> LCU writes are serialized automatically.
  When in doubt, do nothing.

## Conventions

- Change the Rust model (`model.rs`) and the TS types (`src/shared/index.ts`) together.
- **Logs: English + ASCII only** (Windows console). New UI texts always go into **both**
  dictionaries (`de` is typed as `Dict` -> missing keys fail the typecheck).
- Settings: `%APPDATA%\Draftpilot\config.json` (same format as the Electron version; the
  v1.0.0 key `toggles` is still read).
- **Never write config.json "just in case"** (v2.3.1, after data loss): only on real changes
  in this session (`touch_settings` -> `take_settings_dirty`), atomically (`.json.tmp` +
  rename), previous version kept as `config.bak.json`. Unreadable file ->
  `config.broken.json`, don't overwrite.
- **Always start test instances with `DRAFTPILOT_DATA_DIR=<scratch>`**, otherwise they share
  `config.json` with the user's real app (a different `identifier` is not enough). Build test
  variants with `npx tauri build --no-bundle --config <file>` (own `identifier`/`productName`,
  so single-instance doesn't hand over to the real app); drive the UI via
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` + CDP. Don't launch
  windows while the user is in a game (check `/lol-gameflow/v1/gameflow-phase`).
- Cover engine changes with a test in `engine.rs` (`cargo test`).
- Vite builds to `web-dist/` (not `dist/`, which holds release copies the user may run
  directly). Never wipe `dist/`.

## Updates (in-app)

- **Source:** GitHub Releases of `nordavid/draftpilot` (public, otherwise the updater can't
  download without login). Endpoint in `tauri.conf.json` (`plugins.updater`):
  `…/releases/latest/download/latest.json` -> always the newest release.
- **Flow:** Rust checks on start (`check_update` in `app.rs`, not in dev builds) and sets
  `UiState.update`; the UI then shows `UpdateNotice` below the title bar. Click -> command
  `install_update`: flush settings if dirty (the updater quits via `process::exit`, without
  `RunEvent::Exit`), download, verify the signature, run the NSIS installer passively; it
  restarts the app afterwards. No `tauri-plugin-process` needed. Errors (offline, no release
  yet) only go to the log.
- **Signing:** key pair from `npx tauri signer generate`. The private key lives **outside
  the repo** at `%USERPROFILE%\.tauri\draftpilot.key` (no password), the public key as
  `pubkey` in `tauri.conf.json`. **Back it up!** Without it installed versions can't accept
  updates anymore (only a manual reinstall helps). `scripts/build.mjs` sets
  `TAURI_SIGNING_PRIVATE_KEY` (path) automatically.
- **Release flow** (local, **no GitHub Actions**):
  1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
  2. `npm run release -- "Short note in English"` -> `dist/<version>/`: setup EXE, `.sig`,
     `latest.json` (version, note, date, URL + signature), portable `Draftpilot.exe`.
  3. Commit + `git push` (gh puts the tag `v<version>` on the remote state).
  4. `npm run upload` -> `gh release create v<version>` with setup, `latest.json` and the
     portable EXE (run `gh auth login` once beforehand). `gh` lives in
     `C:\Program Files\GitHub CLI` (may be missing from PATH in older shells).
- The portable EXE doesn't replace itself: "Install" installs the new version normally
  (`%LOCALAPPDATA%\Draftpilot`) and starts that one.

## Commands

- `npm run dev` — Tauri dev (Vite HMR + Rust restart)
- `npm run release` — build the release and copy it to `dist/<version>/` (portable
  `Draftpilot.exe` + NSIS installer + `.sig` + `latest.json`). Always hand the user these
  copies: if they run the EXE straight from `src-tauri/target/release`, it's locked and the
  next build fails.
- `npm run upload` — upload `dist/<version>/` as GitHub release `v<version>` (gh CLI)
- `npm run build` — build only (`src-tauri/target/release/...`, signed; needs the key)
- `npm run typecheck` · `cargo test` (in `src-tauri/`) · `npm run vite:dev` (UI with mock)
- Rust/cargo lives in `%USERPROFILE%\.cargo\bin` (on PATH in fresh shells).
