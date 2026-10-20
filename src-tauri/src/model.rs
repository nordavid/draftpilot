//! Datenmodell, das 1:1 als JSON an das Frontend geht (camelCase, siehe src/shared/index.ts).

use serde::{Deserialize, Serialize};

/// Maximale Laenge je Pick-/Ban-Liste (Erstwahl + Fallbacks).
pub const MAX_LIST: usize = 6;
/// Platzhalter in der Pick-Liste: zufaelliger eigener Champion, der zur Rolle passt.
pub const RANDOM_PICK: i64 = -1;
pub const LOCK_THRESHOLD_MIN_MS: u32 = 1000;
pub const LOCK_THRESHOLD_MAX_MS: u32 = 15000;

/// Rollen-Schluessel = LCU-`assignedPosition`. `None` greift ohne Rollenzuweisung (Blind Pick).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Top,
    Jungle,
    Middle,
    Bottom,
    Utility,
    None,
}

pub const ROLES: [Role; 6] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Bottom,
    Role::Utility,
    Role::None,
];

impl Role {
    pub fn from_position(position: &str) -> Role {
        match position.to_ascii_lowercase().as_str() {
            "top" => Role::Top,
            "jungle" => Role::Jungle,
            "middle" => Role::Middle,
            "bottom" => Role::Bottom,
            "utility" => Role::Utility,
            _ => Role::None,
        }
    }

    /// Positionsname der LCU (`recommendedPositions`); None = keine Rolle (alles erlaubt).
    pub fn lcu_position(self) -> Option<&'static str> {
        match self {
            Role::Top => Some("TOP"),
            Role::Jungle => Some("JUNGLE"),
            Role::Middle => Some("MIDDLE"),
            Role::Bottom => Some("BOTTOM"),
            Role::Utility => Some("UTILITY"),
            Role::None => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Role::Top => "top",
            Role::Jungle => "jungle",
            Role::Middle => "middle",
            Role::Bottom => "bottom",
            Role::Utility => "utility",
            Role::None => "none",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    De,
}

impl Language {
    /// Data-Dragon-Locale fuer Champion-Namen.
    pub fn locale(self) -> &'static str {
        match self {
            Language::En => "en_US",
            Language::De => "de_DE",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum LockMode {
    AutoLock,
    HoverOnly,
}

/// Einstellungen. Master uebersteuert alles: ist er aus, tut das Tool nichts.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub language: Language,
    pub master_enabled: bool,
    pub auto_accept: bool,
    pub auto_pick: bool,
    pub auto_ban: bool,
    pub lock_mode: LockMode,
    pub lock_threshold_ms: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: Language::En,
            master_enabled: true,
            auto_accept: true,
            auto_pick: true,
            auto_ban: true,
            lock_mode: LockMode::AutoLock,
            lock_threshold_ms: 3000,
        }
    }
}

/// Geordnete Wunschlisten einer Rolle (numerische Riot-Champion-IDs, Erstwahl zuerst).
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct RolePrefs {
    pub picks: Vec<i64>,
    pub bans: Vec<i64>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct RolePrefsMap {
    pub top: RolePrefs,
    pub jungle: RolePrefs,
    pub middle: RolePrefs,
    pub bottom: RolePrefs,
    pub utility: RolePrefs,
    pub none: RolePrefs,
}

impl RolePrefsMap {
    pub fn get(&self, role: Role) -> &RolePrefs {
        match role {
            Role::Top => &self.top,
            Role::Jungle => &self.jungle,
            Role::Middle => &self.middle,
            Role::Bottom => &self.bottom,
            Role::Utility => &self.utility,
            Role::None => &self.none,
        }
    }

    pub fn get_mut(&mut self, role: Role) -> &mut RolePrefs {
        match role {
            Role::Top => &mut self.top,
            Role::Jungle => &mut self.jungle,
            Role::Middle => &mut self.middle,
            Role::Bottom => &mut self.bottom,
            Role::Utility => &mut self.utility,
            Role::None => &mut self.none,
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ActionStatus {
    /// Ziel steht fest, unsere Action ist noch nicht dran.
    Waiting,
    /// Gehovert, Lock folgt kurz vor Ablauf.
    Hovering,
    /// Gehovert, Lock-Modus "nur hovern".
    HoverOnly,
    /// Gelockt bzw. gebannt.
    Done,
    /// Nutzer hat selbst gewaehlt -> Automatik pausiert.
    Manual,
    /// Kein Champion der Liste verfuegbar.
    None,
    /// Liste fuer diese Rolle leer.
    Empty,
    /// Feature deaktiviert.
    Off,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionView {
    pub status: ActionStatus,
    pub champion_id: Option<i64>,
    /// Geplanter Lock-Zeitpunkt (epoch ms) fuer den GUI-Countdown.
    pub lock_at: Option<i64>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct LiveView {
    pub role: Role,
    pub pick: Option<ActionView>,
    pub ban: Option<ActionView>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LcuStatus {
    Searching,
    Connected,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub version: String,
    pub lcu: LcuStatus,
    pub phase: Option<String>,
    pub summoner_riot_id: Option<String>,
    pub settings: Settings,
    pub roles: RolePrefsMap,
    pub live: Option<LiveView>,
    /// Neuere Version, die der Updater gefunden hat (sonst None).
    pub update: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Event,
}

#[derive(Serialize, Clone, Debug)]
pub struct LogEntry {
    pub ts: i64,
    pub scope: String,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Champion {
    /// Numerische Riot-ID (= LCU championId).
    pub id: i64,
    /// Data-Dragon-Key, z. B. "MonkeyKing" (fuer Icon-URLs).
    pub alias: String,
    /// Lokalisierter Anzeigename.
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ChampionCatalog {
    /// Data-Dragon-Version der Icons (None = Liste stammt aus der LCU, keine Icons).
    pub version: Option<String>,
    pub champions: Vec<Champion>,
}

/// Aktuelle Zeit als epoch ms (gleiche Uhr wie `Date.now()` im Frontend).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
