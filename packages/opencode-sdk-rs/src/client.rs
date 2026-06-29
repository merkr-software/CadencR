//! Minimal REST client for the OpenCode subprocess's embedded HTTP backend.
//!
//! Every `opencode acp --hostname --port` subprocess Cadencr spawns also
//! serves an HTTP backend on the same port. The ACP wire silently drops
//! sub-agent (`Task` / `Agent`) child-session events and permission
//! prompts (upstream issue sst/opencode#6573), so the
//! `upstream_workaround::subagent_listener` polls this backend for them:
//!
//! - `list_children_in_directory` — discover sub-agent child sessions.
//! - `list_messages` — tail each child's cumulative message snapshot,
//!   and pull root-session context-token totals (`opencode acp` only
//!   emits usage at turn end over the ACP wire).
//! - `list_permissions` / `reply_permission` — surface and answer
//!   sub-agent permission prompts that never reach the ACP wire.
//!
//! Surface is intentionally tiny. New methods get added only when a new
//! workaround needs them. This is **not** a general-purpose OpenCode HTTP
//! client; the legacy long-lived-server transport that used to live here
//! has been retired.

use std::path::Path;

use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::SdkError;
use crate::mcp::{list_mcp_servers_from_cli, OpenCodeMcpServerStatus};
use crate::parsing::{parse_message_from, parse_session_from};
use crate::permissions::{parse_pending_permission, PendingPermission, PermissionReply};
use crate::types::{Message, Session};

#[derive(Clone)]
pub struct OpenCodeClient {
    base_url: String,
    http: reqwest::Client,
}

impl OpenCodeClient {
    pub fn new(port: u16) -> Self {
        Self::with_base_url(format!("http://127.0.0.1:{port}"))
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Return MCP servers visible to the OpenCode CLI for the current
    /// workspace. OpenCode exposes this through `opencode mcp list`, not the
    /// embedded ACP HTTP backend.
    pub async fn available_mcp_servers(
        &self,
        cwd: Option<&Path>,
    ) -> Result<Vec<OpenCodeMcpServerStatus>, SdkError> {
        list_mcp_servers_from_cli(cwd).await
    }

    /// `GET /session/{id}/message` — cumulative message snapshot for a
    /// session. Used by both the root-usage poller (context-token totals
    /// for the root session) and the sub-agent listener (tailing
    /// child-session parts the ACP wire never delivers).
    pub async fn list_messages(&self, session_id: &str) -> Result<Vec<Message>, SdkError> {
        let response = self
            .http
            .get(format!("{}/session/{session_id}/message", self.base_url))
            .send()
            .await?;
        let body = ensure_success(response).await?;
        parse_array(body, "message", parse_message_from)
    }

    /// `GET /session/{id}/children` — direct sub-sessions of a parent.
    ///
    /// Load-bearing for the sub-agent workaround: the polling listener
    /// uses this to discover Task-spawned child sessions OpenCode never
    /// registers with the ACP wire.
    pub async fn list_children_in_directory(
        &self,
        session_id: &str,
        directory: Option<&str>,
    ) -> Result<Vec<Session>, SdkError> {
        let response = self
            .maybe_scoped_request(
                self.http
                    .get(format!("{}/session/{session_id}/children", self.base_url)),
                directory,
            )
            .send()
            .await?;
        let body = ensure_success(response).await?;
        parse_array(body, "session", parse_session_from)
    }

    pub async fn fork_session(
        &self,
        session_id: &str,
        message_id: Option<&str>,
        directory: Option<&str>,
    ) -> Result<Session, SdkError> {
        let body = message_id.map_or_else(
            || serde_json::json!({}),
            |message_id| serde_json::json!({ "messageID": message_id }),
        );
        let response = self
            .maybe_scoped_request(
                self.http
                    .post(format!("{}/session/{session_id}/fork", self.base_url))
                    .json(&body),
                directory,
            )
            .send()
            .await?;
        let body = ensure_success(response).await?;
        parse_session_from(&body)
            .ok_or_else(|| SdkError::Protocol("malformed fork session response".to_string()))
    }

    /// `GET /permission` — all currently-pending permission prompts on
    /// the embedded backend. Used by the sub-agent listener to surface
    /// permissions for child sessions (root-session permissions still
    /// flow through the ACP wire's `session/request_permission`).
    pub async fn list_permissions(
        &self,
        directory: Option<&str>,
    ) -> Result<Vec<PendingPermission>, SdkError> {
        let response = self
            .maybe_scoped_request(
                self.http.get(format!("{}/permission", self.base_url)),
                directory,
            )
            .send()
            .await?;
        let body = ensure_success(response).await?;
        parse_array(body, "permission", parse_pending_permission)
    }

    /// `POST /permission/{requestID}/reply` — answer a pending permission.
    ///
    /// `directory` is **load-bearing**: upstream's `WorkspaceRoutingMiddleware`
    /// routes this endpoint by `?directory=` / `x-opencode-directory` and
    /// silently falls back to `process.cwd()` of the OpenCode subprocess
    /// when neither is provided. The `acp` subcommand declares `--cwd` but
    /// never chdir's into it, so omitting the scope lands the reply on the
    /// wrong workspace's pending map; `Permission.reply` then hits its
    /// `if (!existing) return` no-op and the bash deferred is never
    /// resolved (sub-agent stalls indefinitely after the user approves).
    pub async fn reply_permission(
        &self,
        request_id: &str,
        reply: PermissionReply,
        directory: Option<&str>,
    ) -> Result<(), SdkError> {
        let response = self
            .maybe_scoped_request(
                self.http
                    .post(format!("{}/permission/{request_id}/reply", self.base_url))
                    .json(&serde_json::json!({ "reply": reply.wire() })),
                directory,
            )
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(SdkError::HttpStatus { status, body });
        }
        Ok(())
    }

