# Draftpilot

Kleiner Autopilot für die Champ Select in League of Legends. Läuft neben dem
League-Client und spricht mit ihm über die lokale Client-API (LCU).

- **Match annehmen:** nimmt den Ready-Check automatisch an.
- **Picks pro Rolle:** Erstwahl + Fallbacks für Top, Jungle, Mid, Bot, Support und
  „Ohne Rolle" (Blind Pick). Ist ein Champion gebannt, schon weg, nicht im Besitz oder
  will ihn ein Teammate spielen, kommt der nächste dran.
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
- `npm run build:win` — Windows-Installer (NSIS) nach `dist/`

Einstellungen landen in `%APPDATA%\Draftpilot\config.json`, die Champion-Liste
(Riot Data Dragon) wird in `champions.json` daneben gecacht.
