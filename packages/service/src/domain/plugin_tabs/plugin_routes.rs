//! Grant minting (main token) and the plugin-only routes (plugin token,
//! `docs/CUSTOM_TABS.md` §4.2–§4.5). Loopback only: custom tabs are a desktop
//! feature, so none of this is mounted on the remote listener.

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Json, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::Router;
use cadencr_plugin_core::tab::TabManifest;
use chrono::SecondsFormat;
use serde_json::Value;

use super::grants::{GrantRequest, Minted};
use super::models::{CreatePluginTabGrantRequest, PluginNetFetchQuery, PluginTabGrant};
use super::policy::Scope;
use super::principal::{token_invalid, PluginPrincipal};
use super::registry::LocalTab;
use super::storage::{self, StorageScope};
use super::{config, enablement, net, registry, socket};
use crate::app_state::AppState;
use crate::domain::features::repository::project_id_for_feature;
use crate::error::AppError;

pub fn plugin_tabs_loopback_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/plugin-tabs/{id}/grants",
            post(plugin_tab_create_grant_handler),
        )
        .route(
            "/api/plugin-tabs/grants/current",
            delete(plugin_tab_revoke_current_grant_handler),
        )
        .route(
            "/api/plugin-tabs/self/configuration",
            get(plugin_tab_self_configuration_handler),
        )
        .route(
            "/api/plugin-tabs/self/storage",
            get(plugin_tab_self_storage_list_handler),
        )
        .route(
            "/api/plugin-tabs/self/storage/{key}",
            get(plugin_tab_self_storage_get_handler)
                .put(plugin_tab_self_storage_put_handler)
                .delete(plugin_tab_self_storage_delete_handler),
        )
        .route(
            "/api/plugin-tabs/self/net/fetch",
            post(plugin_tab_self_net_fetch_handler)
                .layer(DefaultBodyLimit::max(net::MAX_REQUEST_BYTES)),
        )
        .route(socket::SOCKET_PATH, get(socket::plugin_tab_socket_handler))
        .merge(super::runtime_routes::plugin_tab_runtime_router())
}

/// Mint a plugin token for one tab instance in `feature_id`. 404 when the tab
/// or feature does not exist, 422 `PLUGIN_TAB_INVALID` for an invalid
/// manifest, 403 `PLUGIN_TAB_DISABLED` unless the tab is effective for the
/// feature's project.
#[utoipa::path(
    post,
    path = "/api/plugin-tabs/{id}/grants",
    params(("id" = String, Path,)),
    request_body = CreatePluginTabGrantRequest,
    responses((status = 200, body = PluginTabGrant))
)]
pub async fn plugin_tab_create_grant_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreatePluginTabGrantRequest>,
) -> Result<Json<PluginTabGrant>, AppError> {
    let tab = registry::get(&id).await?;
    let project_id = project_id_for_feature(&state.read_pool, body.feature_id).await?;
    let (manifest, permissions_hash) = tab.require_valid()?;
    if !enablement::resolve(&state.read_pool, &tab, Some(project_id))
        .await?
        .effective
    {
        return Err(AppError::coded(
            StatusCode::FORBIDDEN,
            "PLUGIN_TAB_DISABLED",
            format!("custom tab `{id}` is not enabled for this project"),
        ));
    }
    let scopes = Scope::parse_all(&manifest.permissions);
    let Minted {
        token,
        grant,
        expires_at,
    } = state.plugin_tab_grants.mint(
        GrantRequest::builder()
            .plugin_id(id)
            .project_id(project_id)
            .feature_id(body.feature_id)
            .scopes(scopes)
            .permissions_hash(permissions_hash)
            .build(),
    );
    let Some(expires_at) = expires_at else {
        return Err(AppError::internal("a tab grant was minted without expiry"));
    };
    Ok(Json(PluginTabGrant {
        token,
        expires_at: expires_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        scopes: grant
            .scopes
            .iter()
            .map(|scope| scope.as_str().to_string())
            .collect(),
        api_version: manifest.api_version,
    }))
}

/// Revoke the presenting grant (plugin token). The instance is going away.
#[utoipa::path(
    delete,
    path = "/api/plugin-tabs/grants/current",
    responses((status = 204))
)]
pub async fn plugin_tab_revoke_current_grant_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
) -> StatusCode {
    state.plugin_tab_grants.revoke_key(&principal.grant_key);
    StatusCode::NO_CONTENT
}

/// The tab's non-secret settings for its project: project values over global
/// over declared defaults (plugin token).
#[utoipa::path(
    get,
    path = "/api/plugin-tabs/self/configuration",
    responses((status = 200, body = Object))
)]
pub async fn plugin_tab_self_configuration_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
) -> Result<Json<BTreeMap<String, Value>>, AppError> {
    let manifest = granted_manifest(&state, &principal).await?;
    Ok(Json(
        config::resolved_values(
            &state.read_pool,
            &principal.plugin_id,
            &manifest,
            principal.project_id,
        )
        .await?,
    ))
}

