//! Routes of the two tab levels past the page (`docs/CUSTOM_TABS.md` §4.6,
//! §4.7): `exec` and `backend` for the tab (plugin token), and the activity
//! the user sees and the presence leases that keep a backend running (main
//! token). Loopback only, like every custom-tab route.

use axum::extract::{Json, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::Router;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::activity::PluginTabExecRecord;
use super::backend::models::{PluginBackendRequest, PluginBackendResponse, PluginTabBackendStatus};
use super::backend::{unavailable_on_platform, BackendLaunch, RunningBackend};
use super::exec::{self, PluginExecRequest, PluginExecResult};
use super::managed::policy;
use super::models::installed_here;
use super::plugin_routes::{granted_manifest, granted_tab};
use super::policy::Scope;
use super::presence::check_lease_id;
use super::principal::PluginPrincipal;
use super::registry::{self, CurrentRevision};
use crate::app_state::AppState;
use crate::domain::features::repository::is_feature_archived;
use crate::domain::features::service::get_feature_cwd;
use crate::error::AppError;

pub fn plugin_tab_runtime_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/plugin-tabs/self/exec",
            post(plugin_tab_self_exec_handler),
        )
        .route(
            "/api/plugin-tabs/self/backend",
            post(plugin_tab_self_backend_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/activity",
            get(plugin_tab_activity_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/backends/{feature_id}",
            delete(plugin_tab_stop_backend_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/presence/{lease_id}",
            put(plugin_tab_renew_presence_handler).delete(plugin_tab_release_presence_handler),
        )
}

/// Run one of the tab's declared `commands` in its conversation's folder,
/// without a shell (plugin token). A non-zero exit is a 200 result. 403
/// `PLUGIN_EXEC_DENIED` for an undeclared program, 422
/// `PLUGIN_EXEC_NOT_FOUND`, 429 `PLUGIN_EXEC_BUSY`, 504 `PLUGIN_EXEC_TIMEOUT`,
/// 502 `PLUGIN_EXEC_OUTPUT_TOO_LARGE` / `PLUGIN_EXEC_FAILED`.
#[utoipa::path(
    post,
    path = "/api/plugin-tabs/self/exec",
    request_body = PluginExecRequest,
    responses((status = 200, body = PluginExecResult))
)]
pub async fn plugin_tab_self_exec_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
    Json(body): Json<PluginExecRequest>,
) -> Result<Json<PluginExecResult>, AppError> {
    let manifest = granted_manifest(&state, &principal).await?;
    Ok(Json(
        exec::run(
            &state.read_pool,
            &state.plugin_tab_activity,
            &principal,
            &manifest,
            body,
        )
        .await?,
    ))
}

/// Send one request to the tab's native backend, starting it if it is not
/// running (plugin token). A backend error is a 200 with `error`. 403
/// `PLUGIN_BACKEND_UNDECLARED`, 422 `PLUGIN_BACKEND_UNAVAILABLE` /
/// `PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM`, 409 `PLUGIN_BACKEND_TAMPERED` (a
/// marketplace binary that differs from its signed digest) /
/// `MANAGED_TAB_POLICY_UNAVAILABLE` (a revocation feed is configured but no
/// fresh policy is cached: the backend does not start), 429
/// `PLUGIN_BACKEND_BUSY`, 503
/// `PLUGIN_BACKEND_CRASHING`, 504 `PLUGIN_BACKEND_TIMEOUT`, 502
/// `PLUGIN_BACKEND_EXITED`.
#[utoipa::path(
    post,
    path = "/api/plugin-tabs/self/backend",
    request_body = PluginBackendRequest,
    responses((status = 200, body = PluginBackendResponse))
)]
pub async fn plugin_tab_self_backend_handler(
    State(state): State<AppState>,
    principal: PluginPrincipal,
    Json(body): Json<PluginBackendRequest>,
) -> Result<Json<PluginBackendResponse>, AppError> {
    if let Some(running) = reusable_backend(&state, &principal).await {
        return Ok(Json(running.request(body).await?));
    }
    let launch = backend_launch(&state, &principal).await?;
    Ok(Json(
        state
            .plugin_tab_backends
            .request(&state.plugin_tab_grants, launch, body)
            .await?,
    ))
}

