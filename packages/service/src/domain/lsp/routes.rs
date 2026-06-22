//! HTTP + WebSocket routes for the LSP host.
//!
//! - `POST /api/lsp/sessions` — reserve a session for `(workspace, language)`
//!   and get back an opaque id. utoipa-annotated so the generated TS client
//!   gets a typed hook.
//! - `GET  /api/lsp/sessions/:session_id/connect` — WebSocket upgrade. Same
//!   origin + subprotocol-token auth as the existing `/ws` route; not
//!   utoipa-annotated, matching the existing `/ws` convention.

use std::path::PathBuf;

use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::api::middleware::authenticate_ws;
use crate::app_state::AppState;
use crate::error::AppError;
use crate::remote::RemoteContext;

use super::lifecycle::CrashKey;
use super::probe::{probe_servers, ServerProbe};
use super::proxy::run_proxy;
use super::registry::SessionSpec;
use super::root::lsp_root_handler;
use super::spawn::{resolve_server, resolve_server_by_id, spawn_server};

pub fn lsp_router() -> Router<AppState> {
    Router::new()
        .route("/api/lsp/sessions", post(open_session_handler))
        .route(
            "/api/lsp/sessions/{session_id}/connect",
            get(connect_handler),
        )
        .route("/api/lsp/servers", get(list_servers_handler))
        .route("/api/lsp/root", get(lsp_root_handler))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ListServersResponse {
    pub servers: Vec<ServerProbe>,
}

/// Inspect the LSP catalog and report each entry's installation state.
/// Used by Settings → Editor; never triggers a download.
#[utoipa::path(
    get,
    path = "/api/lsp/servers",
    responses(
        (status = 200, body = ListServersResponse),
    )
)]
pub async fn list_servers_handler() -> Json<ListServersResponse> {
    Json(ListServersResponse {
        servers: probe_servers().await,
    })
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct OpenLspSessionRequest {
    /// Absolute path to the workspace root the language server should index.
    pub workspace_root: String,
    /// LSP `TextDocumentItem` language id (e.g. `"typescript"`, `"rust"`,
    /// `"python"`). The renderer derives this from the same catalog the
    /// service uses; see `domain/lsp/spawn.rs::resolve_server`.
    pub language_id: String,
    /// Optional concrete server id (e.g. `"tsgo"`, `"biome"`). When present the
    /// service resolves that specific catalog entry instead of the language's
    /// default — this is how a project runs multiple servers per file. When
    /// absent, behavior is unchanged (default server for the language).
    #[serde(default)]
    pub lsp_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OpenLspSessionResponse {
    /// Opaque single-use id. Connect within 30 s by upgrading
    /// `GET /api/lsp/sessions/{session_id}/connect` to WebSocket.
    pub session_id: String,
}

#[utoipa::path(
    post,
    path = "/api/lsp/sessions",
    request_body = OpenLspSessionRequest,
    responses(
        (status = 200, body = OpenLspSessionResponse),
        (status = 400, description = "Unknown language id or invalid workspace path"),
        (status = 503, description = "Language server crashing; Retry-After header set"),
    )
)]
pub async fn open_session_handler(
    State(state): State<AppState>,
    Json(req): Json<OpenLspSessionRequest>,
) -> Result<Response, AppError> {
    if req.language_id.is_empty() {
        return Err(AppError::BadRequest("language_id is required".into()));
    }
    let workspace_root = PathBuf::from(&req.workspace_root);
    if !workspace_root.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "workspace_root must be absolute, got {:?}",
            req.workspace_root
        )));
    }

    // Crash backoff at reservation time, not just at WS upgrade: a non-101 WS
    // status is invisible to the browser (bare `error` event, no body), so we
    // surface "unhealthy, retry in N s" here where we can both return JSON AND
    // set a machine-readable `Retry-After`. The renderer's auto-reconnect loop
    // reads that header to pace its backoff instead of hammering a dead server.
    //
    // The crash key's `language_id` field doubles as the per-server backoff
    // discriminator: when a concrete `lsp_id` was requested we key on it so a
    // crashing linter doesn't lock out the type checker for the same file.
    let crash_discriminator = req
        .lsp_id
        .clone()
        .unwrap_or_else(|| req.language_id.clone());
    let crash_key = CrashKey {
        workspace_root: workspace_root.clone(),
        language_id: crash_discriminator,
    };
    if let Err(remaining) = state.lsp_crashes.check(&crash_key).await {
        let secs = remaining.as_secs().max(1);
        return Ok(retry_after_response(secs, &req.language_id));
    }

    // Do the full binary discovery (and, if necessary, the on-demand
    // download) at reservation time. The WS upgrade later can't surface
    // an informative error to the browser — a non-101 status appears as a
    // bare `error` event with no body — so we have to fail visibly here
    // while we can still return JSON. Renderer reads `.error` and toasts.
    let server = match &req.lsp_id {
        Some(lsp_id) => resolve_server_by_id(lsp_id).await?,
        None => resolve_server(&req.language_id).await?,
    };
    let session_id = state
        .lsp_sessions
        .reserve(SessionSpec {
            workspace_root,
            // Keep the crash discriminator consistent between reserve and
            // connect so the WS-side backoff check matches the POST-side one.
            language_id: crash_key.language_id.clone(),
            server,
        })
        .await;
    Ok(Json(OpenLspSessionResponse { session_id }).into_response())
}

