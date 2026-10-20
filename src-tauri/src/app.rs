//! Verdrahtung: Tauri-App, Befehle fuer das Frontend, Hintergrund-Tasks
//! (LCU-Connector, Event-Router, Engine, GUI-Push, Speichern).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
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
/// Timer-Tick der Engine (Champ-Select-Events feuern nicht kontinuierlich).
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

// --- Befehle fuer das Frontend -----------------------------------------------

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

// --- Hintergrund-Tasks ---------------------------------------------------------

/// Entprellter GUI-Push bei jeder Zustandsaenderung.
async fn push_state(app: AppHandle, shared: Arc<Shared>) {
    loop {
        shared.ui_changed.notified().await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        let _ = app.emit("state", shared.ui_state());
    }
}

/// Entprelltes Speichern der Einstellungen (zusaetzlich Flush beim Beenden).
async fn persist(shared: Arc<Shared>, path: PathBuf) {
    loop {
        shared.settings_changed.notified().await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        settings::save(&shared.store(), &path);
    }
}

/// Engine-Task: verarbeitet Session-Events strikt nacheinander + Timer-Tick.
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

/// Verteilt LCU-Events: Verbindungsstatus, Gameflow-Phase (+ Auto-Accept), Champ Select.
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

/// Ready-Check annehmen, gated durch Master- UND Auto-Accept-Schalter.
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

/// Eingeloggten Summoner fuer die Anzeige holen. Direkt nach dem Connect antwortet die
/// LCU oft mit 404 ("noch nicht bereit") -> mit Retry.
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
        // Nur eine Instanz (sonst zwei Engines gegen denselben Client): zweite fokussiert die erste.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![get_state, get_logs, get_champions, set_settings, set_role])
        .setup(|app| {
            let handle = app.handle().clone();
            let hub = LogHub::new();
            {
                let handle = handle.clone();
                hub.set_sink(Box::new(move |entry| {
                    let _ = handle.emit("log", entry);
                }));
            }

            // Gleicher Ort wie die Electron-Version: %APPDATA%\Draftpilot
            let data_dir = app.path().data_dir()?.join("Draftpilot");
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
            spawn(persist(shared.clone(), config_path.clone()));
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

            // Das Fenster startet unsichtbar und wird vom Frontend nach dem ersten Rendern
            // gezeigt (kein weisser Blitz). Sicherheitsnetz, falls das Frontend haengt.
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
        // Beim Beenden ausstehende Aenderungen sofort schreiben.
        if let RunEvent::Exit = event {
            if let Some(ctx) = handle.try_state::<AppCtx>() {
                settings::save(&ctx.shared.store(), &ctx.config_path);
            }
        }
    });
}
