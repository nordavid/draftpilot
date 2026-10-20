# Draftpilot

Kleiner Autopilot für die Champ Select in League of Legends. Läuft neben dem
League-Client und spricht mit ihm über die lokale Client-API (LCU). Oberfläche auf
Englisch oder Deutsch.

- **Match annehmen:** nimmt den Ready-Check automatisch an.
- **Picks pro Rolle:** Erstwahl + Fallbacks für Top, Jungle, Mid, Bot und Support. Ist ein
  Champion gebannt, schon weg, nicht im Besitz oder will ihn ein Teammate spielen, kommt der
  nächste dran. „Zufall" würfelt einen eigenen Champion, den Riot für die Rolle empfiehlt.
  Ohne zugewiesene Rolle (Arena, Custom) bleibt Picken/Bannen manuell.
- **Bans pro Rolle:** ebenfalls mit Fallbacks. Was ein Teammate (oder du selbst) spielen
  will, wird nie gebannt; was ein Teammate schon zum Bannen hovert, wird übersprungen.
- **Dein Pick geht vor:** Wählst du selbst einen anderen Champion, hält sich Draftpilot
  für den Rest dieser Champ Select raus.
- Gelockt wird kurz vor Ablauf des Timers (einstellbar), damit du dich noch umentscheiden
  kannst. Alternativ „Nur hovern".
- Ein Hauptschalter oben rechts pausiert alles.

## Technik

[Tauri v2](https://tauri.app): Backend in Rust, Oberfläche (React) im WebView2 von Windows.
Dadurch ist die App nur wenige MB groß statt ~100 MB wie mit Electron.

## Entwickeln

Voraussetzungen: Node.js, Rust (rustup, MSVC-Toolchain), Visual Studio C++ Build Tools.

```bash
npm install
npm run dev
```

- `npm run build` — Release-EXE (`src-tauri/target/release/draftpilot.exe`, läuft ohne
  Installation) und Installer (`src-tauri/target/release/bundle/nsis/`)
- `npm run typecheck` — TypeScript prüfen
- `cargo test` (in `src-tauri/`) — Engine-Tests mit simulierten Champ Selects
- `npm run vite:dev` — nur die Oberfläche im Browser, mit Beispieldaten

## Updates

Die installierte App sucht beim Start nach einer neueren Version (GitHub Releases) und
zeigt dann oben „Update verfügbar – Installieren". Ein Klick lädt das Update, prüft die
Signatur, installiert und startet neu.

Release veröffentlichen (lokal, ohne GitHub Actions):

```bash
npm run release -- "Kurze Notiz"
git push
npm run upload
```

`npm run release` braucht den privaten Signaturschlüssel unter
`%USERPROFILE%\.tauri\draftpilot.key` (nicht im Repo) und legt Installer, `.sig`,
`latest.json` und die portable EXE in `dist/<version>/`. `npm run upload` lädt sie per
`gh release create` hoch (einmalig `gh auth login`).

Einstellungen und Listen landen in `%APPDATA%\Draftpilot\config.json`. Die Champion-Liste
kommt von Riots Data Dragon, wird bei jedem Start gegen den aktuellen Patch abgeglichen und
je Sprache daneben gecacht.
