# Draftpilot — CLAUDE.md

## Projektüberblick

Eigenständiges Desktop-Tool für League of Legends: pro Rolle geordnete Pick- und
Ban-Listen (Erstwahl + Fallbacks), Auto-Accept, Hover + Auto-Lock kurz vor Timer-Ende.
Ein **Master-Toggle** übersteuert alles. GUI-Sprache: **Englisch (Standard) oder Deutsch**,
umschaltbar in den Einstellungen; Texte in `src/i18n.ts`. Logs sind immer Englisch.

Seit v2.0.0 **Tauri statt Electron** (Ziel: wenige MB statt ~100 MB). Die LCU-Logik stammt
ursprünglich aus dem A2Z Companion (`../a2z-companion`, TypeScript) und wurde nach Rust
**portiert** — bei LCU-Fixes dort/hier gegenseitig mitdenken (weitere Kopie: league-control).

## Tech-Stack

- **Tauri v2**: Rust-Backend (`src-tauri/`), GUI in **WebView2** (bei Win10/11 vorinstalliert).
- **Frontend:** Vite + React 19 + TypeScript (`src/`). Spricht nur über `src/api.ts` mit dem
  Backend (Tauri-Befehle `get_state`, `get_logs`, `get_champions`, `set_settings`,
  `set_role` + Events `state`, `log`, `champions`). Im normalen Browser (`npm run vite:dev`)
  läuft die GUI gegen Beispieldaten (`src/mockApi.ts`, URL-Parameter `?live=0&lang=de&paused=1`).
- **LCU in Rust ohne Wrapper-Crate:** `reqwest` (native-tls, Zertifikatsprüfung aus nur für
  127.0.0.1) für REST, `tokio-tungstenite` für den WAMP-Event-Stream, `sysinfo` für die
  Prozess-Argumente von `LeagueClientUx.exe`.
- Champion-Daten: Riot **Data Dragon** (en_US/de_DE je GUI-Sprache), bei jedem Start gegen
  den aktuellen Patch abgeglichen, je Sprache gecacht; Fallback ohne Internet: LCU
  `champion-summary.json` (ohne Icons).
- Rollen-Icons: Original-Pfade aus `rcp-fe-lol-static-assets` (CommunityDragon) inline in
  `src/components/RoleIcon.tsx`; „Fill" (Liste `none`/„Blind") nachgezeichnet.
- **Keine GitHub Actions anlegen.**

## Optik

League-Client-Vokabular, bewusst schlicht: Hextech-Navy (`#010a13`/`#0a1428`), dünne
Goldrahmen (`#463714`/`#785a28`/`#c8aa6e`), eckige Formen, Marcellus (Versalien) nur für
Wortmarke und Überschriften, sonst Segoe UI. Hextech-Blau `#0ac8b9` = läuft/live,
Gold = Auswahl/Erstwahl, Rot `#e84057` = Ban. Eigene Titelleiste (`decorations: false`,
`data-tauri-drag-region`, `WindowControls.tsx`).

## Struktur

```
src-tauri/src/
  main.rs        Einstieg (Release ohne Konsole)
  app.rs         Tauri-Setup, Befehle, Tasks: Event-Router, Engine-Task (250-ms-Tick),
                 GUI-Push (entprellt), Speichern (entprellt + Flush bei Exit), Auto-Accept,
                 Summoner
  lcu/           creds.rs (Lockfile/Prozess), client.rs (HTTPS), stream.rs (WAMP), mod.rs
                 (Connector mit Reconnect, LcuHandle)
  engine.rs      Pick-/Ban-Automatik (Kern) + Tests mit Fake-LCU
  champions.rs   Champion-Katalog (Data Dragon / LCU)
  settings.rs    Validierung + config.json
  state.rs       Single Source of Truth (Store + Notify für GUI/Speichern)
  model.rs       Datenmodell = JSON-Vertrag zum Frontend (camelCase)
  log.rs         Ringpuffer + Event an die GUI
src/             React-GUI (App, PriorityRow, ChampionPicker, LivePanel, i18n, api)
src/shared/index.ts  TS-Spiegel von model.rs
```

