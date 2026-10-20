//! Wiring: Tauri app, commands for the frontend, background tasks
//! (LCU connector, event router, engine, GUI push, saving, updates).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::champions::ChampionData;
use crate::engine::{Engine, LiveLcu};
use crate::lcu::{self, LcuEvent, LcuHandle, CHAMP_SELECT_SESSION_URI, GAMEFLOW_PHASE_URI};
use crate::log::{LogHub, Logger};
use crate::model::{ChampionCatalog, LcuStatus, LogEntry, Role, UiState, RANDOM_PICK};
use crate::settings;
use crate::state::Shared;

const ACCEPT_PATH: &str = "/lol-matchmaking/v1/ready-check/accept";
const SUMMONER_PATH: &str = "/lol-summoner/v1/current-summoner";
/// Engine timer tick (champ select events don't fire continuously).
const TICK: Duration = Duration::from_millis(250);

enum EngineMsg {
    Session(Option<Value>),
    FetchInitial,
    Refresh,
}

struct AppCtx {
    shared: Arc<Shared>,
    champions: Arc<ChampionData>,
    engine_tx: UnboundedSender<EngineMsg>,
    config_path: PathBuf,
    log: Logger,
}

// --- Commands for the frontend -----------------------------------------------

#[tauri::command]
fn get_state(ctx: State<'_, AppCtx>) -> UiState {
    ctx.shared.ui_state()
}

#[tauri::command]
fn get_logs(ctx: State<'_, AppCtx>) -> Vec<LogEntry> {
    ctx.shared.log.history()
}

#[tauri::command]
fn get_champions(ctx: State<'_, AppCtx>) -> ChampionCatalog {
    ctx.champions.get()
}

#[tauri::command]
fn set_settings(patch: Value, ctx: State<'_, AppCtx>) -> UiState {
    let (before, after) = {
        let mut store = ctx.shared.store();
        let before = store.settings.language;
        settings::apply_settings(&mut store.settings, &patch);
        (before, store.settings.language)
    };
    ctx.log.info(format!("Setting changed: {patch}"));
    if before != after {
        let champions = ctx.champions.clone();
        tauri::async_runtime::spawn(async move { champions.set_language(after).await });
    }
    ctx.shared.touch_settings();
    let _ = ctx.engine_tx.send(EngineMsg::Refresh);
    ctx.shared.ui_state()
}

#[tauri::command]
fn set_role(role: Role, prefs: Value, ctx: State<'_, AppCtx>) -> UiState {
    let sanitized = settings::sanitize_role_prefs(&prefs);
    let fmt = |ids: &[i64]| -> String {
        let names: Vec<String> = ids
            .iter()
            .map(|id| if *id == RANDOM_PICK { "Random".to_string() } else { ctx.champions.name(*id) })
            .collect();
        if names.is_empty() { "-".into() } else { names.join(", ") }
    };
    ctx.log.info(format!(
        "Role {}: picks [{}], bans [{}]",
        role.key(),
        fmt(&sanitized.picks),
        fmt(&sanitized.bans)
    ));
    *ctx.shared.store().roles.get_mut(role) = sanitized;
    ctx.shared.touch_settings();
    let _ = ctx.engine_tx.send(EngineMsg::Refresh);
    ctx.shared.ui_state()
}

/// Download the update, verify its signature and install it. On Windows the updater quits
/// the app and runs the NSIS installer (passive), which restarts it afterwards.
#[tauri::command]
async fn install_update(app: AppHandle, ctx: State<'_, AppCtx>) -> Result<(), String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Err("No update available.".into()) };
    ctx.log.info(format!("Installing update {}...", update.version));
    // The updater quits via process::exit -> no RunEvent::Exit, so save first.
    flush_settings(&ctx.shared, &ctx.config_path, &ctx.log);
    if let Err(err) = update.download_and_install(|_, _| {}, || {}).await {
        ctx.log.error(format!("Update failed: {err}"));
        return Err(err.to_string());
    }
    app.restart()
}

// --- Background tasks ---------------------------------------------------------

/// Debounced GUI push on every state change.
async fn push_state(app: AppHandle, shared: Arc<Shared>) {
    loop {
        shared.ui_changed.notified().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        let _ = app.emit("state", shared.ui_state());
    }
}

/// Writes the settings - but only if they changed during this session.
fn flush_settings(shared: &Shared, path: &std::path::Path, log: &Logger) {
    if !shared.take_settings_dirty() {
        return;
    }
    if let Err(err) = settings::save(&shared.store(), path) {
        log.error(format!("Saving config.json failed: {err}"));
    }
}