/// The backend already running for `principal`, when nothing a full launch
/// checks has moved since it started, read cheaply: it runs under the
/// principal's permissions hash, from the tab's current folder (a new
/// marketplace revision is a new folder), a local tab's `tab.json` still
/// hashes to it, and the revocation policy does not block its marketplace
/// revision. A disabled or blocked tab's grants are revoked, which stops its
/// backend and refuses the principal before this runs. Anything else —
/// including an error reading the folder or the policy — takes the full
/// launch, which re-checks everything and answers with why.
async fn reusable_backend(state: &AppState, principal: &PluginPrincipal) -> Option<RunningBackend> {
    let running = state
        .plugin_tab_backends
        .running(
            &principal.plugin_id,
            principal.feature_id,
            &principal.permissions_hash,
        )
        .await?;
    let current = registry::current_revision(&principal.plugin_id)
        .await
        .ok()?;
    if current.directory() != running.plugin_dir() {
        return None;
    }
    let still_valid = match (current, running.managed()) {
        (
            CurrentRevision::Local {
                permissions_hash, ..
            },
            None,
        ) => permissions_hash.as_deref() == Some(principal.permissions_hash.as_str()),
        (CurrentRevision::Managed { .. }, Some((version, facts))) => policy::current()
            .ok()?
            .installed_blocked_reason(&principal.plugin_id, version, facts)
            .is_none(),
        _ => false,
    };
    still_valid.then_some(running)
}

async fn backend_launch(
    state: &AppState,
    principal: &PluginPrincipal,
) -> Result<BackendLaunch, AppError> {
    let (tab, manifest) = granted_tab(state, principal).await?;
    let Some(backend) = manifest.backend.clone() else {
        return Err(AppError::coded(
            StatusCode::FORBIDDEN,
            "PLUGIN_BACKEND_UNDECLARED",
            "this tab declares no `backend` in tab.json",
        ));
    };
    // A marketplace tab runs only the binary its signed package names for
    // this platform, re-checked against that digest before it starts, from
    // a revision its lease keeps on disk while it runs.
    let expected_sha256 = if tab.is_managed() {
        let installed = tab.facts().and_then(installed_here).ok_or_else(|| {
            unavailable_on_platform(
                "this marketplace tab has no backend binary installed for this platform".into(),
            )
        })?;
        Some(installed.executable_sha256.clone())
    } else {
        None
    };
    let worktree = get_feature_cwd(&state.read_pool, principal.feature_id).await?;
    let (managed, lease) = tab
        .managed
        .map(|managed| (managed.facts, managed.lease))
        .unzip();
    Ok(BackendLaunch {
        plugin_id: principal.plugin_id.clone(),
        plugin_version: manifest.version.clone(),
        project_id: principal.project_id,
        feature_id: principal.feature_id,
        plugin_dir: tab.report.directory,
        state_dir: super::paths::state_dir(&principal.plugin_id),
        worktree: worktree.into(),
        backend,
        scopes: Scope::parse_all(&manifest.permissions),
        permissions_hash: principal.permissions_hash.clone(),
        api_base_url: format!("http://127.0.0.1:{}", state.port),
        expected_sha256,
        managed,
        lease,
    })
}

/// `?feature_id=` of the conversation whose activity is shown.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PluginTabActivityQuery {
    pub feature_id: i64,
}

/// What a tab ran in one conversation since Cadencr started.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabActivity {
    /// The commands it asked Cadencr to run, newest first (at most 50).
    pub commands: Vec<PluginTabExecRecord>,
    /// Its native backend there; `None` when it never started.
    pub backend: Option<PluginTabBackendStatus>,
}

