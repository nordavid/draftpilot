//! Einstellungen: Validierung (gemeinsam fuer config.json und GUI) und Persistenz.
//! Gleiches Format und gleicher Ort wie die Electron-Version (%APPDATA%\Draftpilot\config.json),
//! damit vorhandene Listen erhalten bleiben.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::log::Logger;
use crate::model::{
    Language, LockMode, RolePrefs, Settings, LOCK_THRESHOLD_MAX_MS, LOCK_THRESHOLD_MIN_MS,
    MAX_LIST, RANDOM_PICK, ROLES,
};
use crate::state::Store;

/// Uebernimmt nur gueltige Felder aus `input` (JSON-Objekt) in `target`.
pub fn apply_settings(target: &mut Settings, input: &Value) {
    match input.get("language").and_then(Value::as_str) {
        Some("en") => target.language = Language::En,
        Some("de") => target.language = Language::De,
        _ => {}
    }
    let flag = |key: &str| input.get(key).and_then(Value::as_bool);
    if let Some(v) = flag("masterEnabled") {
        target.master_enabled = v;
    }
    if let Some(v) = flag("autoAccept") {
        target.auto_accept = v;
    }
    if let Some(v) = flag("autoPick") {
        target.auto_pick = v;
    }
    if let Some(v) = flag("autoBan") {
        target.auto_ban = v;
    }
    match input.get("lockMode").and_then(Value::as_str) {
        Some("auto-lock") => target.lock_mode = LockMode::AutoLock,
        Some("hover-only") => target.lock_mode = LockMode::HoverOnly,
        _ => {}
    }
    if let Some(ms) = input.get("lockThresholdMs").and_then(Value::as_f64) {
        if ms.is_finite() {
            let clamped = ms.round().clamp(LOCK_THRESHOLD_MIN_MS as f64, LOCK_THRESHOLD_MAX_MS as f64);
            target.lock_threshold_ms = clamped as u32;
        }
    }
}

/// Positive, eindeutige Champion-IDs in Eingabereihenfolge, gekappt auf MAX_LIST.
/// Pick-Listen duerfen zusaetzlich einmal den Zufalls-Platzhalter enthalten.
fn sanitize_list(input: Option<&Value>, allow_random: bool) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    for v in input.and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = v.as_i64() {
            let valid = id > 0 || (allow_random && id == RANDOM_PICK);
            if valid && !out.contains(&id) {
                out.push(id);
            }
        }
        if out.len() >= MAX_LIST {
            break;
        }
    }
    out
}

pub fn sanitize_role_prefs(input: &Value) -> RolePrefs {
    RolePrefs {
        picks: sanitize_list(input.get("picks"), true),
        bans: sanitize_list(input.get("bans"), false),
    }
}

pub fn load_into(store: &mut Store, path: &Path, log: &Logger) {
    let data: Value = match fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(v) => v,
        None => {
            log.info("No config.json yet - starting with defaults.");
            return;
        }
    };
    // "toggles" = Schluessel aus v1.0.0.
    if let Some(settings) = data.get("settings").or_else(|| data.get("toggles")) {
        apply_settings(&mut store.settings, settings);
    }
    if let Some(roles) = data.get("roles") {
        for role in ROLES {
            if let Some(prefs) = roles.get(role.key()) {
                *store.roles.get_mut(role) = sanitize_role_prefs(prefs);
            }
        }
    }
    log.info("Settings loaded from config.json.");
}

pub fn save(store: &Store, path: &Path) {
    let data = json!({ "settings": store.settings, "roles": store.roles });
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(&data) {
        // Schreibfehler sind nicht fatal.
        let _ = fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_only_valid_fields() {
        let mut s = Settings::default();
        apply_settings(
            &mut s,
            &json!({ "language": "de", "autoBan": false, "lockMode": "bogus", "lockThresholdMs": 99999 }),
        );
        assert_eq!(s.language, Language::De);
        assert!(!s.auto_ban);
        assert_eq!(s.lock_mode, LockMode::AutoLock);
        assert_eq!(s.lock_threshold_ms, LOCK_THRESHOLD_MAX_MS);
    }

    #[test]
    fn sanitizes_lists() {
        let p = sanitize_role_prefs(&json!({ "picks": [1, 1, -3, "x", 2, 3, 4, 5, 6, 7], "bans": null }));
        assert_eq!(p.picks, vec![1, 2, 3, 4, 5, 6]);
        assert!(p.bans.is_empty());

        // Zufall nur in Picks und nur einmal.
        let p = sanitize_role_prefs(&json!({ "picks": [-1, 5, -1], "bans": [-1, 7] }));
        assert_eq!(p.picks, vec![RANDOM_PICK, 5]);
        assert_eq!(p.bans, vec![7]);
    }
}
