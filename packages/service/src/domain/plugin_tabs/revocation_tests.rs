//! A marketplace tab Cadencr's signed revocation policy blocks, end to end
//! across the hooks: what the registry, summary, enablement, assets,
//! inventory, backend supervisor and grants watcher make of it.
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::broadcast;

use super::backend::models::{PluginBackendRequest, PluginTabBackendState};
use super::backend::{BackendLaunch, BackendSupervisor};
use super::grants::{self, GrantRequest, GrantStore};
use super::managed::policy::tests::{configure, expire_cache, respond};
use super::managed::storage::{self, fixtures::backend_fixture, Activation};
use super::models::PluginTabStatus;
use super::registry::{self, LocalTab};
use super::watcher::PluginTabChangedEvent;
use super::{assets, enablement, managed, summary, test_support};
use crate::error::AppError;

fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
    test_support::error_code(&result.unwrap_err())
}

/// Commit the signed backend tab `graph` 1.0.`revision` into this test's
/// marketplace folder.
pub(super) fn install(temp: &Path, revision: usize, activation: Activation) {
    let tab = backend_fixture()
        .root(&temp.join(format!("v{revision}")))
        .revision(revision)
        .call();
    storage::commit_revision()
        .root(&storage::root())
        .receipt(&tab.receipt)
        .archive(&tab.archive)
        .files(&tab.files)
        .backend(tab.payload())
        .activation(activation)
        .call()
        .unwrap();
}

/// What `runtime_routes::backend_launch` builds for `tab` in feature 2.
pub(super) fn launch(tab: &LocalTab, temp: &Path) -> BackendLaunch {
    let (manifest, hash) = tab.require_valid().unwrap();
    let managed = tab.managed.clone().unwrap();
    BackendLaunch {
        plugin_id: tab.id.clone(),
        plugin_version: manifest.version.clone(),
        project_id: 1,
        feature_id: 2,
        plugin_dir: tab.report.directory.canonicalize().unwrap(),
        state_dir: temp.join("state"),
        worktree: temp.to_path_buf(),
        backend: manifest.backend.clone().unwrap(),
        scopes: Vec::new(),
        permissions_hash: hash,
        api_base_url: "http://127.0.0.1:1".into(),
        expected_sha256: managed.facts.backend_digest().map(str::to_owned),
        managed: Some(managed.facts),
        lease: Some(managed.lease),
    }
}

pub(super) fn echo() -> PluginBackendRequest {
    PluginBackendRequest {
        method: "echo".into(),
        params: Value::Null,
        timeout_ms: None,
    }
}

#[tokio::test]
async fn a_blocked_tab_cannot_run_or_be_accepted_but_can_be_removed() {
    let _policy = configure(json!([
        {"tab_id":"graph","version_requirement":"=1.0.1","reason":"the update is malware"}
    ]));
    let temp = tempfile::tempdir().unwrap();
    install(temp.path(), 0, Activation::Activate);
    install(temp.path(), 1, Activation::Stage);
    let pool = test_support::pool().await;
    let tab = registry::get("graph").await.unwrap();
    assert_eq!(tab.blocked, None, "only the staged 1.0.1 is listed");
    assert_eq!(
        code(tab.require_pending_not_blocked()),
        "PLUGIN_TAB_BLOCKED"
    );
    let shown = summary::from_tab(&pool, tab.clone(), None).await.unwrap();
    assert_eq!(
        shown.pending_update.unwrap().blocked_reason.as_deref(),
        Some("the update is malware"),
        "the marketplace can say why it cannot be accepted"
    );
    let (_, hash) = tab.require_valid().unwrap();
    super::consent::record(&pool, "graph", &hash).await.unwrap();
    enablement::set(&pool, &tab, None, Some(true))
        .await
        .unwrap();
    assert!(
        summary::get(&pool, "graph", None)
            .await
            .unwrap()
            .enablement
            .effective
    );

    respond(json!([{"tab_id":"graph","reason":"malware"}]));
    managed::policy::refresh(false).await.unwrap();
    let tab = registry::get("graph").await.unwrap();
    assert_eq!(tab.blocked.as_deref(), Some("malware"));
    assert_eq!(code(tab.require_valid()), "PLUGIN_TAB_BLOCKED");
    assert_eq!(
        code(enablement::set(&pool, &tab, None, Some(true)).await),
        "PLUGIN_TAB_BLOCKED"
    );
    let shown = summary::get(&pool, "graph", None).await.unwrap();
    assert_eq!(shown.status, PluginTabStatus::Blocked);
    assert_eq!(shown.blocked_reason.as_deref(), Some("malware"));
    assert!(
        !shown.enablement.effective,
        "switched on and consented, yet off"
    );
    let listed = summary::list(&pool, None, false).await.unwrap();
    assert_eq!(listed[0].status, PluginTabStatus::Blocked);
    let inventory = managed::service::inventory().await.unwrap();
    assert_eq!(inventory[0].blocked.as_deref(), Some("malware"));
    assert_eq!(code(assets::serve("graph", "").await), "PLUGIN_TAB_BLOCKED");
    drop(tab);
    managed::service::remove("graph".into()).await.unwrap();
    assert_eq!(code(registry::get("graph").await), "PLUGIN_TAB_NOT_FOUND");
}

