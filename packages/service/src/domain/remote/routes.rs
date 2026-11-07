//! HTTP surface for remote access.
//!
//! Control endpoints (status/enable/disable/pairing-code/revoke) are mounted on
//! the **loopback** router only, so a remote device can never reach them — they
//! require the launch token and run on `127.0.0.1`. The single **public**
//! endpoint, `pair`, is mounted on the remote router and authenticates via the
//! pairing code rather than a bearer token.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};

use super::models::{
    PairRequest, PairResponse, PairingCodeResponse, RemoteBrowserOrigins, RemoteStatus,
    TunnelHostRequest,
};
use super::{repo, tokens};
use crate::app_state::AppState;
use crate::domain::workspace::repository;
use crate::error::AppError;
use crate::remote::{
    load_tunnel_host, sanitize_tunnel_host, RemoteContext, RemoteError, RemoteInfo,
    REMOTE_ENABLED_SETTING, REMOTE_TUNNEL_HOST_SETTING,
};

const AUDIT_TAIL_LIMIT: i64 = 50;
/// Fallback label when the pairing request's User-Agent is missing or unknown.
const DEVICE_LABEL: &str = "Remote device";

/// Best-effort friendly name for a pairing device, derived from its User-Agent
/// (e.g. "iPhone · Safari"), so the host's device list is legible instead of a
/// row of identical "Remote device" entries. Purely cosmetic — never trusted for
/// auth — so a spoofed or unknown UA just yields a generic label.
fn device_label_from_user_agent(ua: Option<&str>) -> String {
    let Some(ua) = ua else {
        return DEVICE_LABEL.to_string();
    };
    let os = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Macintosh") || ua.contains("Mac OS X") {
        "Mac"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    // Order matters: Edge/Chrome UAs also contain "Safari", and Chrome-on-iOS is
    // "CriOS" — check the more specific tokens first.
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("OPR/") || ua.contains("Opera") {
        "Opera"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS") {
        "Firefox"
    } else if ua.contains("CriOS") || ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        ""
    };
    match (os, browser) {
        ("", "") => DEVICE_LABEL.to_string(),
        (os, "") => os.to_string(),
        ("", browser) => browser.to_string(),
        (os, browser) => format!("{os} · {browser}"),
    }
}

/// Loopback-only control endpoints (launch-token authenticated).
pub fn loopback_router() -> Router<AppState> {
    Router::new()
        .route("/api/remote/status", get(status_handler))
        .route("/api/remote/browser-origins", get(browser_origins_handler))
        .route("/api/remote/enable", post(enable_handler))
        .route("/api/remote/disable", post(disable_handler))
        .route("/api/remote/pairing-code", post(pairing_code_handler))
        .route("/api/remote/devices/{id}", delete(revoke_handler))
        .route("/api/remote/tunnel-host", put(set_tunnel_host_handler))
}

/// Remote-listener endpoint: exchange a pairing code for a device token.
pub fn public_router() -> Router<AppState> {
    Router::new().route("/api/remote/pair", post(pair_handler))
}

fn lan_urls(info: &RemoteInfo) -> Vec<String> {
    info.lan_ips
        .iter()
        .map(|ip| format!("https://{ip}:{}/", info.port))
        .collect()
}

/// Connect URLs that carry the pairing `code`. The tunnel host (when configured)
/// comes first so the QR/link defaults to it: a device that needs a tunnel is
/// most likely off the LAN, so pointing it at a LAN IP by default wouldn't even
/// reach the host. The LAN addresses follow as in-network fallbacks.
fn pairing_urls(info: &RemoteInfo, code: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    if let Some(host) = &info.tunnel_host {
        urls.push(format!("https://{host}/#code={code}"));
    }
    urls.extend(
        info.lan_ips
            .iter()
            .map(|ip| format!("https://{ip}:{}/#code={code}", info.port)),
    );
    urls
}

async fn current_status(state: &AppState) -> Result<RemoteStatus, AppError> {
    let info = state.remote.status().await;
    let devices = repo::list_active_devices(&state.read_pool).await?;
    let audit_tail = repo::recent_audit(&state.read_pool, AUDIT_TAIL_LIMIT).await?;
    let tunnel_host = match &info {
        Some(info) => info.tunnel_host.clone(),
        None => load_tunnel_host(&state.read_pool).await,
    };
    let (port, fingerprint, lan_urls) = match &info {
        Some(info) => (
            Some(info.port),
            Some(info.fingerprint.clone()),
            lan_urls(info),
        ),
        None => (None, None, Vec::new()),
    };
    Ok(RemoteStatus {
        enabled: info.is_some(),
        port,
        fingerprint,
        lan_urls,
        tunnel_host,
        devices,
        connected_devices: state.remote.live().connected_device_count(),
        pairing_state: state.remote.pairing().state(),
        audit_tail,
    })
}