/// Debounced saving of settings (plus a flush on exit).
async fn persist(shared: Arc<Shared>, path: PathBuf, log: Logger) {
    loop {
        shared.settings_changed.notified().await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        flush_settings(&shared, &path, &log);
    }
}

/// Engine task: processes session events strictly in order + timer tick.
async fn run_engine(mut engine: Engine<LiveLcu>, mut rx: UnboundedReceiver<EngineMsg>) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(EngineMsg::Session(data)) => engine.on_session(data).await,
                Some(EngineMsg::FetchInitial) => engine.fetch_initial().await,
                Some(EngineMsg::Refresh) => engine.refresh().await,
                None => break,
            },
            _ = tick.tick() => engine.tick().await,
        }
    }
}

/// Routes LCU events: connection status, gameflow phase (+ auto-accept), champ select.
async fn route_events(
    mut rx: UnboundedReceiver<LcuEvent>,
    handle: LcuHandle,
    shared: Arc<Shared>,
    champions: Arc<ChampionData>,
    engine_tx: UnboundedSender<EngineMsg>,
    hub: Arc<LogHub>,
) {
    let flow_log = Logger::new(&hub, "gameflow");
    let accept_log = Logger::new(&hub, "accept");
    let lcu_log = Logger::new(&hub, "lcu");
    let summoner_log = Logger::new(&hub, "summoner");

    while let Some(event) = rx.recv().await {
        match event {
            LcuEvent::Connected => {
                shared.store().lcu = LcuStatus::Connected;
                shared.touch();
                let _ = engine_tx.send(EngineMsg::FetchInitial);
                if let Some(client) = handle.get() {
                    let champions = champions.clone();
                    let fallback_client = client.clone();
                    tauri::async_runtime::spawn(async move { champions.fill_from_lcu(&fallback_client).await });
                    tauri::async_runtime::spawn(fetch_summoner(client, shared.clone(), summoner_log.clone()));
                }
            }
            LcuEvent::Subscribed => lcu_log.info("Event stream subscribed (OnJsonApiEvent)."),
            LcuEvent::Disconnected => {
                {
                    let mut store = shared.store();
                    store.lcu = LcuStatus::Searching;
                    store.phase = None;
                    store.summoner_riot_id = None;
                }
                shared.touch();
                let _ = engine_tx.send(EngineMsg::Session(None));
            }
            LcuEvent::Api { uri, event_type, data } => {
                if uri == GAMEFLOW_PHASE_URI {
                    let Some(phase) = data.as_str() else { continue };
                    let previous = {
                        let mut store = shared.store();
                        if store.phase.as_deref() == Some(phase) {
                            continue;
                        }
                        store.phase.replace(phase.to_string())
                    };
                    flow_log.event(format!("Gameflow phase: {} -> {phase}", previous.as_deref().unwrap_or("-")));
                    shared.touch();
                    if phase == "ReadyCheck" {
                        tauri::async_runtime::spawn(auto_accept(handle.clone(), shared.clone(), accept_log.clone()));
                    }
                } else if uri == CHAMP_SELECT_SESSION_URI {
                    let data = if event_type == "Delete" { None } else { Some(data) };
                    let _ = engine_tx.send(EngineMsg::Session(data));
                }
            }
        }
    }
}

/// Check for a newer version on start (GitHub Releases, `latest.json`). Errors (offline,
/// no release yet) only go to the log - the GUI then simply shows nothing.
async fn check_update(app: AppHandle, shared: Arc<Shared>, log: Logger) {
    let result = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };
    match result {
        Ok(Some(update)) => {
            log.info(format!("Update available: {} -> {}.", shared.version, update.version));
            shared.store().update = Some(update.version);
            shared.touch();
        }
        Ok(None) => {}
        Err(err) => log.info(format!("Update check failed: {err}")),
    }
}

/// Accept the ready check, gated by the master AND the auto-accept switch.
async fn auto_accept(handle: LcuHandle, shared: Arc<Shared>, log: Logger) {
    let (master, accept) = {
        let s = &shared.store().settings;
        (s.master_enabled, s.auto_accept)
    };
    if !master {
        log.info("Ready check - Draftpilot is paused, ignoring.");
        return;
    }
    if !accept {
        log.info("Ready check - auto-accept is off, ignoring.");
        return;
    }
    let Some(client) = handle.get() else { return };
    match client.post(ACCEPT_PATH).await {
        Ok((status, _)) if status < 400 => log.event("Match accepted."),
        Ok((status, _)) => log.warn(format!("Accepting the ready check failed (HTTP {status}).")),
        Err(err) => log.error(format!("Accept failed: {err}")),
    }
}