## Champ-Select-Engine (Kernregeln)

- **Rolle** aus `myTeam[me].assignedPosition`; leer -> Liste `none` (GUI: „Blind").
- **Pick-Ziel:** erster Champion der Rollenliste, der nicht gebannt/gelockt ist, pickbar
  (`pickable-champion-ids`) und nicht von einem Teammate beansprucht wird (Pick-Intent,
  Auswahl, Hover). Wer zuerst hovert, behält ihn (kein Ping-Pong).
- **Pre-Hover** in `timer.phase === 'PLANNING'`; gelockt nur bei aktiver eigener Action.
- **Ban-Ziel:** erster Champion der Rollen-Banliste, der nicht weg ist, den kein Teammate
  und nicht wir selbst spielen wollen (inkl. aufgelöstem Pick-Ziel) und den kein Teammate
  schon zum Bannen hovert. Hover + Ban **nur in `BAN_PICK`**, nie in PLANNING (dort ist die
  Ban-Action zwar `isInProgress`, ein Complete wäre wirkungslos).
- **Kein Filter über `bannable-champion-ids`** (v2.0.1): war im Live-Test leer und hat jeden
  Ban verhindert. Der Client validiert; lehnt er einen Hover per HTTP-Fehler ab, kommt der
  Champion in `Track.rejected` und der nächste ist dran. `pickable-champion-ids` bleibt
  (Besitz), eine **leere** Liste gilt aber als „unbekannt" -> später erneut prüfen.
- **Neubewertung ~1×/s auch ohne Event** (Events kommen unregelmäßig, im Solo-Custom gar
  nicht). Der Timer rechnet deshalb ab Empfang des Events (`session_at`), nie ab Auswertung.
- **Lock/Ban** kurz vor Ablauf (`lockThresholdMs`, 1–15 s, Default 3 s). Modus
  `hover-only` hovert nur.
- **Nutzer hat Vorrang:** Die Engine merkt sich jeden selbst geschriebenen Champion
  (`Track.writes`). Steht dort ein anderer, war es der Nutzer -> Automatik für diese
  Action in dieser Champ Select pausiert (`manual`). Vor dem Lock zusätzlich prüfen, dass
  wirklich unser Ziel gehovert ist.
- Die Engine läuft als **eine** Task (`&mut self`) -> LCU-Schreibzugriffe automatisch
  serialisiert. Im Zweifel nichts tun.

## Konventionen

- Rust-Modell (`model.rs`) und TS-Typen (`src/shared/index.ts`) immer gemeinsam ändern.
- **Logs Englisch + ASCII-only** (Windows-Konsole). GUI-Texte (`i18n.ts`) und Kommentare
  dürfen Umlaute haben; neue Texte immer in **beiden** Wörterbüchern (`de` ist als `Dict`
  typisiert -> fehlende Schlüssel fallen im Typecheck auf).
- Einstellungen: `%APPDATA%\Draftpilot\config.json` (gleiches Format wie die Electron-Version;
  Schlüssel `toggles` aus v1.0.0 wird noch gelesen).
- Engine-Änderungen mit einem Test in `engine.rs` absichern (`cargo test`).
- Vite baut nach `web-dist/` (nicht `dist/`: dort liegen alte Electron-Builds, die der Nutzer
  ggf. noch direkt startet). `dist/` nie pauschal löschen.

## Befehle

- `npm run dev` — Tauri-Dev (Vite-HMR + Rust-Neustart)
- `npm run release` — Release bauen und nach `dist/<version>/` kopieren (`Draftpilot.exe`
  portabel + NSIS-Installer). Dem Nutzer immer diese Kopien geben: startet er die EXE direkt
  aus `src-tauri/target/release`, ist sie gesperrt und der nächste Build scheitert.
- `npm run build` — nur bauen (`src-tauri/target/release/...`)
- `npm run typecheck` · `cargo test` (in `src-tauri/`) · `npm run vite:dev` (GUI mit Mock)
- Rust/cargo liegt in `%USERPROFILE%\.cargo\bin` (in frischen Shells im PATH).
