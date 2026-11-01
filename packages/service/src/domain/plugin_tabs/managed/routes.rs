use super::policy::{self, ManagedTabPolicyStatus, PolicySnapshot, PolicySubject};
use super::{invalid, service, InstallManagedTabRequest, ManagedTabInventoryEntry};
use crate::domain::plugin_tabs::consent;
use crate::{
    app_state::AppState,
    domain::themes::managed::{
        catalog,
        models::{ManagedThemeCatalogResponse, SignedMixedCatalog, TabVersionUnavailable},
    },
    error::AppError,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use cadencr_plugin_core::tab::TabPlatform;
use cadencr_registry_core::TabBackendRefusal;
use std::collections::{BTreeMap, BTreeSet};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/marketplace/tabs",
            get(get_managed_tabs).post(install_managed_tab),
        )
        .route(
            "/api/marketplace/tabs/catalog",
            get(get_managed_tab_catalog),
        )
        .route(
            "/api/marketplace/tabs/catalog/refresh",
            post(refresh_managed_tab_catalog),
        )
        .route("/api/marketplace/tabs/policy", get(get_managed_tab_policy))
        .route(
            "/api/marketplace/tabs/{id}/update",
            post(update_managed_tab),
        )
        .route(
            "/api/marketplace/tabs/{id}",
            axum::routing::delete(remove_managed_tab),
        )
        .route(
            "/api/marketplace/tabs/{id}/pending",
            axum::routing::delete(discard_managed_tab_update),
        )
        .layer(axum::extract::DefaultBodyLimit::max(
            cadencr_registry_core::MAX_CATALOG_BYTES + 1024 * 1024,
        ))
}
#[utoipa::path(get, path="/api/marketplace/tabs", operation_id="getManagedTabs", responses((status=200, body=Vec<ManagedTabInventoryEntry>)))]
pub async fn get_managed_tabs() -> Result<Json<Vec<ManagedTabInventoryEntry>>, AppError> {
    Ok(Json(service::inventory().await?))
}

async fn acquire(refresh: bool) -> ManagedThemeCatalogResponse {
    let (mut response, policy) =
        tokio::join!(catalog::acquire_catalog(refresh), policy::refresh(refresh));
    // A feed failure is in the policy status; this is an internal failure.
    let policy = policy
        .map_err(|error| {
            let message =
                format!("the custom tab revocation policy could not be refreshed: {error}");
            response.error = Some(match response.error.take() {
                Some(previous) => format!("{previous}; {message}"),
                None => message,
            });
        })
        .ok();
    if let Some(index) = &response.index {
        let review = review(index, policy.as_deref());
        response.recommended_versions = review.recommended(index);
        response.blocked_versions = review.blocked;
        response.unavailable_versions = review.unavailable;
    }
    response.host_platform = TabPlatform::current();
    response
}

type ByVersion<T> = BTreeMap<String, BTreeMap<String, T>>;

/// What this host can do with each tab version a catalog lists.
#[derive(Default)]
struct Review<'a> {
    /// What `policy` blocks here (this platform's binary included), with its
    /// reason: what an install would be refused with.
    blocked: ByVersion<String>,
    /// What cannot install here, and why.
    unavailable: ByVersion<TabVersionUnavailable>,
    /// The `(id, version)`s that install here and are not blocked. A
    /// malformed entry is never one (installing it fails validation).
    installable: BTreeSet<(&'a str, &'a str)>,
}

