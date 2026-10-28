//! "Find match": opens a Ranked Solo/Duo lobby with the tab's role as first and that role's
//! saved second role as second position preference, then starts matchmaking. A manual
//! action (button) -> it runs even while Draftpilot is paused.

use std::future::Future;
use std::time::Duration;

use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};

use crate::lcu::LcuClient;
use crate::log::Logger;
use crate::model::{Position, Role};

pub const RANKED_SOLO_DUO: i64 = 420;
const LOBBY_PATH: &str = "/lol-lobby/v2/lobby";
const POSITIONS_PATH: &str = "/lol-lobby/v2/lobby/members/localMember/position-preferences";
const SEARCH_PATH: &str = "/lol-lobby/v2/lobby/matchmaking/search";
const SEARCH_STATE_PATH: &str = "/lol-lobby/v2/lobby/matchmaking/search-state";
/// Phases from which a lobby can be opened: home, lobby, post game.
pub const IDLE_PHASES: [&str; 3] = ["None", "Lobby", "EndOfGame"];
/// Right after creating a lobby the client may briefly refuse follow-up calls -> retry.
const ATTEMPTS: u32 = 3;
const RETRY: Duration = Duration::from_millis(300);

/// LCU access (abstracted for tests).
pub trait LobbyApi: Sync {
    fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> impl Future<Output = Result<(u16, Value), String>> + Send;
}

impl LobbyApi for LcuClient {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
        self.request(method, path, body).await
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QueueOutcome {
    /// Matchmaking started.
    Searching,
    /// Someone else's Solo/Duo lobby: roles set, the party leader starts the queue.
    RolesSet,
}

/// Error codes for the GUI; details go to the log.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QueueError {
    /// No League client connected.
    Offline,
    /// In queue, champ select or game.
    Busy,
    /// Party lobby of another queue: only the leader can switch it.
    NotLeader,
    /// The client refused (lobby, roles or search).
    Failed,
}

pub async fn find_match(
    api: &impl LobbyApi,
    phase: Option<&str>,
    role: Role,
    second: Position,
    log: &Logger,
) -> Result<QueueOutcome, QueueError> {
    let Some(first) = role.lcu_position() else { return Err(QueueError::Failed) };
    if !phase.is_some_and(|p| IDLE_PHASES.contains(&p)) {
        log.info(format!("Find match: not possible right now (phase {}).", phase.unwrap_or("-")));
        return Err(QueueError::Busy);
    }

    // 404 = no lobby yet -> we open one and are its leader.
    let lobby = match api.call(Method::GET, LOBBY_PATH, None).await {
        Ok((200, lobby)) => lobby,
        _ => Value::Null,
    };
    let queue = lobby.pointer("/gameConfig/queueId").and_then(Value::as_i64);
    let leader = lobby.pointer("/localMember/isLeader").and_then(Value::as_bool).unwrap_or(true);
    if queue != Some(RANKED_SOLO_DUO) {
        if !leader {
            log.warn("Find match: only the party leader can switch the lobby to Ranked Solo/Duo.");
            return Err(QueueError::NotLeader);
        }
        let body = json!({ "queueId": RANKED_SOLO_DUO });
        expect_ok(api, Method::POST, LOBBY_PATH, Some(body), log, "Opening the Solo/Duo lobby").await?;
    }

    let roles = json!({ "firstPreference": first, "secondPreference": second.lcu() });
    expect_ok(api, Method::PUT, POSITIONS_PATH, Some(roles), log, "Setting the roles").await?;
    if !leader {
        log.info(format!("Find match: roles set ({first} / {}), the party leader starts the queue.", second.lcu()));
        return Ok(QueueOutcome::RolesSet);
    }

    expect_ok(api, Method::POST, SEARCH_PATH, None, log, "Starting the queue").await?;
    // The client may take the request and still not search (dodge timer, leaver penalty).
    if let Ok((200, state)) = api.call(Method::GET, SEARCH_STATE_PATH, None).await {
        if let Some(err) = state.get("errors").and_then(Value::as_array).and_then(|e| e.first()) {
            log.warn(format!("Queue refused by the client: {err}"));
            return Err(QueueError::Failed);
        }
    }
    log.event(format!("Queueing Ranked Solo/Duo as {first} / {}.", second.lcu()));
    Ok(QueueOutcome::Searching)
}

pub async fn cancel_search(api: &impl LobbyApi, log: &Logger) -> Result<(), QueueError> {
    expect_ok(api, Method::DELETE, SEARCH_PATH, None, log, "Cancelling the queue").await?;
    log.info("Queue cancelled.");
    Ok(())
}

