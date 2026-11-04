//! Assemble the `PluginTabSummary` the host API returns for each tab.

use std::collections::HashMap;

use cadencr_plugin_core::tab::{TabAccessLevel, TabManifest};
use sqlx::SqlitePool;

use super::managed::storage::ManagedFacts;
use super::models::{
    PluginTabBackendAvailability, PluginTabBackendBinary, PluginTabEnablement, PluginTabNetwork,
    PluginTabPendingUpdate, PluginTabStatus, PluginTabSummary,
};
use super::registry::{self, LocalTab, PendingTab};
use super::{consent, enablement, workspace};
use crate::error::AppError;

/// Every local tab, with enablement as seen from `project_id` (global only when
/// `None`) and, with `with_project_overrides`, every project's override. The
/// folder scan and each table are read once.
pub async fn list(
    pool: &SqlitePool,
    project_id: Option<i64>,
    with_project_overrides: bool,
) -> Result<Vec<PluginTabSummary>, AppError> {
    let overrides = async {
        if with_project_overrides {
            enablement::project_overrides_all(pool).await.map(Some)
        } else {
            Ok(None)
        }
    };
    let (tabs, projects, mut stored, consents, mut overrides) = tokio::try_join!(
        registry::list(),
        authoring_projects(pool),
        enablement::stored_all(pool, project_id),
        consent::consented_all(pool),
        overrides,
    )?;
    Ok(tabs
        .into_iter()
        .map(|tab| {
            let stored = stored.remove(&tab.id).unwrap_or_default();
            let consented = consents.get(&tab.id).map(String::as_str);
            let enablement = enablement::from_stored(&tab, stored, consented);
            let authoring = projects.get(&tab.id).copied();
            let project_overrides = overrides
                .as_mut()
                .map(|all| all.remove(&tab.id).unwrap_or_default());
            PluginTabSummary {
                project_overrides,
                ..build(tab, enablement, authoring)
            }
        })
        .collect())
}

/// One tab by id.
pub async fn get(
    pool: &SqlitePool,
    id: &str,
    project_id: Option<i64>,
) -> Result<PluginTabSummary, AppError> {
    from_tab(pool, registry::get(id).await?, project_id).await
}

/// The summary of a tab the caller already inspected.
pub async fn from_tab(
    pool: &SqlitePool,
    tab: LocalTab,
    project_id: Option<i64>,
) -> Result<PluginTabSummary, AppError> {
    let enablement = enablement::resolve(pool, &tab, project_id).await?;
    let authoring = workspace::owner_project(pool, &tab.id).await?;
    Ok(build(tab, enablement, authoring))
}

fn build(
    tab: LocalTab,
    enablement: PluginTabEnablement,
    authoring_project_id: Option<i64>,
) -> PluginTabSummary {
    let status = if tab.blocked.is_some() {
        PluginTabStatus::Blocked
    } else if tab.valid_manifest().is_some() {
        PluginTabStatus::Valid
    } else {
        PluginTabStatus::Invalid
    };
    let managed = tab.is_managed();
    let permissions_hash = tab.permissions_hash();
    let backend_binary = tab.facts().and_then(backend_binary);
    let managed_availability = managed.then(|| match tab.facts() {
        Some(facts) => PluginTabBackendAvailability::of_installed(facts),
        None => PluginTabBackendAvailability::UnavailableOnPlatform,
    });
    let pending_update = tab.pending.as_ref().and_then(pending_update);
    let report = tab.report;
    let manifest = report.manifest.as_ref();
    let name = manifest.map_or_else(|| tab.id.clone(), |manifest| manifest.name.clone());
    PluginTabSummary {
        managed: managed.then_some(true),
        label: manifest.map_or_else(|| name.clone(), |manifest| manifest.label().to_string()),
        version: manifest.map(|manifest| manifest.version.clone()),
        description: manifest.and_then(|manifest| manifest.description.clone()),
        api_version: manifest.map(|manifest| manifest.api_version),
        entry: manifest.map(|manifest| manifest.entry.clone()),
        permissions: manifest
            .map(|manifest| manifest.permissions.clone())
            .unwrap_or_default(),
        network: manifest.map(network).unwrap_or_default(),
        configuration: manifest
            .map(|manifest| manifest.configuration.clone())
            .unwrap_or_default(),
        commands: manifest
            .map(|manifest| manifest.commands.clone())
            .unwrap_or_default(),
        shortcuts: manifest
            .map(|manifest| manifest.shortcuts.clone())
            .unwrap_or_default(),
        replaces: manifest
            .map(|manifest| manifest.replaces().to_vec())
            .unwrap_or_default(),
        backend: manifest.and_then(|manifest| manifest.backend.clone()),
        editor: manifest.and_then(|manifest| manifest.contributes.as_ref()?.editor.clone()),
        backend_availability: manifest.and_then(|manifest| manifest.backend.as_ref()).map(
            |backend| {
                managed_availability.unwrap_or_else(|| PluginTabBackendAvailability::of(backend))
            },
        ),
        backend_binary,
        pending_update,
        access_level: manifest.map_or(TabAccessLevel::Ui, TabManifest::access_level),
        name,
        icon_svg: report.icon_svg,
        entry_present: report.entry_present,
        permissions_hash,
        status,
        blocked_reason: tab.blocked,
        errors: report.findings.errors,
        warnings: report.findings.warnings,
        dir: report.directory.to_string_lossy().into_owned(),
        authoring_project_id,
        enablement,
        project_overrides: None,
        id: tab.id,
    }
}

