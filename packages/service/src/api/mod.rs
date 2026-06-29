#![allow(clippy::result_large_err)]

pub mod middleware;
pub mod openapi;

use crate::app_state::{AppState, BrowserBridgeConfig};
use crate::domain::agents::claude_code::routes::claude_code_router;
use crate::domain::agents::discovery::routes::discovery_router;
use crate::domain::agents::runtime::AgentCatalogResponse;
use crate::domain::custom_actions::routes::custom_actions_router;
use crate::domain::diff_comments::routes::diff_comments_router;
use crate::domain::editor::format::format_router;
use crate::domain::editor::image_routes::image_router;
use crate::domain::editor::mutation_routes::editor_mutation_router;
use crate::domain::editor::routes::editor_router;
use crate::domain::feature_layouts::routes::feature_layouts_router;
use crate::domain::features::routes::features_router;
use crate::domain::git::routes::git_router;
use crate::domain::imports::routes::imports_router;
use crate::domain::lsp::lsp_router;
use crate::domain::projects::routes::projects_router;
use crate::domain::scheduled_messages::routes::scheduled_messages_router;
use crate::domain::sessions::routes::sessions_router;
use crate::domain::terminal::routes::terminal_router;
use crate::domain::workspace::routes::workspace_router;
use crate::domain::ws_session::handler::ws_handler;
use crate::error::AppError;
use axum::extract::{Query, State};
use axum::routing::{any, get, put};
use axum::Json;
use axum::Router;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[utoipa::path(
    get,
    path = "/api/agent-catalog",
    params(
        ("cwd" = Option<String>, Query, description = "Workspace path used to discover project-local provider modes"),
        ("profile" = Option<String>, Query, description = "Claude Code profile to scope the model probe to; defaults to the active profile")
    ),
    responses((status = 200, body = AgentCatalogResponse))
)]
pub async fn get_agent_catalog(
    State(state): State<AppState>,
    Query(query): Query<AgentCatalogQuery>,
) -> Json<AgentCatalogResponse> {
    let catalog = crate::domain::agents::providers::provider_catalog_live_for_cwd(
        &state.read_pool,
        query.cwd.as_deref(),
        query.profile.as_deref(),
    )
    .await;
    Json(catalog)
}

#[derive(Debug, Deserialize)]
pub struct AgentCatalogQuery {
    cwd: Option<PathBuf>,
    /// Claude Code profile name. Scopes the model probe to that profile's env
    /// (Bedrock / Vertex expose different model ids than Anthropic) instead of
    /// the globally active profile. Providers without env profiles ignore it.
    profile: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BrowserBridgeRegistrationRequest {
    url: String,
    token: String,
}

#[derive(Debug, Serialize)]
pub struct BrowserBridgeRegistrationResponse {
    ok: bool,
}

pub async fn register_browser_bridge(
    State(state): State<AppState>,
    Json(body): Json<BrowserBridgeRegistrationRequest>,
) -> Result<Json<BrowserBridgeRegistrationResponse>, AppError> {
    let config = validate_browser_bridge(body)?;
    state
        .set_browser_bridge(config)
        .map_err(AppError::Internal)?;
    Ok(Json(BrowserBridgeRegistrationResponse { ok: true }))
}

fn validate_browser_bridge(
    body: BrowserBridgeRegistrationRequest,
) -> Result<BrowserBridgeConfig, AppError> {
    BrowserBridgeConfig::from_raw(&body.url, &body.token).map_err(AppError::BadRequest)
}

/// The shared API surface (every sub-router + `/ws` + agent catalog), with no
/// auth layer or state applied. Both the loopback router and the remote router
/// build on this so the 17-router merge lives in exactly one place; each adds
/// its own middleware stack (the loopback and remote auth postures differ).
pub fn build_api_routes() -> Router<AppState> {
    Router::new()
        .merge(openapi::routes())
        .merge(git_router())
        .merge(workspace_router())
        .merge(projects_router())
        .merge(features_router())
        .merge(feature_layouts_router())
        .merge(diff_comments_router())
        .merge(sessions_router())
        .merge(scheduled_messages_router())
        .merge(terminal_router())
        .merge(editor_router())
        .merge(format_router())
        .merge(image_router())
        .merge(editor_mutation_router())
        .merge(claude_code_router())
        .merge(custom_actions_router())
        .merge(discovery_router())
        .merge(imports_router())
        .merge(lsp_router())
        // VAPID public key — shared, so the frontend can fetch it on either
        // listener. Subscription management (device-keyed) is remote-only and
        // merged separately in `build_remote_router`.
        .merge(crate::domain::push::routes::vapid_key_router())
        .route("/ws", get(ws_handler))
        .route("/api/agent-catalog", get(get_agent_catalog))
}

fn compression_layer() -> tower_http::compression::CompressionLayer {
    // Compression sits OUTSIDE auth so 401 bodies also compress.
    // Tower's CompressionLayer automatically skips `Upgrade` (WebSocket) requests.
    tower_http::compression::CompressionLayer::new()
        .gzip(true)
        .br(true)
}

/// Loopback router for the local Electron renderer. Also hosts the loopback-only
/// remote-access control endpoints (enable/disable/status/pairing-code/revoke),
/// which a remote device can therefore never reach.
pub fn build_router(state: AppState) -> Router {
    build_api_routes()
        .route("/api/browser-bridge", put(register_browser_bridge))
        .merge(crate::domain::mcp::control::control_router())
        .merge(crate::domain::remote::loopback_router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::auth_middleware,
        ))
        .layer(compression_layer())
        .with_state(state)
}

