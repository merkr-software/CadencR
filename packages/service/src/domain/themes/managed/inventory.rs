use super::models::ManagedThemeInventoryEntry;
use super::{archive, storage};
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::domain::settings_store;
use crate::error::AppError;

pub async fn inventory() -> Result<Vec<ManagedThemeInventoryEntry>, AppError> {
    let root = storage::root();
    let discovery_root = root.clone();
    let ids =
        tokio::task::spawn_blocking(move || storage::with_root(discovery_root, installed_ids))
            .await
            .map_err(archive::invalid)??;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let active = active_ids();
    let refreshed = super::policy::refresh(false).await;
    let trust = pinned_index_trust_store();
    tokio::task::spawn_blocking(move || {
        storage::with_root(root, || inventory_snapshot(&trust, ids, active, refreshed))
    })
    .await
    .map_err(archive::invalid)?
}
fn active_ids() -> std::collections::HashSet<String> {
    ["theme_current", "theme_system_light", "theme_system_dark"]
        .iter()
        .filter_map(|key| settings_store::global_get(key))
        .collect()
}
fn inventory_snapshot(
    trust: &ManagedTrustStore,
    ids: Vec<String>,
    active: std::collections::HashSet<String>,
    refreshed: Result<(), AppError>,
) -> Result<Vec<ManagedThemeInventoryEntry>, AppError> {
    let policy = super::policy::snapshot();
    let mut entries = Vec::with_capacity(ids.len());
    for id in ids {
        let selected = active.contains(&format!("managed:{id}"));
        let entry = match (&refreshed, &policy) {
            (Err(error), _) | (_, Err(error)) => diagnostic(
                &id,
                AppError::coded(
                    axum::http::StatusCode::CONFLICT,
                    "MANAGED_THEME_POLICY_UNAVAILABLE",
                    format!("theme policy refresh failed: {error}"),
                ),
                selected,
            ),
            (Ok(()), Ok(policy)) => {
                match super::read::preview_snapshot(&id, trust, policy, selected) {
                    Ok(entry) => entry,
                    Err(error) => diagnostic(&id, error, selected),
                }
            }
        };
        entries.push(entry);
    }
    Ok(entries)
}
#[cfg(test)]
fn inventory_after_refresh(
    trust: &ManagedTrustStore,
    refreshed: Result<(), AppError>,
) -> Result<Vec<ManagedThemeInventoryEntry>, AppError> {
    inventory_snapshot(trust, installed_ids()?, active_ids(), refreshed)
}
#[cfg(test)]
fn inventory_trusted(
    trust: &ManagedTrustStore,
) -> Result<Vec<ManagedThemeInventoryEntry>, AppError> {
    inventory_after_refresh(trust, Ok(()))
}
fn installed_ids() -> Result<Vec<String>, AppError> {
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(storage::root()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(archive::invalid(error)),
    };
    for entry in entries {
        let entry = entry.map_err(archive::invalid)?;
        let id = entry.file_name().to_string_lossy().to_string();
        if storage::valid_id(&id) && entry.file_type().map_err(archive::invalid)?.is_dir() {
            result.push(id);
        }
    }
    result.sort();
    Ok(result)
}
fn diagnostic(id: &str, error: AppError, active: bool) -> ManagedThemeInventoryEntry {
    let pointer = storage::pointer(id).ok();
    ManagedThemeInventoryEntry {
        id: id.into(),
        name: id.into(),
        version: pointer
            .as_ref()
            .map(|value| value.version.clone())
            .unwrap_or_default(),
        sha256: pointer.map(|value| value.sha256).unwrap_or_default(),
        active,
        theme: None,
        error: Some(error.to_string()),
        error_code: Some(
            match error {
                AppError::Coded { code, .. } => code,
                _ => "MANAGED_THEME_INVALID",
            }
            .into(),
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn empty_inventory_skips_unusable_policy_and_blocking_snapshot_preserves_context() {
        storage::secure(&storage::root()).unwrap();
        crate::shared::atomic_file::write_atomic_private(
            &storage::root().join("theme-blocklist.json"),
            "broken",
        )
        .unwrap();
        assert!(inventory().await.unwrap().is_empty());
        let trust = super::super::service::tests::commit_fixture("midnight", "1.0.0");
        settings_store::global_set("theme_current", "managed:midnight")
            .await
            .unwrap();
        let root = storage::root();
        let active = active_ids();
        let entries = tokio::task::spawn_blocking(move || {
            storage::with_root(root, || {
                inventory_snapshot(&trust, installed_ids().unwrap(), active, Ok(()))
            })
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "midnight");
        assert!(entries[0].active);
        assert!(entries[0].theme.is_some());
    }
    #[tokio::test]
    async fn corrupt_entry_retains_diagnostics_without_hiding_valid_theme() {
        let trust = super::super::service::tests::commit_fixture("midnight", "1.0.0");
        super::super::service::tests::commit_fixture("other-theme", "1.0.0");
        let failed_refresh = inventory_after_refresh(
            &trust,
            Err(AppError::coded(
                axum::http::StatusCode::CONFLICT,
                "MANAGED_THEME_POLICY_UNAVAILABLE",
                "policy expired and refresh failed",
            )),
        )
        .unwrap();
        assert!(failed_refresh.iter().all(|entry| entry.theme.is_none()
            && entry
                .error
                .as_ref()
                .is_some_and(|error| error.contains("refresh failed"))));
        assert!(inventory_after_refresh(&trust, Ok(()))
            .unwrap()
            .iter()
            .all(|entry| entry.theme.is_some()));
        std::fs::write(
            storage::owner("other-theme").unwrap().join("active.json"),
            "broken",
        )
        .unwrap();
        settings_store::global_set("theme_current", "managed:other-theme")
            .await
            .unwrap();
        let entries = inventory_trusted(&trust).unwrap();
        let valid = entries.iter().find(|entry| entry.id == "midnight").unwrap();
        assert!(valid.theme.is_some());
        assert!(valid.error.is_none());
        let broken = entries
            .iter()
            .find(|entry| entry.id == "other-theme")
            .unwrap();
        assert!(broken.theme.is_none());
        assert!(broken
            .error
            .as_ref()
            .is_some_and(|message| !message.is_empty()));
        assert_eq!(broken.error_code.as_deref(), Some("MANAGED_THEME_INVALID"));
        assert!(broken.version.is_empty());
        assert!(broken.sha256.is_empty());
        assert!(broken.active);
        assert!(super::super::service::remove("other-theme", false)
            .await
            .is_err());
        assert!(
            super::super::service::remove("other-theme", true)
                .await
                .unwrap()
                .success
        );
        assert_eq!(
            settings_store::global_get("theme_current").as_deref(),
            Some("cadencr-dark")
        );
        assert!(inventory_trusted(&trust)
            .unwrap()
            .iter()
            .any(|entry| entry.id == "midnight" && entry.theme.is_some()));
    }
}
