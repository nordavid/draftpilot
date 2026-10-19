# Draftpilot — CLAUDE.md

## Projektüberblick

Eigenständiges Desktop-Tool für League of Legends: pro Rolle geordnete Pick- und
Ban-Listen (Erstwahl + Fallbacks), Auto-Accept, Hover + Auto-Lock kurz vor Timer-Ende.
Ein **Master-Toggle** übersteuert alles. GUI-Sprache: **Englisch (Standard) oder Deutsch**,
umschaltbar in den Einstellungen; Texte in `src/renderer/src/i18n.ts`. Logs sind immer Englisch.

Unabhängig vom A2Z Companion (`../a2z-companion`); die LCU-Schicht wurde von dort
**portiert, nicht geteilt** — bei Änderungen an `src/main/lcu/` daran denken, dass es
Kopien gibt (Companion, league-control).

## Tech-Stack

- **Electron** + **electron-vite**, Renderer **Vite + React** (TypeScript).
- **LCU nativ in Node, ohne `league-connect`:** `https` mit eigenem Agent
  (`rejectUnauthorized: false`) für REST, `ws` für den WAMP-Event-Stream.
- Champion-Daten von Riots **Data Dragon** (`ddragon.leagueoflegends.com`, en_US bzw. de_DE je
  GUI-Sprache), bei jedem Start gegen die aktuelle Patch-Version abgeglichen und je Sprache in
  `userData/champions-<locale>.json` gecacht; Fallback ohne Internet: LCU `champion-summary.json`.
- Rollen-Icons: Original-Pfade aus `rcp-fe-lol-static-assets` (CommunityDragon) inline in
  `RoleIcon.tsx`; „Fill" (Liste `none`/„Blind") nachgezeichnet, da dort nur als PNG.
- Schrift: Barlow / Barlow Semi Condensed via `@fontsource` (gebündelt, offline).
- Packaging: `electron-builder` -> `dist/<version>/`: NSIS-Installer + portable EXE, nur
  en-US/de-Chromium-Locales. **Keine GitHub Actions anlegen.**
- **`dist/` nie pauschal löschen:** Der Nutzer startet Builds teils direkt aus
  `dist/<version>/win-unpacked`; laufende Instanz vorher prüfen.

## Struktur

```
src/main/
  index.ts                 Verdrahtung, Fenster (titleBarOverlay), Single-Instance
  lcu/                     credentials, httpClient, eventStream, connector (Reconnect)
  features/
    gameflowWatcher.ts     Phasenwechsel
    autoAccept.ts          ReadyCheck -> accept
    summoner.ts            Riot-ID fuer die Anzeige
    champSelectEngine.ts   Pick-/Ban-Automatik (Kern)
  data/champions.ts        Champion-Katalog (Data Dragon / LCU)
  settings.ts              Validierung + config.json (Flush beim Beenden in ipc.ts)
  state/store.ts           Single Source of Truth (EventEmitter, touch())
  ipc.ts / preload.ts      Bruecke zur GUI (window.api)
src/shared/index.ts        IPC-Vertrag + Typen (Role, RolePrefs, Settings, LiveView ...)
src/renderer/src/          React-GUI (App, PriorityRow, ChampionPicker, LivePanel, i18n)
```

## Champ-Select-Engine (Kernregeln)

- **Rolle** aus `myTeam[me].assignedPosition`; leer -> Liste `none` (GUI: „Blind").
- **Pick-Ziel:** erster Champion der Rollenliste, der nicht gebannt/gelockt ist, pickbar
  (`pickable-champion-ids`) und nicht von einem Teammate beansprucht wird (Pick-Intent,
  Auswahl, Hover). Wer zuerst hovert, behält ihn (kein Ping-Pong).
- **Pre-Hover** in `timer.phase === 'PLANNING'`; gelockt nur bei aktiver eigener Action.
- **Ban-Ziel:** erster Champion der Rollen-Banliste, der nicht weg ist, den kein Teammate
  und nicht wir selbst spielen wollen (inkl. aufgelöstem Pick-Ziel), den kein Teammate
  schon zum Bannen hovert und der bannbar ist. Hover + Ban **nur in `BAN_PICK`**, nie in
  PLANNING (dort ist die Ban-Action zwar `isInProgress`, ein Complete wäre wirkungslos).
- **Lock/Ban** kurz vor Ablauf (`lockThresholdMs`, 1–15 s, Default 3 s), Timer-Tick 250 ms.
  Modus `hover-only` hovert nur.
- **Nutzer hat Vorrang:** Die Engine merkt sich jeden Champion, den sie selbst in eine
  Action geschrieben hat (`Track.writes`). Steht dort ein anderer, war es der Nutzer ->
  Automatik für diese Action in dieser Champ Select pausiert (`manual`). Vor dem Lock
  wird zusätzlich geprüft, dass wirklich unser Ziel gehovert ist.
- Alle LCU-Schreibzugriffe laufen serialisiert über eine Promise-Chain; jeder Call in
  try/catch; im Zweifel nichts tun.

## Konventionen

- TypeScript überall, getrennte tsconfigs (Node / Web).
- IPC-Verträge nur in `src/shared/index.ts`.
- **Logs Englisch + ASCII-only** (Windows-Konsole -> Mojibake): `->` statt Pfeil.
  GUI-Texte (i18n.ts) und Kommentare dürfen Umlaute haben.
- Neue GUI-Texte immer in **beiden** Wörterbüchern (`en`, `de`) in `i18n.ts` anlegen;
  `de` ist als `Dict` typisiert, fehlende Schlüssel fallen im Typecheck auf.
- Dev-Start aus Claude-Tools: `ELECTRON_RUN_AS_NODE` vorher leeren
  (`$env:ELECTRON_RUN_AS_NODE=$null; npm run dev`), sonst startet Electron als Node.

## Befehle

- `npm run dev` · `npm run typecheck` · `npm run build` · `npm run build:win`