/// Every key in the tab's store for its project, sorted (plugin token).
#[utoipa::path(
    get,
    path = "/api/plugin-tabs/self/storage",
    responses((status = 200, body = Vec<String>))
)]
pub async fn plugin_tab_self_storage_list_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(
        storage::list(&state.read_pool, scope_of(&principal)).await?,
    ))
}

/// One stored JSON value; 404 `PLUGIN_TAB_STORAGE_NOT_FOUND` (plugin token).
#[utoipa::path(
    get,
    path = "/api/plugin-tabs/self/storage/{key}",
    params(("key" = String, Path,)),
    responses((status = 200, body = serde_json::Value))
)]
pub async fn plugin_tab_self_storage_get_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
    Path(key): Path<String>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        storage::get(&state.read_pool, scope_of(&principal), &key).await?,
    ))
}

/// Store any JSON value (≤ 256 KiB, ≤ 500 keys) under `key` (plugin token).
#[utoipa::path(
    put,
    path = "/api/plugin-tabs/self/storage/{key}",
    params(("key" = String, Path,)),
    request_body = serde_json::Value,
    responses((status = 204))
)]
pub async fn plugin_tab_self_storage_put_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> Result<StatusCode, AppError> {
    storage::put(&state.write_pool, scope_of(&principal), &key, &value).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove `key`; absent keys succeed too (plugin token).
#[utoipa::path(
    delete,
    path = "/api/plugin-tabs/self/storage/{key}",
    params(("key" = String, Path,)),
    responses((status = 204))
)]
pub async fn plugin_tab_self_storage_delete_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
    Path(key): Path<String>,
) -> Result<StatusCode, AppError> {
    storage::delete(&state.write_pool, scope_of(&principal), &key).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The egress relay (§4.5, plugin token). The body is sent upstream as is;
/// outbound headers ride in `x-cadencr-net-headers` (a JSON object whose
/// values may hold `{{secret:<key>}}`). Whatever the upstream answers comes
/// back as a 200 whose body is the upstream body, with
/// `x-cadencr-net-status` and `x-cadencr-net-headers`. Relay failures are
/// plain errors: 403 `PLUGIN_NETWORK_DENIED` (origin not allowed, or a
/// non-public address), 400 `PLUGIN_TAB_SECRET_UNKNOWN`, 429
/// `PLUGIN_NETWORK_BUSY`, 504 `PLUGIN_NETWORK_TIMEOUT`, 502 `PLUGIN_NETWORK_*`.
#[utoipa::path(
    post,
    path = "/api/plugin-tabs/self/net/fetch",
    params(
        PluginNetFetchQuery,
        ("x-cadencr-net-headers" = Option<String>, Header, description = "Outbound headers as a JSON object of strings"),
    ),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses((
        status = 200,
        description = "The upstream body",
        content_type = "application/octet-stream",
        headers(
            ("x-cadencr-net-status" = u16, description = "The upstream status"),
            ("x-cadencr-net-headers" = String, description = "The upstream headers as a JSON object"),
        ),
    ))
)]
pub async fn plugin_tab_self_net_fetch_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
    Query(query): Query<PluginNetFetchQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<net::Relayed, AppError> {
    let manifest = granted_manifest(&state, &principal).await?;
    let request = net::RelayRequest {
        url: query.url,
        method: query.method,
        headers: net::request_headers(&headers)?,
        body,
    };
    net::fetch(&state.read_pool, &principal, &manifest, request).await
}

/// The tab's manifest, provided its permissions and origins still hash to
/// what the grant was consented under. The watcher revokes stale grants too,
/// but asynchronously (and only if it saw the edit); a self route must never
/// act on, say, a widened `allowed_origins` meanwhile — the grant is revoked
/// on the spot instead.
pub(super) async fn granted_manifest(
    state: &AppState,
    principal: &PluginPrincipal,
) -> Result<TabManifest, AppError> {
    granted_tab(state, principal)
        .await
        .map(|(_, manifest)| manifest)
}

/// [`granted_manifest`], with the tab folder it was read from (its staged
/// update, if any, unread: a tab's own requests never run it).
pub(super) async fn granted_tab(
    state: &AppState,
    principal: &PluginPrincipal,
) -> Result<(LocalTab, TabManifest), AppError> {
    let tab = registry::get_installed(&principal.plugin_id).await?;
    match tab.require_valid() {
        Ok((manifest, hash)) if hash == principal.permissions_hash => {
            let manifest = manifest.clone();
            Ok((tab, manifest))
        }
        _ => {
            state.plugin_tab_grants.revoke_key(&principal.grant_key);
            Err(token_invalid())
        }
    }
}

fn scope_of(principal: &PluginPrincipal) -> StorageScope<'_> {
    StorageScope {
        plugin_id: &principal.plugin_id,
        project_id: principal.project_id,
    }
}
