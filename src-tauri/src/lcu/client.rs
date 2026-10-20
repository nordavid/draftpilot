//! Lean HTTPS client for the LCU. The client uses a self-signed certificate ->
//! certificate and hostname checks are off (127.0.0.1 only).

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use super::creds::Credentials;

#[derive(Clone)]
pub struct LcuClient {
    http: reqwest::Client,
    base: String,
    auth: String,
}

impl LcuClient {
    pub fn new(creds: &Credentials) -> Result<LcuClient, String> {
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(LcuClient { http, base: creds.base_url(), auth: creds.auth_header() })
    }

    /// Runs a request; returns the HTTP status and the JSON body (if any).
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .header("Authorization", &self.auth)
            .header("Accept", "application/json");
        if let Some(body) = body {
            req = req.json(&body);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let data = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        Ok((status, data))
    }

    pub async fn get(&self, path: &str) -> Result<(u16, Value), String> {
        self.request(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str) -> Result<(u16, Value), String> {
        self.request(Method::POST, path, None).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> Result<(u16, Value), String> {
        self.request(Method::PATCH, path, Some(body)).await
    }
}