#[utoipa::path(get, path = "/api/remote/status", responses((status = 200, body = RemoteStatus)))]
pub async fn status_handler(State(state): State<AppState>) -> Result<Json<RemoteStatus>, AppError> {
    Ok(Json(current_status(&state).await?))
}

/// Keep per-action browser authorization independent of device/audit database reads.
#[utoipa::path(get, path = "/api/remote/browser-origins", responses((status = 200, body = RemoteBrowserOrigins)))]
pub async fn browser_origins_handler(State(state): State<AppState>) -> Json<RemoteBrowserOrigins> {
    let info = state.remote.status().await;
    Json(RemoteBrowserOrigins {
        enabled: info.is_some(),
        port: info.as_ref().map(|info| info.port),
        lan_urls: info.as_ref().map(lan_urls).unwrap_or_default(),
        tunnel_host: info.and_then(|info| info.tunnel_host),
    })
}

/// Missing renderer and an unavailable port are conditions the user can act
/// on, so they keep their message; TLS, secret and serve setup failures are
/// internal.
fn start_error(err: RemoteError) -> AppError {
    match err {
        RemoteError::NoRendererDir | RemoteError::RendererIndexMissing(_) => {
            AppError::ServiceUnavailable(err.to_string())
        }
        RemoteError::BindFailed => {
            AppError::coded(StatusCode::CONFLICT, "REMOTE_BIND_FAILED", err.to_string())
        }
        RemoteError::Tls(_) | RemoteError::Secrets(_) | RemoteError::ServeFailed(_) => {
            AppError::Internal(err.to_string())
        }
    }
}

#[utoipa::path(post, path = "/api/remote/enable", responses((status = 200, body = RemoteStatus)))]
pub async fn enable_handler(State(state): State<AppState>) -> Result<Json<RemoteStatus>, AppError> {
    state.remote.start(&state).await.map_err(start_error)?;
    repository::set_setting(&state.write_pool, REMOTE_ENABLED_SETTING, "true").await?;
    Ok(Json(current_status(&state).await?))
}

#[utoipa::path(post, path = "/api/remote/disable", responses((status = 200, body = RemoteStatus)))]
pub async fn disable_handler(
    State(state): State<AppState>,
) -> Result<Json<RemoteStatus>, AppError> {
    state.remote.stop().await;
    repository::set_setting(&state.write_pool, REMOTE_ENABLED_SETTING, "false").await?;
    Ok(Json(current_status(&state).await?))
}

#[utoipa::path(post, path = "/api/remote/pairing-code", responses((status = 200, body = PairingCodeResponse)))]
pub async fn pairing_code_handler(
    State(state): State<AppState>,
) -> Result<Json<PairingCodeResponse>, AppError> {
    let info = state
        .remote
        .status()
        .await
        .ok_or_else(|| AppError::Conflict("Enable remote access before pairing".into()))?;
    let minted = state.remote.pairing().mint();
    let urls = pairing_urls(&info, &minted.code);
    Ok(Json(PairingCodeResponse {
        code: minted.code,
        expires_in_secs: minted.expires_in_secs,
        urls,
        fingerprint: info.fingerprint,
    }))
}

#[utoipa::path(
    delete,
    path = "/api/remote/devices/{id}",
    params(("id" = i64, Path, description = "Device id to revoke")),
    responses((status = 200, body = RemoteStatus))
)]
pub async fn revoke_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<RemoteStatus>, AppError> {
    if !repo::revoke_device(&state.write_pool, id).await? {
        return Err(AppError::NotFound(format!("device {id}")));
    }
    // Force-close any live sockets this device still holds as soon as the
    // revocation is committed, before the fallible audit write below.
    state.remote.live().cancel_device(id);
    repo::record_audit(&state.write_pool, "revoke", Some(id), None).await?;
    Ok(Json(current_status(&state).await?))
}