fn network(manifest: &TabManifest) -> PluginTabNetwork {
    manifest
        .network
        .as_ref()
        .map(|network| PluginTabNetwork {
            allowed_origins: network.allowed_origins.clone(),
            reasoning: network.reasoning.clone(),
        })
        .unwrap_or_default()
}

/// What a staged update would run; `None` when its manifest is invalid
/// (it can then never be accepted).
fn pending_update(pending: &PendingTab) -> Option<PluginTabPendingUpdate> {
    let manifest = pending.report.valid_manifest()?;
    Some(PluginTabPendingUpdate {
        version: manifest.version.clone(),
        permissions_hash: pending.permissions_hash()?,
        access_level: manifest.access_level(),
        permissions: manifest.permissions.clone(),
        network: network(manifest),
        commands: manifest.commands.clone(),
        backend: manifest.backend.clone(),
        editor: manifest
            .contributes
            .as_ref()
            .and_then(|contributes| contributes.editor.clone()),
        backend_binary: backend_binary(&pending.managed.facts),
        blocked_reason: pending.blocked.clone(),
    })
}

fn backend_binary(facts: &ManagedFacts) -> Option<PluginTabBackendBinary> {
    facts
        .backend
        .as_ref()
        .map(|backend| PluginTabBackendBinary {
            platform: backend.platform,
            protocol: backend.protocol,
            executable_sha256: backend.executable_sha256.clone(),
        })
}