#[cfg(unix)]
#[tokio::test]
async fn a_newly_blocked_tab_stops_its_backend_before_its_grants_are_revoked() {
    let _policy = configure(json!([]));
    let temp = tempfile::tempdir().unwrap();
    install(temp.path(), 0, Activation::Activate);
    let tab = registry::get("graph").await.unwrap();
    let launch = launch(&tab, temp.path());
    let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
    let page = grants.mint(
        GrantRequest::builder()
            .plugin_id("graph".into())
            .project_id(1)
            .feature_id(2)
            .scopes(Vec::new())
            .permissions_hash(launch.permissions_hash.clone())
            .build(),
    );
    supervisor
        .request(&grants, launch.clone(), echo())
        .await
        .unwrap();
    let (events, received) = broadcast::channel(8);
    let watcher = tokio::spawn(grants::revoke_on_manifest_change(
        grants.clone(),
        supervisor.clone(),
        received,
    ));

    respond(json!([{"tab_id":"graph","reason":"malware"}]));
    managed::policy::refresh(false).await.unwrap();
    // What the policy task announces for an installed tab a policy names.
    events
        .send(PluginTabChangedEvent {
            plugin_id: "graph".into(),
        })
        .unwrap();
    drop(events);
    tokio::time::timeout(Duration::from_secs(10), watcher)
        .await
        .unwrap()
        .unwrap();
    let mut status = supervisor.status("graph", 2).await.unwrap();
    for _ in 0..100 {
        if status.state != PluginTabBackendState::Running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        status = supervisor.status("graph", 2).await.unwrap();
    }
    assert_eq!(status.state, PluginTabBackendState::Stopped, "{status:?}");
    assert_eq!(status.exit_reason.as_deref(), Some("it was blocked"));
    assert!(
        grants.resolve(&page.token).is_none(),
        "the page's grant is revoked"
    );
    assert_eq!(grants.len(), 0, "the backend's grant is revoked too");
    // And it never starts again.
    let refused = supervisor.request(&grants, launch, echo()).await;
    assert_eq!(code(refused), "PLUGIN_TAB_BLOCKED");
    assert_eq!(supervisor.status("graph", 2).await.unwrap().starts, 1);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn an_out_of_date_policy_refuses_backend_start_while_the_page_loads() {
    let _policy = configure(json!([]));
    let temp = tempfile::tempdir().unwrap();
    install(temp.path(), 0, Activation::Activate);
    expire_cache(json!([]));
    let tab = registry::get("graph").await.unwrap();
    assert_eq!(tab.blocked, None);
    tab.require_valid().expect("the tab itself stays usable");
    assets::serve("graph", "").await.expect("the page loads");
    let supervisor = BackendSupervisor::default();
    let refused = supervisor
        .request(&GrantStore::default(), launch(&tab, temp.path()), echo())
        .await;
    assert_eq!(code(refused), "MANAGED_TAB_POLICY_UNAVAILABLE");
    let status = supervisor.status("graph", 2).await.unwrap();
    assert_eq!(status.starts, 0, "nothing was spawned");
    assert!(
        status.stderr_tail[0].contains("revocation policy is out of date"),
        "{:?}",
        status.stderr_tail
    );
}