    fn maybe_scoped_request(
        &self,
        req: reqwest::RequestBuilder,
        directory: Option<&str>,
    ) -> reqwest::RequestBuilder {
        match directory {
            Some(directory) => req
                .query(&[("directory", directory)])
                .header("x-opencode-directory", directory),
            None => req,
        }
    }
}

fn parse_array<T>(
    body: Value,
    item_name: &str,
    parse: impl Fn(&Value) -> Option<T>,
) -> Result<Vec<T>, SdkError> {
    let array = body.as_array().ok_or_else(|| {
        SdkError::Protocol(format!("expected {item_name} list response to be an array"))
    })?;
    array
        .iter()
        .enumerate()
        .map(|(index, value)| {
            parse(value).ok_or_else(|| {
                SdkError::Protocol(format!("malformed {item_name} at response index {index}"))
            })
        })
        .collect()
}

async fn ensure_success(response: reqwest::Response) -> Result<Value, SdkError> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(SdkError::HttpStatus {
            status: status.as_u16(),
            body,
        });
    }
    if body.trim().is_empty() || status == StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    deserialize_json(&body)
}

fn deserialize_json<T: DeserializeOwned>(raw: &str) -> Result<T, SdkError> {
    serde_json::from_str(raw).map_err(SdkError::from)
}

