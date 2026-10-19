# Draftpilot

Kleiner Autopilot für die Champ Select in League of Legends. Läuft neben dem
League-Client und spricht mit ihm über die lokale Client-API (LCU). Oberfläche auf
Englisch oder Deutsch.

- **Match annehmen:** nimmt den Ready-Check automatisch an.
- **Picks pro Rolle:** Erstwahl + Fallbacks für Top, Jungle, Mid, Bot, Support und
  „Blind" (wenn keine Rolle zugewiesen wird, z. B. Blind Pick). Ist ein Champion gebannt,
  schon weg, nicht im Besitz oder will ihn ein Teammate spielen, kommt der nächste dran.
- **Bans pro Rolle:** ebenfalls mit Fallbacks. Was ein Teammate (oder du selbst) spielen
  will, wird nie gebannt; was ein Teammate schon zum Bannen hovert, wird übersprungen.
- **Dein Pick geht vor:** Wählst du selbst einen anderen Champion, hält sich Draftpilot
  für den Rest dieser Champ Select raus.
- Gelockt wird kurz vor Ablauf des Timers (einstellbar), damit du dich noch umentscheiden
  kannst. Alternativ „Nur hovern".
- Ein Hauptschalter oben rechts pausiert alles.

## Entwickeln

```bash
npm install
npm run dev
```

- `npm run typecheck` — TypeScript für Main und Renderer prüfen
- `npm run build` — nach `out/` bauen
- `npm run build:win` — nach `dist/<version>/`: Installer (`Draftpilot Setup <v>.exe`),
  portable EXE (`Draftpilot <v> Portable.exe`) und entpackte App (`win-unpacked/`)

Einstellungen und Listen landen in `%APPDATA%\Draftpilot\config.json` (gilt für Installer
und portable Version gleichermaßen). Die Champion-Liste kommt von Riots Data Dragon, wird
bei jedem Start gegen den aktuellen Patch abgeglichen und je Sprache daneben gecacht.