/// Fetch the logged-in summoner for display. Right after connecting the LCU often answers
/// 404 ("not ready yet") -> retry.
async fn fetch_summoner(client: lcu::LcuClient, shared: Arc<Shared>, log: Logger) {
    for _ in 0..15 {
        if let Ok((200, data)) = client.get(SUMMONER_PATH).await {
            let name = data
                .get("gameName")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| data.get("displayName").and_then(Value::as_str))
                .unwrap_or("");
            if !name.is_empty() {
                let tag = data.get("tagLine").and_then(Value::as_str).unwrap_or("");
                let riot_id = if tag.is_empty() { name.to_string() } else { format!("{name}#{tag}") };
                log.info(format!("Logged in as {riot_id}."));
                shared.store().summoner_riot_id = Some(riot_id);
                shared.touch();
                return;
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

// --- Start -------------------------------------------------------------------

pub fn run() {
    let app = tauri::Builder::default()
        // Single instance (otherwise two engines fight over one client): a second one focuses the first.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_logs,
            get_champions,
            set_settings,
            set_role,
            install_update
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let hub = LogHub::new();
            {
                let handle = handle.clone();
                hub.set_sink(Box::new(move |entry| {
                    let _ = handle.emit("log", entry);
                }));
            }

            // Same location as the Electron version: %APPDATA%\Draftpilot. Test instances get their
            // own folder via DRAFTPILOT_DATA_DIR (otherwise they share config.json with the
            // real app).
            let data_dir = match std::env::var_os("DRAFTPILOT_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => app.path().data_dir()?.join("Draftpilot"),
            };
            let config_path = data_dir.join("config.json");
            let shared = Shared::new(hub.clone(), app.package_info().version.to_string());
            settings::load_into(&mut shared.store(), &config_path, &Logger::new(&hub, "config"));

            let language = shared.store().settings.language;
            let champions = {
                let handle = handle.clone();
                Arc::new(ChampionData::new(
                    data_dir.clone(),
                    language,
                    Logger::new(&hub, "champions"),
                    Box::new(move |catalog| {
                        let _ = handle.emit("champions", catalog);
                    }),
                ))
            };

            let lcu_handle = LcuHandle::default();
            let (engine_tx, engine_rx) = unbounded_channel();
            let (event_tx, event_rx) = unbounded_channel();
            let engine = {
                let champions = champions.clone();
                Engine::new(
                    LiveLcu(lcu_handle.clone()),
                    shared.clone(),
                    Logger::new(&hub, "champselect"),
                    Arc::new(move |id| champions.name(id)),
                )
            };

            use tauri::async_runtime::spawn;
            spawn(push_state(handle.clone(), shared.clone()));
            spawn(persist(shared.clone(), config_path.clone(), Logger::new(&hub, "config")));
            spawn(run_engine(engine, engine_rx));
            spawn(route_events(
                event_rx,
                lcu_handle.clone(),
                shared.clone(),
                champions.clone(),
                engine_tx.clone(),
                hub.clone(),
            ));
            spawn(lcu::run_connector(lcu_handle, event_tx, Logger::new(&hub, "lcu")));
            {
                let champions = champions.clone();
                spawn(async move { champions.refresh().await });
            }
            // Dev builds don't check for updates.
            if !cfg!(debug_assertions) {
                spawn(check_update(handle.clone(), shared.clone(), Logger::new(&hub, "update")));
            }

            // The window starts hidden and the frontend shows it after the first render (no white
            // flash). Safety net in case the frontend hangs.
            {
                let handle = handle.clone();
                spawn(async move {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    if let Some(win) = handle.get_webview_window("main") {
                        if !win.is_visible().unwrap_or(true) {
                            let _ = win.show();
                        }
                    }
                });
            }

            app.manage(AppCtx { shared, champions, engine_tx, config_path, log: Logger::new(&hub, "app") });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Draftpilot");

    app.run(|handle, event| {
        // On exit, write pending changes right away (only if there are any).
        if let RunEvent::Exit = event {
            if let Some(ctx) = handle.try_state::<AppCtx>() {
                flush_settings(&ctx.shared, &ctx.config_path, &ctx.log);
            }
        }
    });
}