/// Runs a request (with retries); a final HTTP error becomes a log line + `Failed`.
async fn expect_ok(
    api: &impl LobbyApi,
    method: Method,
    path: &str,
    body: Option<Value>,
    log: &Logger,
    what: &str,
) -> Result<(), QueueError> {
    let mut last = String::new();
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(RETRY).await;
        }
        match api.call(method.clone(), path, body.clone()).await {
            Ok((status, _)) if status < 400 => return Ok(()),
            Ok((status, data)) => {
                let message = data.get("message").and_then(Value::as_str).unwrap_or("");
                last = format!("HTTP {status} {message}");
            }
            Err(err) => last = err,
        }
    }
    log.warn(format!("{what} failed: {}", last.trim_end()));
    Err(QueueError::Failed)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::log::LogHub;

    /// Lobby endpoints of a fake client; records every call.
    #[derive(Default)]
    struct FakeLobby {
        /// GET lobby response (None = 404, no lobby).
        lobby: Option<Value>,
        /// Paths that answer HTTP 400.
        fail: Vec<&'static str>,
        search_errors: Vec<Value>,
        calls: Mutex<Vec<(Method, String, Option<Value>)>>,
    }

    impl LobbyApi for FakeLobby {
        async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
            self.calls.lock().unwrap().push((method.clone(), path.to_string(), body));
            if self.fail.contains(&path) {
                return Ok((400, json!({ "message": "refused" })));
            }
            if method == Method::GET && path == LOBBY_PATH {
                return Ok(match &self.lobby {
                    Some(lobby) => (200, lobby.clone()),
                    None => (404, Value::Null),
                });
            }
            if method == Method::GET && path == SEARCH_STATE_PATH {
                return Ok((200, json!({ "errors": self.search_errors })));
            }
            Ok((204, Value::Null))
        }
    }

    impl FakeLobby {
        /// Write calls as "METHOD path".
        fn writes(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _, _)| *m != Method::GET)
                .map(|(m, p, _)| format!("{m} {p}"))
                .collect()
        }

        fn body(&self, path: &str) -> Option<Value> {
            self.calls.lock().unwrap().iter().find(|(m, p, _)| *m != Method::GET && p == path)?.2.clone()
        }
    }

    fn lobby(queue: i64, leader: bool) -> Value {
        json!({ "gameConfig": { "queueId": queue }, "localMember": { "isLeader": leader } })
    }

    fn log() -> Logger {
        Logger::new(&LogHub::new(), "test")
    }

    async fn run(api: &FakeLobby, phase: &str) -> Result<QueueOutcome, QueueError> {
        find_match(api, Some(phase), Role::Middle, Position::Top, &log()).await
    }

    #[tokio::test]
    async fn opens_lobby_sets_roles_and_queues() {
        let api = FakeLobby::default();
        assert_eq!(run(&api, "None").await, Ok(QueueOutcome::Searching));
        assert_eq!(
            api.writes(),
            [
                format!("POST {LOBBY_PATH}"),
                format!("PUT {POSITIONS_PATH}"),
                format!("POST {SEARCH_PATH}")
            ]
        );
        assert_eq!(api.body(LOBBY_PATH), Some(json!({ "queueId": 420 })));
        assert_eq!(
            api.body(POSITIONS_PATH),
            Some(json!({ "firstPreference": "MIDDLE", "secondPreference": "TOP" }))
        );
    }

    #[tokio::test]
    async fn keeps_an_existing_solo_duo_lobby() {
        let api = FakeLobby { lobby: Some(lobby(RANKED_SOLO_DUO, true)), ..Default::default() };
        assert_eq!(run(&api, "Lobby").await, Ok(QueueOutcome::Searching));
        assert_eq!(api.writes(), [format!("PUT {POSITIONS_PATH}"), format!("POST {SEARCH_PATH}")]);
    }

    #[tokio::test]
    async fn switches_another_queue_as_leader() {
        let api = FakeLobby { lobby: Some(lobby(400, true)), ..Default::default() };
        assert_eq!(run(&api, "Lobby").await, Ok(QueueOutcome::Searching));
        assert_eq!(api.writes()[0], format!("POST {LOBBY_PATH}"));
    }

    #[tokio::test]
    async fn party_member_only_sets_roles() {
        let api = FakeLobby { lobby: Some(lobby(RANKED_SOLO_DUO, false)), ..Default::default() };
        assert_eq!(run(&api, "Lobby").await, Ok(QueueOutcome::RolesSet));
        assert_eq!(api.writes(), [format!("PUT {POSITIONS_PATH}")]);

        // Another queue: the member can't switch it -> nothing is written.
        let api = FakeLobby { lobby: Some(lobby(440, false)), ..Default::default() };
        assert_eq!(run(&api, "Lobby").await, Err(QueueError::NotLeader));
        assert!(api.writes().is_empty());
    }

    #[tokio::test]
    async fn does_nothing_outside_idle_phases() {
        for phase in ["Matchmaking", "ReadyCheck", "ChampSelect", "InProgress"] {
            let api = FakeLobby::default();
            assert_eq!(run(&api, phase).await, Err(QueueError::Busy));
            assert!(api.calls.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn reports_a_refused_search() {
        let api = FakeLobby { fail: vec![SEARCH_PATH], ..Default::default() };
        assert_eq!(run(&api, "None").await, Err(QueueError::Failed));

        // Accepted, but the client won't search (e.g. dodge timer).
        let api = FakeLobby { search_errors: vec![json!({ "errorType": "QUEUE_DODGER" })], ..Default::default() };
        assert_eq!(run(&api, "None").await, Err(QueueError::Failed));
    }
}
