//! Host API for custom tabs (`docs/CUSTOM_TABS.md` §4.2), main token only.
//! Handler names carry a `plugin_tab_` prefix: they are global operationIds.

use axum::extract::{Json, Path, Query, State};
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::Router;
use sqlx::SqlitePool;

use super::models::{
    CreatePluginTabRequest, PluginTabConfiguration, PluginTabConsentRequest, PluginTabListQuery,
    PluginTabProjectQuery, PluginTabSummary, PluginTabWorkspace, PutPluginTabConfigurationRequest,
    SetPluginTabEnablementRequest,
};
use super::{
    assets, authoring, config, consent, enablement, registry, summary, PluginTabChangedEvent,
};
use crate::app_state::AppState;
use crate::error::AppError;

pub fn plugin_tabs_router() -> Router<AppState> {
    Router::new()
        .route("/api/plugin-tabs", get(plugin_tab_list_handler))
        .route(
            "/api/plugin-tabs/authoring",
            post(plugin_tab_authoring_handler),
        )
        .route("/api/plugin-tabs/{id}", get(plugin_tab_get_handler))
        .route(
            "/api/plugin-tabs/{id}/enablement",
            put(plugin_tab_set_enablement_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/consent",
            put(plugin_tab_consent_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/configuration",
            get(plugin_tab_get_configuration_handler).put(plugin_tab_put_configuration_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/workspace",
            post(plugin_tab_workspace_handler),
        )
        // `{*path}` never matches an empty path, so the entry document has its
        // own routes, with and without the trailing slash.
        .route(
            "/api/plugin-tabs/{id}/assets",
            get(plugin_tab_entry_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/assets/",
            get(plugin_tab_entry_handler),
        )
        .route(
            "/api/plugin-tabs/{id}/assets/{*path}",
            get(plugin_tab_asset_handler),
        )
}

#[utoipa::path(
    get,
    path = "/api/plugin-tabs",
    params(PluginTabListQuery),
    responses((status = 200, body = Vec<PluginTabSummary>))
)]
pub async fn plugin_tab_list_handler(
    State(state): State<AppState>,
    Query(query): Query<PluginTabListQuery>,
) -> Result<Json<Vec<PluginTabSummary>>, AppError> {
    Ok(Json(
        summary::list(&state.read_pool, query.project_id, query.project_overrides).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/plugin-tabs/{id}",
    params(("id" = String, Path,), PluginTabProjectQuery),
    responses((status = 200, body = PluginTabSummary))
)]
pub async fn plugin_tab_get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginTabProjectQuery>,
) -> Result<Json<PluginTabSummary>, AppError> {
    Ok(Json(
        summary::get(&state.read_pool, &id, query.project_id).await?,
    ))
}

/// Set or clear the global switch or a project override. Turning a tab on
/// requires a valid manifest (422 `PLUGIN_TAB_INVALID`) and a current consent
/// (409 `PLUGIN_TAB_CONSENT_REQUIRED`). Anything but `enabled: true` revokes
/// the tab's live grants.
#[utoipa::path(
    put,
    path = "/api/plugin-tabs/{id}/enablement",
    params(("id" = String, Path,)),
    request_body = SetPluginTabEnablementRequest,
    responses((status = 200, body = PluginTabSummary))
)]
pub async fn plugin_tab_set_enablement_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SetPluginTabEnablementRequest>,
) -> Result<Json<PluginTabSummary>, AppError> {
    let pool = &state.write_pool;
    let tab = registry::get(&id).await?;
    require_project(pool, body.project_id).await?;
    enablement::set(pool, &tab, body.project_id, body.enabled).await?;
    if body.enabled != Some(true) {
        // Off or cleared may disable it somewhere: revoke the grants of every
        // project where it no longer runs (their instances re-mint or stop).
        for project_id in state.plugin_tab_grants.projects_of(&id) {
            if !enablement::resolve(pool, &tab, Some(project_id))
                .await?
                .effective
            {
                state.plugin_tab_grants.revoke_project(&id, project_id);
            }
        }
    }
    announce_change(&state, &id);
    Ok(Json(summary::from_tab(pool, tab, body.project_id).await?))
}