#[cfg(test)]
mod tests {
    use super::{parse_array, OpenCodeClient, PermissionReply};
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, Uri};
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct ServerState {
        body: Arc<str>,
        status: StatusCode,
        requests: Arc<Mutex<Vec<String>>>,
        replies: Arc<Mutex<Vec<(String, String)>>>,
    }

    type TestHarness = (
        OpenCodeClient,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<(String, String)>>>,
    );

    async fn test_client(body: &str, status: StatusCode) -> TestHarness {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(Vec::new()));
        let state = ServerState {
            body: Arc::from(body),
            status,
            requests: Arc::clone(&requests),
            replies: Arc::clone(&replies),
        };
        let app = Router::new()
            .route("/session/{id}/message", get(record_request))
            .route("/session/{id}/children", get(record_request))
            .route("/permission", get(record_request))
            .route("/permission/{id}/reply", post(record_reply))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (OpenCodeClient::with_base_url(base_url), requests, replies)
    }

    async fn record_request(
        State(state): State<ServerState>,
        uri: Uri,
        headers: HeaderMap,
    ) -> impl IntoResponse {
        let header = headers
            .get("x-opencode-directory")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        state
            .requests
            .lock()
            .unwrap()
            .push(format!("{uri} header={header}"));
        (state.status, state.body.to_string())
    }

    async fn record_reply(
        State(state): State<ServerState>,
        axum::extract::Path(id): axum::extract::Path<String>,
        uri: Uri,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> impl IntoResponse {
        let header = headers
            .get("x-opencode-directory")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        state
            .requests
            .lock()
            .unwrap()
            .push(format!("{uri} header={header}"));
        let reply = body
            .get("reply")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        state.replies.lock().unwrap().push((id, reply));
        (StatusCode::OK, "{}".to_string())
    }

    #[test]
    fn parse_array_rejects_non_array_and_malformed_items() {
        let error = parse_array::<()>(json!({}), "message", |_| Some(())).unwrap_err();
        assert!(error.to_string().contains("expected message list response"));
        let error = parse_array::<()>(json!([{}]), "session", |_| None).unwrap_err();
        assert!(error
            .to_string()
            .contains("malformed session at response index 0"));
        let parsed = parse_array(json!([1, 2]), "number", |value| value.as_i64()).expect("ok");
        assert_eq!(parsed, vec![1, 2]);
    }

    #[tokio::test]
    async fn list_messages_surfaces_array_and_status_errors() {
        let (client, _, _) = test_client(r#"{"not":"array"}"#, StatusCode::OK).await;
        let error = client.list_messages("ses_1").await.unwrap_err();
        assert!(error
            .to_string()
            .contains("expected message list response to be an array"));
        let (client, _, _) = test_client("[{}]", StatusCode::OK).await;
        let error = client.list_messages("ses_1").await.unwrap_err();
        assert!(error
            .to_string()
            .contains("malformed message at response index 0"));
        let (client, _, _) = test_client("bad gateway", StatusCode::BAD_GATEWAY).await;
        let error = client.list_messages("ses_1").await.unwrap_err();
        assert!(error.to_string().contains("http status 502"));
        assert!(error.to_string().contains("bad gateway"));
    }

    #[tokio::test]
    async fn list_children_sends_directory_scope_via_query_and_header() {
        let (client, requests, _) = test_client("[{}]", StatusCode::OK).await;
        let error = client
            .list_children_in_directory("ses_1", Some("/tmp/project"))
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("malformed session at response index 0"));
        let requests = requests.lock().unwrap();
        assert!(requests[0].contains("/session/ses_1/children?directory=%2Ftmp%2Fproject"));
        assert!(requests[0].contains("header=/tmp/project"));
    }

    #[tokio::test]
    async fn list_permissions_returns_parsed_entries_and_scopes_directory() {
        let body = r#"[{"id":"per_1","sessionID":"ses_child","permission":"bash",
            "metadata":{"command":"ls"},"tool":{"messageID":"msg_1","callID":"call_1"}}]"#;
        let (client, requests, _) = test_client(body, StatusCode::OK).await;
        let parsed = client
            .list_permissions(Some("/tmp/project"))
            .await
            .expect("expected list");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "per_1");
        assert_eq!(parsed[0].tool.as_deref(), Some("bash"));
        let requests = requests.lock().unwrap();
        assert!(requests[0].contains("/permission?directory=%2Ftmp%2Fproject"));
        assert!(requests[0].contains("header=/tmp/project"));
    }

    #[tokio::test]
    async fn reply_permission_posts_canonical_wire_value_with_directory_scope() {
        let (client, requests, replies) = test_client("{}", StatusCode::OK).await;
        client
            .reply_permission("per_42", PermissionReply::Always, Some("/tmp/project"))
            .await
            .expect("reply succeeds");
        assert_eq!(
            replies.lock().unwrap().clone(),
            vec![("per_42".into(), "always".into())]
        );
        // Directory MUST be on both the query string and the header, matching
        // list_permissions — otherwise OpenCode's WorkspaceRoutingMiddleware
        // falls back to process.cwd() and the reply hits the wrong pending map.
        let requests = requests.lock().unwrap();
        assert!(requests[0].contains("/permission/per_42/reply?directory=%2Ftmp%2Fproject"));
        assert!(requests[0].contains("header=/tmp/project"));
    }
}
