//! Zentraler Laufzeit-Zustand (Single Source of Truth). Mutationen rufen `touch()`
//! (nur GUI) bzw. `touch_settings()` (GUI + config.json); die Bruecke in lib.rs pusht
//! daraufhin entprellt einen Snapshot ans Frontend bzw. speichert.

use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

use crate::log::LogHub;
use crate::model::{LcuStatus, LiveView, RolePrefsMap, Settings, UiState};

pub struct Store {
    pub lcu: LcuStatus,
    pub phase: Option<String>,
    pub summoner_riot_id: Option<String>,
    pub live: Option<LiveView>,
    pub settings: Settings,
    pub roles: RolePrefsMap,
    /// Verfuegbares Update (Version), gesetzt von der Update-Pruefung beim Start.
    pub update: Option<String>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            lcu: LcuStatus::Searching,
            phase: None,
            summoner_riot_id: None,
            live: None,
            settings: Settings::default(),
            roles: RolePrefsMap::default(),
            update: None,
        }
    }
}

pub struct Shared {
    store: Mutex<Store>,
    pub log: Arc<LogHub>,
    pub version: String,
    /// Signal "GUI-Snapshot neu senden".
    pub ui_changed: Notify,
    /// Signal "config.json neu schreiben".
    pub settings_changed: Notify,
}

impl Shared {
    pub fn new(log: Arc<LogHub>, version: String) -> Arc<Shared> {
        Arc::new(Shared {
            store: Mutex::new(Store::default()),
            log,
            version,
            ui_changed: Notify::new(),
            settings_changed: Notify::new(),
        })
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn touch(&self) {
        self.ui_changed.notify_one();
    }

    pub fn touch_settings(&self) {
        self.ui_changed.notify_one();
        self.settings_changed.notify_one();
    }

    pub fn ui_state(&self) -> UiState {
        let s = self.store();
        UiState {
            version: self.version.clone(),
            lcu: s.lcu,
            phase: s.phase.clone(),
            summoner_riot_id: s.summoner_riot_id.clone(),
            settings: s.settings.clone(),
            roles: s.roles.clone(),
            live: s.live.clone(),
            update: s.update.clone(),
        }
    }
}