/// Accept the tab's current permissions — or, with the hash of a staged
/// marketplace update (`pending_update.permissions_hash`), accept that update:
/// it becomes the installed revision and its backend restarts on it. 409
/// `PLUGIN_TAB_CONSENT_STALE` when `permissions_hash` is neither (409
/// `MANAGED_TAB_UPDATE_CHANGED` when the staged update was replaced
/// meanwhile); 422 `PLUGIN_TAB_TRUST_REQUIRED` when what is accepted runs
/// commands or a backend and `trusts_code` is not set. A changed consent
/// revokes the tab's live grants.
#[utoipa::path(
    put,
    path = "/api/plugin-tabs/{id}/consent",
    params(("id" = String, Path,), PluginTabProjectQuery),
    request_body = PluginTabConsentRequest,
    responses((status = 200, body = PluginTabSummary))
)]
pub async fn plugin_tab_consent_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginTabProjectQuery>,
    Json(body): Json<PluginTabConsentRequest>,
) -> Result<Json<PluginTabSummary>, AppError> {
    let pool = &state.write_pool;
    let mut tab = registry::get(&id).await?;
    let current = match tab.pending_accepted_by(&body.permissions_hash) {
        Some(super::registry::AcceptedUpdate {
            revision,
            permissions_hash: hash,
            access_level,
        }) => {
            tab.require_pending_not_blocked()?;
            consent::require_trust(&id, access_level, body.trusts_code)?;
            // The update is promoted before consent is recorded: a failed
            // promotion leaves the installed revision and its consent alone.
            super::managed::service::promote_pending(id.clone(), revision).await?;
            // Before the grants are revoked below: the first reason given
            // is the one its Activity shows.
            state
                .plugin_tab_backends
                .stop_plugin(&id, super::backend::StopReason::TabUpdated)
                .await;
            tab = registry::get(&id).await?;
            hash
        }
        None => {
            let (manifest, current) = tab.require_valid()?;
            consent::require_current(&id, &current, &body.permissions_hash)?;
            consent::require_trust(&id, manifest.access_level(), body.trusts_code)?;
            current
        }
    };
    let previous = consent::consented_hash(pool, &id).await?;
    consent::record(pool, &id, &current).await?;
    if previous.as_deref() != Some(current.as_str()) {
        // Every grant (the backend's included) carries the old hash: open
        // instances re-mint, and the backend restarts on the new revision.
        state.plugin_tab_grants.revoke_plugin(&id);
        announce_change(&state, &id);
    }
    Ok(Json(summary::from_tab(pool, tab, query.project_id).await?))
}

/// Tell every client (other windows included) that the tab's availability
/// changed, exactly like a folder change does, so open tab views re-read it.
fn announce_change(state: &AppState, id: &str) {
    // `send` only fails when no client is subscribed — nobody to tell.
    let _ = state.plugin_tab_events_tx.send(PluginTabChangedEvent {
        plugin_id: id.to_string(),
    });
}

#[utoipa::path(
    get,
    path = "/api/plugin-tabs/{id}/configuration",
    params(("id" = String, Path,), PluginTabProjectQuery),
    responses((status = 200, body = PluginTabConfiguration))
)]
pub async fn plugin_tab_get_configuration_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginTabProjectQuery>,
) -> Result<Json<PluginTabConfiguration>, AppError> {
    let tab = registry::get(&id).await?;
    let (manifest, _) = tab.require_valid()?;
    Ok(Json(
        config::read(&state.read_pool, &id, manifest, query.project_id).await?,
    ))
}

/// Write settings at `project_id` (global when omitted); `null` removes a
/// value. Returns the form as `GET` does, secrets masked.
#[utoipa::path(
    put,
    path = "/api/plugin-tabs/{id}/configuration",
    params(("id" = String, Path,), PluginTabProjectQuery),
    request_body = PutPluginTabConfigurationRequest,
    responses((status = 200, body = PluginTabConfiguration))
)]
pub async fn plugin_tab_put_configuration_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PluginTabProjectQuery>,
    Json(body): Json<PutPluginTabConfigurationRequest>,
) -> Result<Json<PluginTabConfiguration>, AppError> {
    let pool = &state.write_pool;
    let tab = registry::get(&id).await?;
    let (manifest, _) = tab.require_valid()?;
    require_project(pool, query.project_id).await?;
    config::write(pool, &id, manifest, query.project_id, &body.values).await?;
    Ok(Json(
        config::read(pool, &id, manifest, query.project_id).await?,
    ))
}

/// Create a new custom tab and its authoring project (§8).
#[utoipa::path(
    post,
    path = "/api/plugin-tabs/authoring",
    request_body = CreatePluginTabRequest,
    responses((status = 200, body = PluginTabWorkspace))
)]
pub async fn plugin_tab_authoring_handler(
    State(state): State<AppState>,
    Json(body): Json<CreatePluginTabRequest>,
) -> Result<Json<PluginTabWorkspace>, AppError> {
    Ok(Json(authoring::create(&state.write_pool, &body).await?))
}