/// Review every tab version of `index`, each signed entry parsed once.
fn review<'a>(index: &'a SignedMixedCatalog, policy: Option<&PolicySnapshot>) -> Review<'a> {
    let mut review = Review::default();
    for entry in cadencr_registry_core::catalog_members(&index.signed.packages) {
        let Some((id, version)) = catalog::package_version(entry, "tab") else {
            continue;
        };
        let backend = cadencr_registry_core::signed_tab_backend(entry);
        let target = match &backend {
            Ok(Some(backend)) => backend.host_target().map(|(_, target)| target),
            _ => None,
        };
        let unavailable = match &backend {
            Ok(Some(_)) if target.is_none() => Some(TabVersionUnavailable::Platform),
            Err(TabBackendRefusal::UnsupportedProtocol { .. })
            | Err(TabBackendRefusal::UnknownPlatform { .. }) => {
                Some(TabVersionUnavailable::Protocol)
            }
            _ => None,
        };
        let executable = target.map(|target| target.executable_sha256.as_str());
        // Like every reader of the policy, it fails closed.
        let blocked = policy
            .zip(PolicySubject::signed(
                id,
                version,
                &entry["package"],
                executable,
            ))
            .and_then(|(policy, subject)| policy.blocked_reason_or_unverifiable(subject));
        if backend.is_ok() && unavailable.is_none() && blocked.is_none() {
            review.installable.insert((id, version));
        }
        if let Some(reason) = blocked {
            insert(&mut review.blocked, id, version, reason);
        }
        if let Some(unavailable) = unavailable {
            insert(&mut review.unavailable, id, version, unavailable);
        }
    }
    review
}

impl Review<'_> {
    /// The newest version of each tab that installs here and is not blocked.
    fn recommended(&self, index: &SignedMixedCatalog) -> BTreeMap<String, String> {
        catalog::recommended_for(index, "tab", |entry| {
            catalog::package_version(entry, "tab")
                .is_some_and(|version| self.installable.contains(&version))
        })
    }
}