#[utoipa::path(
    put,
    path = "/api/remote/tunnel-host",
    request_body = TunnelHostRequest,
    responses((status = 200, body = RemoteStatus))
)]
pub async fn set_tunnel_host_handler(
    State(state): State<AppState>,
    Json(req): Json<TunnelHostRequest>,
) -> Result<Json<RemoteStatus>, AppError> {
    let normalized = req.host.as_deref().and_then(sanitize_tunnel_host);
    repository::set_setting(
        &state.write_pool,
        REMOTE_TUNNEL_HOST_SETTING,
        normalized.as_deref().unwrap_or(""),
    )
    .await?;
    // Rebuild the listener's `Host`/`Origin` allowlist if it's running. A restart
    // is the simplest correct way to apply the new context; it drops live remote
    // sessions, which is acceptable for a host-initiated config change.
    if let Err(err) = state.remote.restart(&state).await {
        // The listener is down now: persist that so the UI and the next launch
        // agree with reality, then report why.
        let persisted =
            repository::set_setting(&state.write_pool, REMOTE_ENABLED_SETTING, "false").await;
        return Err(match persisted {
            Ok(()) => start_error(err),
            Err(setting_err) => AppError::Internal(format!(
                "{err}; remote access is off but could not be saved as disabled: {setting_err}"
            )),
        });
    }
    Ok(Json(current_status(&state).await?))
}