/// Build a 503 carrying both a JSON error (for the toast) and a `Retry-After`
/// header in seconds (for the reconnect loop's backoff pacing).
fn retry_after_response(secs: u64, language_id: &str) -> Response {
    let body = serde_json::json!({
        "error": format!("language server for {language_id:?} crashed recently; retry in {secs}s"),
        "code": "SERVICE_UNAVAILABLE",
    });
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(axum::http::header::RETRY_AFTER, secs.to_string())],
        Json(body),
    )
        .into_response()
}

pub async fn connect_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    // Present only on the remote listener; its absence means loopback.
    remote: Option<Extension<RemoteContext>>,
) -> Response {
    let (selected_proto, device_id) =
        match authenticate_ws(&headers, &state, remote.as_ref().map(|e| &e.0)).await {
            Ok(resolved) => resolved,
            Err(resp) => return resp,
        };

    // Claim the reservation BEFORE the upgrade, so an invalid id returns 404
    // rather than completing the handshake and immediately closing — the
    // renderer can show a useful error.
    let spec = match state.lsp_sessions.claim(&session_id).await {
        Ok(spec) => spec,
        Err(err) => return err.into_response(),
    };

    // Crash backoff: if this `(workspace, language)` has been crashing,
    // reject the upgrade with 503 and a Retry-After hint so the renderer
    // can surface "language server is unhealthy; try again in N s".
    let crash_key = CrashKey {
        workspace_root: spec.workspace_root.clone(),
        language_id: spec.language_id.clone(),
    };
    if let Err(remaining) = state.lsp_crashes.check(&crash_key).await {
        let secs = remaining.as_secs().max(1);
        return AppError::ServiceUnavailable(format!(
            "language server crashed recently; retry in {secs}s"
        ))
        .into_response();
    }

    // Binary was already resolved (and downloaded if needed) at POST time;
    // here we just spawn it. If the binary went missing between POST and
    // WS upgrade (unlikely — < 30s window) the spawn returns Internal.
    let child = match spawn_server(&spec.server, &spec.workspace_root) {
        Ok(c) => c,
        Err(err) => {
            state.lsp_crashes.record_crash(crash_key).await;
            return err.into_response();
        }
    };

    let ws = ws.protocols([selected_proto]);
    let display_name = spec.server.display_name.clone();
    let crash_tracker = state.lsp_crashes.clone();
    let live = state.remote.live();
    ws.on_upgrade(move |socket| async move {
        match device_id {
            // Remote session: race the proxy against the device's cancel token so
            // revoking the device force-closes the LSP socket immediately, like
            // the agent and terminal sockets.
            Some(id) => {
                // Secondary socket for an already-paired device; the "connected"
                // event is the main WS's job, so ignore the first-socket flag.
                let (guard, _) = live.register(id);
                tokio::select! {
                    _ = run_proxy(socket, child, &display_name, crash_tracker, crash_key) => {}
                    _ = guard.token.cancelled() => {
                        tracing::debug!(device_id = id, "remote LSP force-closed (device revoked)");
                    }
                }
            }
            None => run_proxy(socket, child, &display_name, crash_tracker, crash_key).await,
        }
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request as HttpRequest, StatusCode};
    use tower::ServiceExt;

    async fn app() -> Router {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("pool");
        let mut state = AppState::with_pool(pool);
        state.auth_token = "test-token".into();
        state.port = 5005;
        lsp_router().with_state(state)
    }

    fn post_open(body: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("POST")
            .uri("/api/lsp/sessions")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn open_rejects_relative_workspace() {
        let body = r#"{"workspace_root":"relative/path","language_id":"typescript"}"#;
        let resp = app().await.oneshot(post_open(body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn open_rejects_unknown_language() {
        let body = r#"{"workspace_root":"/tmp","language_id":"brainfuck"}"#;
        let resp = app().await.oneshot(post_open(body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn open_returns_session_id_or_404_for_known_language() {
        let body = r#"{"workspace_root":"/tmp","language_id":"go"}"#;
        let resp = app().await.oneshot(post_open(body)).await.unwrap();
        // Either 200 (gopls on PATH in CI) or 404 (not installed).
        // Both are correct end-states — what matters is that POST emits
        // a structured response the renderer can toast, not a silent WS
        // failure on a later upgrade.
        let status = resp.status();
        assert!(
            status == StatusCode::OK || status == StatusCode::NOT_FOUND,
            "unexpected status {status}"
        );
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        if status == StatusCode::OK {
            let id = parsed["session_id"].as_str().expect("session_id string");
            assert!(!id.is_empty());
        } else {
            let msg = parsed["error"].as_str().expect("error string");
            assert!(
                msg.contains("gopls"),
                "404 body should name the missing binary, got {msg}"
            );
        }
    }

    // Note: there's no unit test here for "GET /connect with unknown session
    // returns 404", because driving a real WebSocket handshake through
    // `tower::ServiceExt::oneshot` is brittle — axum's `WebSocketUpgrade`
    // extractor returns 426 before our handler runs unless the synthetic
    // request matches its negotiation exactly across axum versions. The
    // claim-side semantics ("unknown session id is NotFound") are covered by
    // `super::super::registry::tests::unknown_session_is_not_found`, and the
    // route↔registry wiring is covered by the manual smoke test.
}
