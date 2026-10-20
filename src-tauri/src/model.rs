//! Data model sent 1:1 as JSON to the frontend (camelCase, see src/shared/index.ts).

use serde::{Deserialize, Serialize};

/// Maximum length of a pick/ban list (first choice + fallbacks).
pub const MAX_LIST: usize = 6;
/// Placeholder in a pick list: a random owned champion that fits the role.
pub const RANDOM_PICK: i64 = -1;
pub const LOCK_THRESHOLD_MIN_MS: u32 = 1000;
pub const LOCK_THRESHOLD_MAX_MS: u32 = 15000;

/// Role key = LCU `assignedPosition`. `None` = no role assigned (Arena, custom games).
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

    /// LCU position name (`recommendedPositions`); None = no role.
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
    /// Data Dragon locale for champion names.
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

/// Settings. The master switch overrides everything: when it's off, the tool does nothing.
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

/// Ordered lists for one role (numeric Riot champion IDs, first choice first).
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
    /// Target known, our action isn't active yet.
    Waiting,
    /// Hovered, lock follows shortly before the timer ends.
    Hovering,
    /// Hovered, lock mode "hover only".
    HoverOnly,
    /// Locked in or banned.
    Done,
    /// The user chose manually -> automation paused.
    Manual,
    /// No champion from the list available.
    None,
    /// List for this role is empty.
    Empty,
    /// Feature disabled.
    Off,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionView {
    pub status: ActionStatus,
    pub champion_id: Option<i64>,
    /// Planned lock time (epoch ms) for the GUI countdown.
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
    /// Newer version found by the updater (otherwise None).
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
    /// Numeric Riot ID (= LCU championId).
    pub id: i64,
    /// Data Dragon key, e.g. "MonkeyKing" (for icon URLs).
    pub alias: String,
    /// Localized display name.
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ChampionCatalog {
    /// Data Dragon version for icons (None = list came from the LCU, no icons).
    pub version: Option<String>,
    pub champions: Vec<Champion>,
}

/// Current time as epoch ms (same clock as `Date.now()` in the frontend).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