fn insert<T>(map: &mut ByVersion<T>, id: &str, version: &str, value: T) {
    map.entry(id.to_owned())
        .or_default()
        .insert(version.to_owned(), value);
}
#[utoipa::path(get, path="/api/marketplace/tabs/catalog", operation_id="getManagedTabCatalog", responses((status=200, body=ManagedThemeCatalogResponse)))]
pub async fn get_managed_tab_catalog() -> Json<ManagedThemeCatalogResponse> {
    Json(acquire(false).await)
}
#[utoipa::path(post, path="/api/marketplace/tabs/catalog/refresh", operation_id="refreshManagedTabCatalog", responses((status=200, body=ManagedThemeCatalogResponse)))]
pub async fn refresh_managed_tab_catalog() -> Json<ManagedThemeCatalogResponse> {
    Json(acquire(true).await)
}
/// The custom-tab revocation policy in force: whether this build has a feed,
/// how fresh the cached policy is, and why not. Installing, updating and
/// starting a backend need `cache_status` `fresh` (or `not_configured`).
#[utoipa::path(get, path="/api/marketplace/tabs/policy", operation_id="getManagedTabPolicy", responses((status=200, body=ManagedTabPolicyStatus)))]
pub async fn get_managed_tab_policy() -> Result<Json<ManagedTabPolicyStatus>, AppError> {
    Ok(Json(policy::status()?))
}
#[utoipa::path(post, path="/api/marketplace/tabs", operation_id="installManagedTab", request_body=InstallManagedTabRequest, responses((status=200, body=ManagedTabInventoryEntry)))]
pub async fn install_managed_tab(
    State(state): State<AppState>,
    Json(body): Json<InstallManagedTabRequest>,
) -> Result<Json<ManagedTabInventoryEntry>, AppError> {
    let consented = consent::consented_hash(&state.read_pool, &body.tab_id).await?;
    let entry = service::install(body, false, consented).await?;
    notify(&state, &entry.id);
    Ok(Json(entry))
}
#[utoipa::path(post, path="/api/marketplace/tabs/{id}/update", operation_id="updateManagedTab", params(("id"=String,Path)), request_body=InstallManagedTabRequest, responses((status=200, body=ManagedTabInventoryEntry)))]
pub async fn update_managed_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<InstallManagedTabRequest>,
) -> Result<Json<ManagedTabInventoryEntry>, AppError> {
    if id != body.tab_id {
        return Err(invalid("tab update id mismatch"));
    }
    let consented = consent::consented_hash(&state.read_pool, &id).await?;
    let entry = service::install(body, true, consented).await?;
    notify(&state, &id);
    Ok(Json(entry))
}
#[utoipa::path(delete, path="/api/marketplace/tabs/{id}", operation_id="removeManagedTab", params(("id"=String,Path)), responses((status=200, body=bool)))]
pub async fn remove_managed_tab(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<bool>, AppError> {
    // Its running backends pin the revision; stopped first, it is reclaimed.
    state
        .plugin_tab_backends
        .stop_plugin_and_wait(&id, super::super::backend::StopReason::TabRemoved)
        .await;
    service::remove(id.clone()).await?;
    notify(&state, &id);
    Ok(Json(true))
}
/// Discard the update staged for review; the installed revision stays. 404
/// `MANAGED_TAB_UPDATE_NOT_FOUND` when none is staged.
#[utoipa::path(delete, path="/api/marketplace/tabs/{id}/pending", operation_id="discardManagedTabUpdate", params(("id"=String,Path)), responses((status=200, body=bool)))]
pub async fn discard_managed_tab_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<bool>, AppError> {
    service::discard_pending(id.clone()).await?;
    notify(&state, &id);
    Ok(Json(true))
}
fn notify(state: &AppState, id: &str) {
    let _ = state
        .plugin_tab_events_tx
        .send(super::super::PluginTabChangedEvent {
            plugin_id: id.to_string(),
        });
}

#[cfg(test)]
mod tests {
    use super::super::storage::fixtures::{
        backend_fixture, fixture, fixture_revision, merged, other_platform,
    };
    use super::*;

    #[test]
    fn versions_this_host_cannot_install_are_listed_and_never_recommended() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = other_platform();
        let foreign = backend_fixture()
            .root(&temp.path().join("foreign"))
            .id("foreign")
            .platform(elsewhere)
            .call();
        let native = backend_fixture()
            .root(&temp.path().join("native"))
            .id("native")
            .executable(cadencr_plugin_core::tab::test_support::native_executable(
                TabPlatform::current().unwrap(),
            ))
            .call();
        let (ui, ..) = fixture(&temp.path().join("ui"));
        let mut index = merged(&[&foreign.receipt.index, &native.receipt.index, &ui.index]);
        let mut future = native.receipt.index.signed.packages[0].clone();
        future["package"]["tab"]["id"] = "future".into();
        future["package"]["tab"]["backend"]["protocol"] = serde_json::json!(2);
        index.signed.packages.push(future);
        let review = review(&index, None);
        assert_eq!(
            review.unavailable,
            BTreeMap::from([
                (
                    "foreign".into(),
                    BTreeMap::from([("1.0.0".into(), TabVersionUnavailable::Platform)])
                ),
                (
                    "future".into(),
                    BTreeMap::from([("1.0.0".into(), TabVersionUnavailable::Protocol)])
                ),
            ])
        );
        assert_eq!(
            review.installable,
            BTreeSet::from([("graph", "1.0.0"), ("native", "1.0.0")])
        );
    }

    #[test]
    fn blocked_versions_are_listed_with_their_reason_and_never_recommended() {
        let _policy = super::super::policy::tests::configure(serde_json::json!([
            {"tab_id":"graph","version_requirement":"=1.0.1","reason":"the update is malware"}
        ]));
        let temp = tempfile::tempdir().unwrap();
        let (old, ..) = fixture_revision(&temp.path().join("old"), 0);
        let (new, ..) = fixture_revision(&temp.path().join("new"), 1);
        let index = merged(&[&old.index, &new.index]);
        let policy = policy::current().unwrap();
        let blocked = review(&index, Some(&policy));
        assert_eq!(
            blocked.blocked["graph"],
            BTreeMap::from([("1.0.1".into(), "the update is malware".into())])
        );
        assert!(blocked.unavailable.is_empty());
        assert_eq!(blocked.installable, BTreeSet::from([("graph", "1.0.0")]));
        assert_eq!(blocked.recommended(&index)["graph"], "1.0.0");
        assert_eq!(review(&index, None).recommended(&index)["graph"], "1.0.1");
    }
}