#[utoipa::path(
    get,
    path = "/api/plugin-tabs/{id}/activity",
    params(("id" = String, Path,), PluginTabActivityQuery),
    responses((status = 200, body = PluginTabActivity))
)]
pub async fn plugin_tab_activity_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginTabActivityQuery>,
) -> Json<PluginTabActivity> {
    Json(PluginTabActivity {
        commands: state.plugin_tab_activity.recent(&id, query.feature_id),
        backend: state
            .plugin_tab_backends
            .status(&id, query.feature_id)
            .await,
    })
}

/// Stop the tab's backend in one conversation and clear its crash history:
/// the tab's next request starts it afresh.
#[utoipa::path(
    delete,
    path = "/api/plugin-tabs/{id}/backends/{feature_id}",
    params(("id" = String, Path,), ("feature_id" = i64, Path,)),
    responses((status = 204))
)]
pub async fn plugin_tab_stop_backend_handler(
    State(state): State<AppState>,
    Path((id, feature_id)): Path<(String, i64)>,
) -> StatusCode {
    state.plugin_tab_backends.stop(&id, feature_id).await;
    StatusCode::NO_CONTENT
}

/// The conversation an open tab instance shows.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PluginTabPresenceRequest {
    pub feature_id: i64,
}

/// Take or renew a presence lease: an instance of the tab is open in the
/// conversation, so its backend keeps running, idle or not. The desktop
/// renews it every minute; unrenewed it lapses after 3 minutes. 400 for a
/// malformed lease id, 429 `PLUGIN_TAB_PRESENCE_FULL` past 1 024 leases, 404
/// `PLUGIN_TAB_CONVERSATION_NOT_FOUND` once the conversation is deleted and
/// 409 `PLUGIN_TAB_CONVERSATION_ARCHIVED` while it is archived — possibly
/// from another client, whose tabs still renew: every lease held in it goes
/// too, so its backends stop.
#[utoipa::path(
    put,
    path = "/api/plugin-tabs/{id}/presence/{lease_id}",
    params(("id" = String, Path,), ("lease_id" = String, Path,)),
    request_body = PluginTabPresenceRequest,
    responses((status = 204))
)]
pub async fn plugin_tab_renew_presence_handler(
    State(state): State<AppState>,
    Path((id, lease_id)): Path<(String, String)>,
    Json(body): Json<PluginTabPresenceRequest>,
) -> Result<StatusCode, AppError> {
    let feature_id = body.feature_id;
    check_lease_id(&lease_id)?;
    let refusal = match is_feature_archived(&state.read_pool, feature_id).await {
        Ok(false) => None,
        Ok(true) => Some(AppError::coded(
            StatusCode::CONFLICT,
            "PLUGIN_TAB_CONVERSATION_ARCHIVED",
            format!("conversation {feature_id} is archived"),
        )),
        Err(AppError::NotFound(_)) => Some(AppError::coded(
            StatusCode::NOT_FOUND,
            "PLUGIN_TAB_CONVERSATION_NOT_FOUND",
            format!("conversation {feature_id} no longer exists"),
        )),
        Err(error) => return Err(error),
    };
    if let Some(refusal) = refusal {
        state.plugin_tab_presence.release_features(&[feature_id]);
        return Err(refusal);
    }
    state
        .plugin_tab_presence
        .renew(&lease_id, &id, feature_id)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Release a presence lease: that instance closed. Its backend stops 30 s
/// after the conversation's last lease goes.
#[utoipa::path(
    delete,
    path = "/api/plugin-tabs/{id}/presence/{lease_id}",
    params(("id" = String, Path,), ("lease_id" = String, Path,)),
    responses((status = 204))
)]
pub async fn plugin_tab_release_presence_handler(
    State(state): State<AppState>,
    Path((id, lease_id)): Path<(String, String)>,
) -> StatusCode {
    state.plugin_tab_presence.release(&lease_id, &id);
    StatusCode::NO_CONTENT
}
