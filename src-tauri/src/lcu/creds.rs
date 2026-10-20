//! LCU credential discovery. Two sources:
//!   1. Lockfile in the install folder: `LeagueClient:PID:PORT:TOKEN:PROTOCOL`
//!   2. Process arguments of LeagueClientUx.exe (`--app-port` / `--remoting-auth-token`)
//! Port and token change on every client start, so always look them up fresh.

use std::path::PathBuf;

use base64::Engine as _;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Debug)]
pub struct Credentials {
    pub port: u16,
    pub token: String,
    pub source: &'static str,
}

impl Credentials {
    pub fn base_url(&self) -> String {
        format!("https://127.0.0.1:{}", self.port)
    }

    pub fn ws_url(&self) -> String {
        format!("wss://127.0.0.1:{}/", self.port)
    }

    /// "Basic " + base64("riot:" + token)
    pub fn auth_header(&self) -> String {
        let raw = format!("riot:{}", self.token);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
    }
}

const DEFAULT_INSTALL_DIRS: [&str; 2] =
    ["C:\\Riot Games\\League of Legends", "C:\\Program Files\\Riot Games\\League of Legends"];

fn from_lockfile() -> Option<Credentials> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("LCU_INSTALL_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    dirs.extend(DEFAULT_INSTALL_DIRS.iter().map(PathBuf::from));

    for dir in dirs {
        let Ok(raw) = std::fs::read_to_string(dir.join("lockfile")) else { continue };
        let parts: Vec<&str> = raw.trim().split(':').collect();
        if parts.len() >= 5 {
            if let Ok(port) = parts[2].parse::<u16>() {
                if !parts[3].is_empty() {
                    return Some(Credentials { port, token: parts[3].to_string(), source: "lockfile" });
                }
            }
        }
    }
    None
}

fn from_process() -> Option<Credentials> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    for process in sys.processes().values() {
        if !process.name().eq_ignore_ascii_case("LeagueClientUx.exe") {
            continue;
        }
        let mut port: Option<u16> = None;
        let mut token: Option<String> = None;
        for arg in process.cmd() {
            let arg = arg.to_string_lossy();
            if let Some(v) = arg.strip_prefix("--app-port=") {
                port = v.parse().ok();
            } else if let Some(v) = arg.strip_prefix("--remoting-auth-token=") {
                token = Some(v.to_string());
            }
        }
        if let (Some(port), Some(token)) = (port, token) {
            return Some(Credentials { port, token, source: "process" });
        }
    }
    None
}

/// Lockfile first (cheap), then the process arguments. Blocking -> use spawn_blocking.
pub fn discover() -> Option<Credentials> {
    from_lockfile().or_else(from_process)
}