#[utoipa::path(
    post,
    path = "/api/remote/pair",
    request_body = PairRequest,
    responses((status = 200, body = PairResponse), (status = 400, description = "Invalid or expired code"))
)]
pub async fn pair_handler(
    State(state): State<AppState>,
    Extension(ctx): Extension<RemoteContext>,
    headers: HeaderMap,
    Json(req): Json<PairRequest>,
) -> Result<Json<PairResponse>, AppError> {
    if !state.remote.pairing().consume(&req.code) {
        // Best-effort audit; never block the response on the audit write, but
        // surface a write failure (a rejected pairing is a security event).
        if let Err(err) = repo::record_audit(&state.write_pool, "pair_rejected", None, None).await {
            tracing::warn!(%err, "failed to record pair_rejected audit event");
        }
        return Err(AppError::BadRequest(
            "Invalid or expired pairing code".into(),
        ));
    }

    let raw = tokens::mint_raw_token();
    let hash = tokens::hash_token(&ctx.pepper, &raw);
    let label = device_label_from_user_agent(
        headers
            .get(axum::http::header::USER_AGENT)
            .and_then(|value| value.to_str().ok()),
    );
    let id = repo::insert_device(&state.write_pool, &hash, &label).await?;
    repo::record_audit(&state.write_pool, "pair", Some(id), None).await?;

    Ok(Json(PairResponse {
        device_token: raw,
        label,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn browser_origin_metadata_does_not_query_device_or_audit_storage() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let state = AppState::with_pool(pool.clone());
        // A closed pool makes accidental device/audit queries fail immediately.
        pool.close().await;
        let Json(origins) = browser_origins_handler(State(state)).await;
        assert!(!origins.enabled);
        assert!(origins.port.is_none());
        assert!(origins.lan_urls.is_empty());
        let json = serde_json::to_value(origins).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 4);
        assert!(json.get("devices").is_none());
        assert!(json.get("audit_tail").is_none());
    }

    #[tokio::test]
    async fn browser_origins_keep_the_effective_tunnel_when_settings_change_or_break() {
        use crate::domain::settings_store;
        use crate::remote::{RemoteConfig, RemoteController};
        let renderer = tempfile::tempdir().unwrap();
        std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
        let data = tempfile::tempdir().unwrap();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let mut state = AppState::with_pool(pool);
        state.remote = std::sync::Arc::new(RemoteController::new(RemoteConfig {
            renderer_dir: Some(renderer.path().to_owned()),
            remote_port: 0,
            data_dir: data.path().to_owned(),
        }));
        settings_store::global_set(REMOTE_TUNNEL_HOST_SETTING, "old.example.test")
            .await
            .unwrap();
        let started = state.remote.start(&state).await.unwrap();
        settings_store::global_set(REMOTE_TUNNEL_HOST_SETTING, "new.example.test")
            .await
            .unwrap();
        let path = settings_store::dir::global_dir().join("settings.json");
        settings_store::file::write_atomic(&path, "{ invalid JSON").unwrap();
        let Json(origins) = browser_origins_handler(State(state.clone())).await;
        assert!(origins.enabled);
        assert_eq!(origins.port, Some(started.port));
        assert_eq!(origins.tunnel_host.as_deref(), Some("old.example.test"));
        assert!(pairing_urls(&started, "code")[0].starts_with("https://old.example.test/#code="));
        state.remote.stop().await;
    }

    #[tokio::test]
    async fn revoke_closes_sockets_even_when_the_audit_write_fails() {
        // One connection so the in-memory schema is shared; no `remote_audit`
        // table, so the audit insert fails after the revocation commits.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE remote_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             token_hash TEXT NOT NULL UNIQUE, label TEXT, \
             created_at TEXT NOT NULL DEFAULT (datetime('now')), \
             last_seen_at TEXT, revoked_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let id = repo::insert_device(&pool, "hash", "phone").await.unwrap();
        let state = AppState::with_pool(pool);
        let (open_socket, _) = state.remote.live().register(id);

        let result = revoke_handler(State(state.clone()), Path(id)).await;

        assert!(result.is_err(), "the audit failure is still reported");
        assert!(open_socket.token.is_cancelled());
        assert!(!repo::revoke_device(&state.write_pool, id).await.unwrap());
    }

    #[tokio::test]
    async fn failed_tunnel_restart_persists_remote_access_off() {
        use crate::remote::{RemoteConfig, RemoteController};
        let renderer = tempfile::tempdir().unwrap();
        std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
        let data = tempfile::tempdir().unwrap();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let mut state = AppState::with_pool(pool);
        state.remote = std::sync::Arc::new(RemoteController::new(RemoteConfig {
            renderer_dir: Some(renderer.path().to_owned()),
            remote_port: 0,
            data_dir: data.path().to_owned(),
        }));
        state.remote.start(&state).await.unwrap();
        repository::set_setting(&state.write_pool, REMOTE_ENABLED_SETTING, "true")
            .await
            .unwrap();
        let (open_socket, _) = state.remote.live().register(1);
        // Make the restart's startup fail.
        std::fs::remove_file(renderer.path().join("index.html")).unwrap();

        let request = TunnelHostRequest {
            host: Some("tunnel.example.test".into()),
        };
        let result = set_tunnel_host_handler(State(state.clone()), Json(request)).await;

        assert!(result.is_err());
        assert!(state.remote.status().await.is_none());
        assert!(open_socket.token.is_cancelled());
        let enabled = repository::get_setting(&state.read_pool, REMOTE_ENABLED_SETTING)
            .await
            .unwrap();
        assert_eq!(enabled.as_deref(), Some("false"));
    }

    #[tokio::test]
    async fn enable_reports_an_occupied_port_as_a_user_error() {
        use crate::remote::{RemoteConfig, RemoteController};
        use axum::response::IntoResponse;
        let renderer = tempfile::tempdir().unwrap();
        std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
        let data = tempfile::tempdir().unwrap();
        let occupied = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let mut state = AppState::with_pool(pool);
        state.remote = std::sync::Arc::new(RemoteController::new(RemoteConfig {
            renderer_dir: Some(renderer.path().to_owned()),
            remote_port: occupied.local_addr().unwrap().port(),
            data_dir: data.path().to_owned(),
        }));

        let response = enable_handler(State(state))
            .await
            .unwrap_err()
            .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "error": "could not bind the remote listener (port may be in use)",
                "code": "REMOTE_BIND_FAILED"
            })
        );
    }

    #[tokio::test]
    async fn remote_setup_failures_stay_internal() {
        use axum::response::IntoResponse;
        let error = start_error(RemoteError::Tls(anyhow::anyhow!("key at /secret")));
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Internal server error");
    }

    const IPHONE_SAFARI: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) \
        AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    const MAC_CHROME: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
        AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const WIN_EDGE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
        (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";

    #[test]
    fn labels_common_devices() {
        assert_eq!(
            device_label_from_user_agent(Some(IPHONE_SAFARI)),
            "iPhone · Safari"
        );
        assert_eq!(
            device_label_from_user_agent(Some(MAC_CHROME)),
            "Mac · Chrome"
        );
        assert_eq!(
            device_label_from_user_agent(Some(WIN_EDGE)),
            "Windows · Edge"
        );
    }

    #[test]
    fn falls_back_when_unknown_or_missing() {
        assert_eq!(device_label_from_user_agent(None), DEVICE_LABEL);
        assert_eq!(device_label_from_user_agent(Some("curl/8.0")), DEVICE_LABEL);
    }
}
