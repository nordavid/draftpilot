//! LCU event stream: WAMP over WebSocket. After connecting, send `[5, "OnJsonApiEvent"]`;
//! events arrive as `[8, "OnJsonApiEvent", { uri, eventType, data }]`.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

use super::creds::Credentials;
use super::LcuEvent;

/// Connects, subscribes to all JSON API events and forwards them until the connection
/// ends. Returns when the connection ends (Ok) or fails to connect (Err).
pub async fn run(creds: &Credentials, tx: &UnboundedSender<LcuEvent>) -> Result<(), String> {
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = creds.ws_url().into_client_request().map_err(|e| e.to_string())?;
    let auth = HeaderValue::from_str(&creds.auth_header()).map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", auth);

    let (mut ws, _) = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(Connector::NativeTls(tls)),
    )
    .await
    .map_err(|e| e.to_string())?;

    ws.send(Message::Text(r#"[5, "OnJsonApiEvent"]"#.into()))
        .await
        .map_err(|e| e.to_string())?;
    let _ = tx.send(LcuEvent::Subscribed);

    while let Some(msg) = ws.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let Ok(Value::Array(frame)) = serde_json::from_str::<Value>(&text) else { continue };
        // Event frames only: [8, "OnJsonApiEvent", payload]
        if frame.first().and_then(Value::as_i64) != Some(8) {
            continue;
        }
        let Some(payload) = frame.get(2) else { continue };
        let Some(uri) = payload.get("uri").and_then(Value::as_str) else { continue };
        let _ = tx.send(LcuEvent::Api {
            uri: uri.to_string(),
            event_type: payload.get("eventType").and_then(Value::as_str).unwrap_or("").to_string(),
            data: payload.get("data").cloned().unwrap_or(Value::Null),
        });
    }
    Ok(())
}