/// `plugin_id → project id` for every tab authoring project.
async fn authoring_projects(pool: &SqlitePool) -> Result<HashMap<String, i64>, AppError> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT plugin_id, id FROM projects WHERE authoring_target = 'tab' AND plugin_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::models::{self, TabPlatform};
    use crate::domain::plugin_tabs::test_support::{pool, write_tab};

    #[test]
    fn a_backend_without_this_platforms_binary_is_unavailable_here() {
        let backend = |platforms: &[TabPlatform]| models::TabBackend {
            protocol: 1,
            binary: platforms
                .iter()
                .map(|platform| (platform.as_str().to_string(), "bin/b".to_string()))
                .collect(),
            reasoning: Some("r".into()),
        };
        let expected = match TabPlatform::current() {
            Some(_) => PluginTabBackendAvailability::Available,
            None => PluginTabBackendAvailability::UnavailableOnPlatform,
        };
        assert_eq!(
            PluginTabBackendAvailability::of(&backend(&TabPlatform::ALL)),
            expected
        );
        let elsewhere: Vec<TabPlatform> = TabPlatform::ALL
            .into_iter()
            .filter(|platform| Some(*platform) != TabPlatform::current())
            .collect();
        assert_eq!(
            PluginTabBackendAvailability::of(&backend(&elsewhere)),
            PluginTabBackendAvailability::UnavailableOnPlatform
        );
    }

    #[tokio::test]
    async fn summarizes_valid_and_unreadable_tabs() {
        let pool = pool().await;
        write_tab("graph", serde_json::json!({}));
        let broken = crate::domain::plugin_tabs::paths::tabs_dir().join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("tab.json"), "{").unwrap();

        let summaries = list(&pool, None, false).await.unwrap();
        assert_eq!(summaries.len(), 2);
        let broken = &summaries[0];
        assert_eq!(
            (broken.id.as_str(), broken.name.as_str()),
            ("broken", "broken")
        );
        assert_eq!(broken.status, PluginTabStatus::Invalid);
        assert!(broken.permissions_hash.is_none());
        let graph = &summaries[1];
        assert_eq!(graph.status, PluginTabStatus::Valid);
        assert_eq!(graph.label, "Graph");
        assert!(graph.replaces.is_empty());
        assert_eq!(graph.permissions, ["features:read", "git:read"]);
        assert_eq!(graph.access_level, models::TabAccessLevel::Ui);
        assert!(graph.commands.is_empty() && graph.backend.is_none());
        assert_eq!(graph.backend_availability, None);
        assert!(graph.enablement.consent_required && !graph.enablement.effective);
        assert_eq!(graph.authoring_project_id, None);
        assert_eq!(graph.project_overrides, None);
        assert_eq!(get(&pool, "graph", Some(1)).await.unwrap().id, "graph");
    }

    #[tokio::test]
    async fn lists_every_project_override_only_when_asked() {
        let pool = pool().await;
        write_tab("graph", serde_json::json!({}));
        write_tab("other", serde_json::json!({}));
        for id in [1, 2, 3] {
            sqlx::query("INSERT INTO projects (id, name, path) VALUES (?, 'P', ?)")
                .bind(id)
                .bind(format!("/tmp/p{id}"))
                .execute(&pool)
                .await
                .unwrap();
        }
        for (project_id, enabled) in [(None, true), (Some(3), false), (Some(1), true)] {
            sqlx::query(
                "INSERT INTO plugin_tab_enablements (plugin_id, project_id, enabled) \
                 VALUES ('graph', ?, ?)",
            )
            .bind(project_id)
            .bind(enabled)
            .execute(&pool)
            .await
            .unwrap();
        }

        let summaries = list(&pool, Some(1), true).await.unwrap();
        let overrides = |id: &str| {
            summaries
                .iter()
                .find(|summary| summary.id == id)
                .unwrap()
                .project_overrides
                .clone()
        };
        let override_of = |project_id, enabled| models::PluginTabProjectOverride {
            project_id,
            enabled,
        };
        assert_eq!(
            overrides("graph"),
            Some(vec![override_of(1, true), override_of(3, false)])
        );
        assert_eq!(overrides("other"), Some(vec![]));
        assert!(list(&pool, Some(1), false)
            .await
            .unwrap()
            .iter()
            .all(|summary| summary.project_overrides.is_none()));
    }

    #[tokio::test]
    async fn a_marketplace_backend_tab_shows_its_platform_and_staged_update() {
        use crate::domain::plugin_tabs::managed::storage::{
            self, fixtures::backend_fixture, Activation,
        };
        let pool = pool().await;
        let root = storage::root();
        let temp = tempfile::tempdir().unwrap();
        for (number, activation) in [(0, Activation::Activate), (1, Activation::Stage)] {
            let mut executable = cadencr_plugin_core::tab::test_support::native_executable(
                TabPlatform::current().unwrap(),
            );
            executable.push(number as u8);
            let tab = backend_fixture()
                .root(&temp.path().join(format!("v{number}")))
                .revision(number)
                .executable(executable)
                .call();
            storage::commit_revision()
                .root(&root)
                .receipt(&tab.receipt)
                .archive(&tab.archive)
                .files(&tab.files)
                .backend(tab.payload())
                .activation(activation)
                .call()
                .unwrap();
        }
        let summary = get(&pool, "graph", None).await.unwrap();
        assert_eq!(summary.managed, Some(true));
        assert_eq!(summary.version.as_deref(), Some("1.0.0"));
        assert_eq!(
            summary.backend_availability,
            Some(PluginTabBackendAvailability::Available)
        );
        assert_eq!(summary.access_level, models::TabAccessLevel::Backend);
        let update = summary.pending_update.unwrap();
        assert_eq!(update.version, "1.0.1");
        assert_ne!(Some(update.permissions_hash), summary.permissions_hash);
        assert!(update.backend.is_some());
        let installed = summary.backend_binary.unwrap();
        let staged = update.backend_binary.unwrap();
        assert_eq!(Some(installed.platform), TabPlatform::current());
        assert_eq!((installed.protocol, staged.protocol), (1, 1));
        assert_eq!(installed.executable_sha256.len(), 64);
        assert_ne!(installed.executable_sha256, staged.executable_sha256);
        // A local tab has neither.
        write_tab("local", serde_json::json!({}));
        let local = get(&pool, "local", None).await.unwrap();
        assert!(local.pending_update.is_none() && local.backend_binary.is_none());
    }
}
