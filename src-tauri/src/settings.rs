//! Settings: validation (shared by config.json and the GUI) and persistence.
//! Same format and location as the Electron version (%APPDATA%\Draftpilot\config.json),
//! so existing lists carry over.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::log::Logger;
use crate::model::{
    Language, LockMode, Position, Role, RolePrefs, Settings, LOCK_THRESHOLD_MAX_MS,
    LOCK_THRESHOLD_MIN_MS, MAX_LIST, RANDOM_PICK, ROLES,
};
use crate::state::Store;

/// Copies only valid fields from `input` (JSON object) into `target`.
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

/// Positive, unique champion IDs in input order, capped at MAX_LIST.
/// Pick lists may also contain the random placeholder once.
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

pub fn sanitize_role_prefs(input: &Value, role: Role) -> RolePrefs {
    // The second role can't be the role itself (that's the first one) -> Fill.
    let second_role = input
        .get("secondRole")
        .and_then(Value::as_str)
        .and_then(Position::from_key)
        .filter(|p| Some(p.lcu()) != role.lcu_position())
        .unwrap_or_default();
    RolePrefs {
        picks: sanitize_list(input.get("picks"), true),
        bans: sanitize_list(input.get("bans"), false),
        second_role,
    }
}

/// Result of loading. Only `Loaded`/`Missing` leave a reliable in-memory state.
#[derive(Debug, PartialEq, Eq)]
pub enum LoadOutcome {
    Loaded,
    Missing,
    /// File exists but is unreadable/not JSON -> kept as config.broken.json.
    Unreadable,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub fn load_into(store: &mut Store, path: &Path, log: &Logger) -> LoadOutcome {
    if !path.exists() {
        log.info("No config.json yet - starting with defaults.");
        return LoadOutcome::Missing;
    }
    // Retry briefly: another instance might be writing right now.
    let mut data = None;
    for attempt in 0..5 {
        data = read_json(path);
        if data.is_some() {
            break;
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
    }
    let Some(data) = data else {
        let _ = fs::copy(path, path.with_extension("broken.json"));
        log.warn("config.json unreadable - kept a copy as config.broken.json, using defaults.");
        return LoadOutcome::Unreadable;
    };
    // "toggles" = key used by v1.0.0.
    if let Some(settings) = data.get("settings").or_else(|| data.get("toggles")) {
        apply_settings(&mut store.settings, settings);
    }
    if let Some(roles) = data.get("roles") {
        for role in ROLES {
            if let Some(prefs) = roles.get(role.key()) {
                *store.roles.get_mut(role) = sanitize_role_prefs(prefs, role);
            }
        }
    }
    log.info("Settings loaded from config.json.");
    LoadOutcome::Loaded
}

/// Writes atomically (temp file + rename) so a half-written file is never read.
/// The previous version is kept as config.bak.json.
pub fn save(store: &Store, path: &Path) -> std::io::Result<()> {
    let data = json!({ "settings": store.settings, "roles": store.roles });
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(&data).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    if path.exists() {
        let _ = fs::copy(path, path.with_extension("bak.json"));
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("draftpilot-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_is_atomic_and_keeps_backup() {
        let dir = temp_dir("save");
        let path = dir.join("config.json");
        let log = Logger::new(&crate::log::LogHub::new(), "test");

        let mut store = Store::default();
        store.roles.middle.picks = vec![101];
        save(&store, &path).unwrap();
        store.roles.middle.picks = vec![777];
        save(&store, &path).unwrap();

        let mut loaded = Store::default();
        assert_eq!(load_into(&mut loaded, &path, &log), LoadOutcome::Loaded);
        assert_eq!(loaded.roles.middle.picks, vec![777]);
        let backup: Value = read_json(&dir.join("config.bak.json")).unwrap();
        assert_eq!(backup["roles"]["middle"]["picks"], json!([101]));
        assert!(!dir.join("config.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_config_is_reported_and_kept() {
        let dir = temp_dir("broken");
        let path = dir.join("config.json");
        fs::write(&path, "{ \"roles\": ").unwrap();
        let log = Logger::new(&crate::log::LogHub::new(), "test");
        let mut store = Store::default();
        assert_eq!(load_into(&mut store, &path, &log), LoadOutcome::Unreadable);
        assert!(dir.join("config.broken.json").exists());
        assert_eq!(load_into(&mut Store::default(), &dir.join("nope.json"), &log), LoadOutcome::Missing);
        let _ = fs::remove_dir_all(&dir);
    }

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
        let p = sanitize_role_prefs(
            &json!({ "picks": [1, 1, -3, "x", 2, 3, 4, 5, 6, 7], "bans": null }),
            Role::Middle,
        );
        assert_eq!(p.picks, vec![1, 2, 3, 4, 5, 6]);
        assert!(p.bans.is_empty());

        // Random only in picks and only once.
        let p = sanitize_role_prefs(&json!({ "picks": [-1, 5, -1], "bans": [-1, 7] }), Role::Middle);
        assert_eq!(p.picks, vec![RANDOM_PICK, 5]);
        assert_eq!(p.bans, vec![7]);
    }

    #[test]
    fn sanitizes_second_role() {
        let second = |v: Value| sanitize_role_prefs(&json!({ "secondRole": v }), Role::Middle).second_role;
        assert_eq!(second(json!("top")), Position::Top);
        // Missing (older config.json), unknown or the role itself -> Fill.
        assert_eq!(second(Value::Null), Position::Fill);
        assert_eq!(second(json!("support")), Position::Fill);
        assert_eq!(second(json!("middle")), Position::Fill);
    }
}