/// Remote router served over TLS on the network listener: the same API, the
/// public `pair` endpoint, and the built SPA as a fallback for client-side
/// routing. Uses device-token auth + an extended `Host` allowlist (via
/// `remote_auth_middleware`), with the `RemoteContext` injected as an extension
/// for the middleware and WebSocket handlers.
pub fn build_remote_router(
    state: AppState,
    renderer_dir: &Path,
    context: crate::remote::RemoteContext,
) -> Router {
    // A fresh limiter per listener start; bound to the remote router only.
    let limiter = std::sync::Arc::new(middleware::RateLimiter::default());
    build_api_routes()
        .merge(crate::domain::remote::public_router())
        // Device-keyed push subscription endpoints: remote-only, since they read
        // the device id injected by `remote_auth_middleware` (loopback has none).
        .merge(crate::domain::push::routes::remote_router())
        // Keep API misses API-shaped. Without this, an authenticated request for
        // a loopback-only or typoed `/api/*` path would fall through to
        // `index.html`, obscuring routing mistakes and weakening the "remote
        // devices cannot reach host-control endpoints" invariant.
        .route("/api/{*path}", any(api_not_found))
        .fallback_service(crate::remote::spa_service(renderer_dir))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::remote_auth_middleware,
        ))
        // Outer to auth so abuse (esp. pairing brute-force) is shed before any
        // DB work. Reads the limiter + `ConnectInfo` injected by the layers/serve
        // below it.
        .layer(axum::middleware::from_fn(middleware::rate_limit_middleware))
        .layer(axum::Extension(limiter))
        .layer(axum::Extension(context))
        // Stamp Cache-Control so an installed PWA always revalidates index.html
        // while content-hashed `/assets/*` cache forever (PWA-update support).
        .layer(axum::middleware::from_fn(
            middleware::cache_control_middleware,
        ))
        .layer(compression_layer())
        // Outermost: stamp CSP + hardening headers on every remote response,
        // including auth/rate-limit short-circuits and static SPA assets.
        .layer(axum::middleware::from_fn(
            middleware::remote_security_headers_middleware,
        ))
        .with_state(state)
}

async fn api_not_found() -> Result<(), AppError> {
    Err(AppError::NotFound("api route".into()))
}

#[cfg(test)]
mod tests {
    use super::{validate_browser_bridge, BrowserBridgeRegistrationRequest};

    #[test]
    fn browser_bridge_registration_accepts_loopback_http_url() {
        let config = validate_browser_bridge(BrowserBridgeRegistrationRequest {
            url: "http://127.0.0.1:4000/browser-bridge".to_string(),
            token: "secret".to_string(),
        })
        .expect("valid bridge");

        assert_eq!(config.url, "http://127.0.0.1:4000/browser-bridge");
        assert_eq!(config.token, "secret");
    }

    #[test]
    fn browser_bridge_registration_rejects_remote_urls() {
        let error = validate_browser_bridge(BrowserBridgeRegistrationRequest {
            url: "https://example.com/browser-bridge".to_string(),
            token: "secret".to_string(),
        })
        .expect_err("remote bridge should be rejected");

        assert!(error.to_string().contains("loopback"));
    }
}
