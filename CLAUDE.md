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
  `src/components/RoleIcon.tsx` (nur die fünf Lanes; der frühere „Blind"-Tab ist seit 2.3.0 weg).
- **Keine GitHub Actions anlegen.**

## Optik

League-Client-Vokabular, bewusst schlicht: Hextech-Navy (`#010a13`/`#0a1428`), dünne
Goldrahmen (`#463714`/`#785a28`/`#c8aa6e`), eckige Formen, Marcellus (Versalien) nur für
Wortmarke und Überschriften, sonst Segoe UI. Hextech-Blau `#0ac8b9` = läuft/live,
Gold = Auswahl/Erstwahl, Rot `#e84057` = Ban. Eigene Titelleiste (`decorations: false`,
`data-tauri-drag-region`, `WindowControls.tsx`). Texte kurz halten, keine Tooltips.
In der Champ Select ersetzt das Live-Panel die Statuszeile.

Fenster startet `visible: false` + `backgroundColor` (kein weißer Blitz). Das Frontend misst
mit dem ersten Zustand die nötige Höhe (`naturalHeight` + `LIVE_PANEL_EXTRA`, damit auch die
Champ Select ohne Scrollbalken passt), setzt sie (begrenzt durch `screen.availHeight`),
zentriert und zeigt das Fenster (`fitAndShowWindow`); Rust zeigt es nach 3 s als
Sicherheitsnetz. Freie Höhe außerhalb der Champ Select sitzt über dem Protokoll
(`.log { margin-top: auto }`). Neue Elemente -> `LIVE_PANEL_EXTRA`/Messung prüfen.
`dragDropEnabled: false` ist Pflicht, sonst schluckt Tauri unter Windows HTML5-Drag&Drop.

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
src/             React-GUI (App, PriorityRow, ChampionPicker, LivePanel, UpdateNotice, i18n, api)
src/shared/index.ts  TS-Spiegel von model.rs
```

## Champ-Select-Engine (Kernregeln)

- **Rolle** aus `myTeam[me].assignedPosition`. Leer (nur noch Arena/Custom Games – alle
  Standard-Queues weisen Rollen zu) -> Picken/Bannen bleibt manuell; Live-Panel zeigt das.
  `none` bleibt im Datenmodell nur für alte Konfigurationen.
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
- **Zufall** (`RANDOM_PICK = -1` in der Pick-Liste, GUI: Würfel): eigener (`pickable`)
  Champion, den Riot für die Rolle empfiehlt (LCU `/lol-perks/v1/recommended-champion-positions`,
  je Champ Select gecacht), nicht weg, nicht von Mates beansprucht, nicht auf der eigenen
  Banliste. Die Wahl bleibt stabil (`Track.random`) und wird nur neu
  gewürfelt, wenn sie nicht mehr geht. Ohne Positionsdaten -> kein Zufall (kein Janna-Jungle).
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

## Updates (In-App)

- **Quelle:** GitHub Releases von `nordavid/draftpilot` (öffentlich, sonst kann der Updater
  ohne Login nicht laden). Endpoint in `tauri.conf.json` (`plugins.updater`):
  `…/releases/latest/download/latest.json` -> immer das neueste Release.
- **Ablauf:** Rust prüft beim Start (`check_update` in `app.rs`, nicht in Dev-Builds) und
  setzt `UiState.update`; die GUI zeigt dann `UpdateNotice` unter der Titelleiste. Klick ->
  Befehl `install_update`: Einstellungen speichern (der Updater beendet per `process::exit`,
  ohne `RunEvent::Exit`), laden, Signatur prüfen, NSIS-Installer passiv starten; der
  startet die App danach neu. Kein `tauri-plugin-process` nötig. Fehler (offline, noch
  kein Release) nur ins Log.
- **Signatur:** Schlüsselpaar aus `npx tauri signer generate`. Privater Schlüssel liegt
  **außerhalb des Repos** unter `%USERPROFILE%\.tauri\draftpilot.key` (ohne Passwort),
  öffentlicher Schlüssel als `pubkey` in `tauri.conf.json`. **Sichern!** Ohne ihn können
  installierte Versionen keine Updates mehr annehmen (dann nur noch manuell neu
  installieren). `scripts/build.mjs` setzt `TAURI_SIGNING_PRIVATE_KEY` (Pfad) automatisch.
- **Release-Ablauf** (lokal, **keine GitHub Actions**):
  1. Version in `package.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` erhöhen.
  2. `npm run release -- "Kurze Notiz"` -> `dist/<version>/`: Setup-EXE, `.sig`,
     `latest.json` (Version, Notiz, Datum, URL + Signatur), portable `Draftpilot.exe`.
  3. Commit + `git push` (gh legt den Tag `v<version>` auf den Remote-Stand).
  4. `npm run upload` -> `gh release create v<version>` mit Setup, `latest.json` und
     portabler EXE (einmalig vorher `gh auth login`).
- Die portable EXE aktualisiert sich nicht selbst: „Installieren" installiert die neue
  Version regulär (`%LOCALAPPDATA%\Draftpilot`) und startet diese.

## Befehle

- `npm run dev` — Tauri-Dev (Vite-HMR + Rust-Neustart)
- `npm run release` — Release bauen und nach `dist/<version>/` kopieren (`Draftpilot.exe`
  portabel + NSIS-Installer + `.sig` + `latest.json`). Dem Nutzer immer diese Kopien geben:
  startet er die EXE direkt aus `src-tauri/target/release`, ist sie gesperrt und der nächste
  Build scheitert.
- `npm run upload` — `dist/<version>/` als GitHub-Release `v<version>` hochladen (gh CLI)
- `npm run build` — nur bauen (`src-tauri/target/release/...`, signiert; braucht den Schlüssel)
- `npm run typecheck` · `cargo test` (in `src-tauri/`) · `npm run vite:dev` (GUI mit Mock)
- Rust/cargo liegt in `%USERPROFILE%\.cargo\bin` (in frischen Shells im PATH).
