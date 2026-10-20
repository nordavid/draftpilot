//! LCU connection: find credentials, build the HTTPS client, open the event stream,
//! forward events, reconnect when the client restarts.

pub mod client;
pub mod creds;
pub mod stream;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::log::Logger;
pub use client::LcuClient;

pub const GAMEFLOW_PHASE_URI: &str = "/lol-gameflow/v1/gameflow-phase";
pub const CHAMP_SELECT_SESSION_URI: &str = "/lol-champ-select/v1/session";

const POLL: Duration = Duration::from_secs(4); // look for a running client
const RECONNECT: Duration = Duration::from_secs(2); // after the connection drops

pub enum LcuEvent {
    Connected,
    Subscribed,
    Disconnected,
    Api { uri: String, event_type: String, data: Value },
}

/// HTTP client of the active connection (None while no client is connected).
#[derive(Clone, Default)]
pub struct LcuHandle(Arc<RwLock<Option<LcuClient>>>);

impl LcuHandle {
    pub fn get(&self) -> Option<LcuClient> {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, client: Option<LcuClient>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = client;
    }
}

/// Endless loop: connect, stream events, reconnect when the connection drops.
pub async fn run_connector(handle: LcuHandle, tx: UnboundedSender<LcuEvent>, log: Logger) {
    log.info("LCU connector started - looking for the League client...");
    let mut announced_searching = false;
    loop {
        let creds = tokio::task::spawn_blocking(creds::discover).await.ok().flatten();
        let Some(creds) = creds else {
            if !announced_searching {
                log.warn("No League client found - waiting (is it running?)...");
                announced_searching = true;
            }
            tokio::time::sleep(POLL).await;
            continue;
        };

        // Verify the connection and fetch the initial phase.
        let Ok(client) = LcuClient::new(&creds) else {
            tokio::time::sleep(POLL).await;
            continue;
        };
        let phase = match client.get(GAMEFLOW_PHASE_URI).await {
            Ok((200, phase)) => phase,
            // The client may still be starting -> wait briefly, retry.
            _ => {
                tokio::time::sleep(POLL).await;
                continue;
            }
        };

        announced_searching = false;
        log.info(format!("LCU connected (port {}, source: {}).", creds.port, creds.source));
        handle.set(Some(client));
        let _ = tx.send(LcuEvent::Connected);
        // Initial phase as a synthetic event so the current state is known.
        let _ = tx.send(LcuEvent::Api {
            uri: GAMEFLOW_PHASE_URI.to_string(),
            event_type: "Update".to_string(),
            data: phase,
        });

        if let Err(err) = stream::run(&creds, &tx).await {
            log.warn(format!("Event stream error: {err}"));
        }

        log.warn("LCU connection lost - reconnecting...");
        handle.set(None);
        let _ = tx.send(LcuEvent::Disconnected);
        tokio::time::sleep(RECONNECT).await;
    }
}