/// The tab's authoring project, created if missing. Idempotent; also the retry
/// for a `PLUGIN_TAB_PROJECT_SETUP_FAILED` creation, which it finishes.
#[utoipa::path(
    post,
    path = "/api/plugin-tabs/{id}/workspace",
    params(("id" = String, Path,)),
    responses((status = 200, body = PluginTabWorkspace))
)]
pub async fn plugin_tab_workspace_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PluginTabWorkspace>, AppError> {
    Ok(Json(authoring::open(&state.write_pool, &id).await?))
}

/// The tab's `entry` document. Outside OpenAPI (opaque bytes; see `assets`).
pub async fn plugin_tab_entry_handler(Path(id): Path<String>) -> Result<Response, AppError> {
    assets::serve(&id, "").await
}

/// One static file of the tab. Outside OpenAPI (opaque bytes; see `assets`).
pub async fn plugin_tab_asset_handler(
    Path((id, path)): Path<(String, String)>,
) -> Result<Response, AppError> {
    assets::serve(&id, &path).await
}

async fn require_project(pool: &SqlitePool, project_id: Option<i64>) -> Result<(), AppError> {
    match project_id {
        Some(project_id) => {
            crate::domain::projects::service::ensure_project_exists(pool, project_id).await
        }
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::domain::plugin_tabs::backend::models::PluginTabBackendState;
    use crate::domain::plugin_tabs::managed::policy::tests::configure;
    use crate::domain::plugin_tabs::managed::storage::Activation;
    use crate::domain::plugin_tabs::revocation_tests::{echo, install, launch};
    use crate::domain::plugin_tabs::test_support;

    #[tokio::test]
    async fn consenting_to_a_commands_tab_requires_trusting_its_code() {
        test_support::write_tab(
            "reviewers",
            json!({ "commands": [{ "program": "git", "reasoning": "Reads history." }] }),
        );
        let state = AppState::with_pool(test_support::pool().await);
        let hash = registry::get("reviewers")
            .await
            .unwrap()
            .permissions_hash()
            .unwrap();
        let consent = |trusts_code| {
            plugin_tab_consent_handler(
                State(state.clone()),
                Path("reviewers".into()),
                Query(PluginTabProjectQuery { project_id: None }),
                Json(PluginTabConsentRequest {
                    permissions_hash: hash.clone(),
                    trusts_code,
                }),
            )
        };

        let refused = consent(false).await.unwrap_err();
        assert_eq!(
            test_support::error_code(&refused),
            "PLUGIN_TAB_TRUST_REQUIRED"
        );
        assert_eq!(
            consent::consented_hash(&state.write_pool, "reviewers")
                .await
                .unwrap(),
            None
        );
        let Json(accepted) = consent(true).await.unwrap();
        assert!(!accepted.enablement.consent_required);
        assert_eq!(
            consent::consented_hash(&state.write_pool, "reviewers")
                .await
                .unwrap(),
            Some(hash.clone())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn accepting_a_staged_update_says_the_backend_stopped_for_it() {
        let _policy = configure(json!([]));
        let temp = tempfile::tempdir().unwrap();
        install(temp.path(), 0, Activation::Activate);
        install(temp.path(), 1, Activation::Stage);
        let state = AppState::with_pool(test_support::pool().await);
        let tab = registry::get("graph").await.unwrap();
        let (_, current) = tab.require_valid().unwrap();
        consent::record(&state.write_pool, "graph", &current)
            .await
            .unwrap();
        let staged = tab.pending.as_ref().unwrap().permissions_hash().unwrap();
        let backends = state.plugin_tab_backends.clone();
        backends
            .request(&state.plugin_tab_grants, launch(&tab, temp.path()), echo())
            .await
            .unwrap();
        drop(tab);

        let Json(accepted) = plugin_tab_consent_handler(
            State(state.clone()),
            Path("graph".into()),
            Query(PluginTabProjectQuery { project_id: None }),
            Json(PluginTabConsentRequest {
                permissions_hash: staged,
                trusts_code: true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(accepted.version.as_deref(), Some("1.0.1"));
        let mut status = backends.status("graph", 2).await.unwrap();
        for _ in 0..100 {
            if status.state != PluginTabBackendState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            status = backends.status("graph", 2).await.unwrap();
        }
        assert_eq!(status.state, PluginTabBackendState::Stopped, "{status:?}");
        // Not the grant revocation's "its permissions changed or it was turned off".
        assert_eq!(status.exit_reason.as_deref(), Some("its tab was updated"));
        backends.shutdown().await;
    }
}
