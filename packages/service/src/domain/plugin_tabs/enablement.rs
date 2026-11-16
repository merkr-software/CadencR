//! Whether a tab is on: a global switch, per-project overrides, and the gates.
//!
//! Effective for a project = project row ?? global row ?? off, **and** a
//! consent whose hash equals the current permissions hash, **and** a valid
//! manifest (`docs/CUSTOM_TABS.md` §4.1), **and** no revocation blocking it.

use std::collections::HashMap;

use axum::http::StatusCode;
use sqlx::SqlitePool;

use super::consent;
use super::models::{PluginTabEnablement, PluginTabProjectOverride};
use super::registry::{self, LocalTab};
use crate::error::AppError;

/// The stored switches for one plugin: the global row and, when asked for,
/// one project's override. `None` = no row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StoredEnablement {
    pub global: Option<bool>,
    pub project: Option<bool>,
}

pub async fn stored(
    pool: &SqlitePool,
    plugin_id: &str,
    project_id: Option<i64>,
) -> Result<StoredEnablement, AppError> {
    let rows: Vec<(String, Option<i64>, bool)> = sqlx::query_as(
        "SELECT plugin_id, project_id, enabled FROM plugin_tab_enablements \
         WHERE plugin_id = ? AND (project_id IS NULL OR project_id = ?)",
    )
    .bind(plugin_id)
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(group(rows).remove(plugin_id).unwrap_or_default())
}

/// [`stored`] for every plugin at once, keyed by plugin id.
pub async fn stored_all(
    pool: &SqlitePool,
    project_id: Option<i64>,
) -> Result<HashMap<String, StoredEnablement>, AppError> {
    let rows: Vec<(String, Option<i64>, bool)> = sqlx::query_as(
        "SELECT plugin_id, project_id, enabled FROM plugin_tab_enablements \
         WHERE project_id IS NULL OR project_id = ?",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(group(rows))
}

/// Every project override of every plugin, keyed by plugin id, in project order.
pub async fn project_overrides_all(
    pool: &SqlitePool,
) -> Result<HashMap<String, Vec<PluginTabProjectOverride>>, AppError> {
    let rows: Vec<(String, i64, bool)> = sqlx::query_as(
        "SELECT plugin_id, project_id, enabled FROM plugin_tab_enablements \
         WHERE project_id IS NOT NULL ORDER BY project_id",
    )
    .fetch_all(pool)
    .await?;
    let mut grouped = HashMap::<String, Vec<PluginTabProjectOverride>>::new();
    for (plugin_id, project_id, enabled) in rows {
        grouped
            .entry(plugin_id)
            .or_default()
            .push(PluginTabProjectOverride {
                project_id,
                enabled,
            });
    }
    Ok(grouped)
}

fn group(rows: Vec<(String, Option<i64>, bool)>) -> HashMap<String, StoredEnablement> {
    let mut grouped = HashMap::<String, StoredEnablement>::new();
    for (plugin_id, row_project, enabled) in rows {
        let stored = grouped.entry(plugin_id).or_default();
        match row_project {
            None => stored.global = Some(enabled),
            Some(_) => stored.project = Some(enabled),
        }
    }
    grouped
}

/// The full enablement block of a tab summary for `project_id` (or global only).
pub async fn resolve(
    pool: &SqlitePool,
    tab: &LocalTab,
    project_id: Option<i64>,
) -> Result<PluginTabEnablement, AppError> {
    let stored = stored(pool, &tab.id, project_id).await?;
    let consented = consent::consented_hash(pool, &tab.id).await?;
    Ok(from_stored(tab, stored, consented.as_deref()))
}

/// [`resolve`] from rows already loaded — the list endpoint reads them for
/// every tab at once.
pub fn from_stored(
    tab: &LocalTab,
    stored: StoredEnablement,
    consented: Option<&str>,
) -> PluginTabEnablement {
    let consent_current = consent_is_current(tab, consented);
    let switched_on = stored.project.or(stored.global).unwrap_or(false);
    PluginTabEnablement {
        global: stored.global,
        project: stored.project,
        effective: switched_on
            && consent_current
            && tab.valid_manifest().is_some()
            && tab.blocked.is_none(),
        consent_required: !consent_current,
    }
}

/// Consent was given for exactly the tab's current permissions hash. The one
/// rule both the enable gate and `effective` apply.
fn consent_is_current(tab: &LocalTab, consented: Option<&str>) -> bool {
    consented.is_some_and(|hash| tab.permissions_hash().as_deref() == Some(hash))
}

/// Whether tab `plugin_id` may run in `project_id` right now. The gate the
/// grant endpoint checks before minting a token.
pub async fn effective(
    pool: &SqlitePool,
    plugin_id: &str,
    project_id: i64,
) -> Result<bool, AppError> {
    let tab = registry::get(plugin_id).await?;
    Ok(resolve(pool, &tab, Some(project_id)).await?.effective)
}

/// Set (`Some`) or clear (`None`) the global switch (`project_id = None`) or a
/// project override. Turning a tab on requires a valid manifest and a current
/// consent; turning it off or clearing never does. Any stored choice settles a
/// pending creation ([`consent::settle_setup`]).
pub async fn set(
    pool: &SqlitePool,
    tab: &LocalTab,
    project_id: Option<i64>,
    enabled: Option<bool>,
) -> Result<(), AppError> {
    if enabled == Some(true) {
        tab.require_valid()?;
        let consented = consent::consented_hash(pool, &tab.id).await?;
        if !consent_is_current(tab, consented.as_deref()) {
            return Err(AppError::coded(
                StatusCode::CONFLICT,
                "PLUGIN_TAB_CONSENT_REQUIRED",
                format!(
                    "review and accept the permissions of custom tab `{}` first",
                    tab.id
                ),
            ));
        }
    }
    match enabled {
        None => clear(pool, &tab.id, project_id).await?,
        Some(enabled) => write(pool, &tab.id, project_id, enabled).await?,
    }
    consent::settle_setup(pool, &tab.id).await
}

async fn clear(
    pool: &SqlitePool,
    plugin_id: &str,
    project_id: Option<i64>,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM plugin_tab_enablements WHERE plugin_id = ? AND project_id IS ?")
        .bind(plugin_id)
        .bind(project_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn write(
    pool: &SqlitePool,
    plugin_id: &str,
    project_id: Option<i64>,
    enabled: bool,
) -> Result<(), AppError> {
    // Two partial unique indexes back the two row kinds, and an upsert's
    // conflict target must name the matching one.
    let sql = if project_id.is_none() {
        "INSERT INTO plugin_tab_enablements (plugin_id, project_id, enabled) VALUES (?, ?, ?) \
         ON CONFLICT (plugin_id) WHERE project_id IS NULL \
         DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP"
    } else {
        "INSERT INTO plugin_tab_enablements (plugin_id, project_id, enabled) VALUES (?, ?, ?) \
         ON CONFLICT (plugin_id, project_id) WHERE project_id IS NOT NULL \
         DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP"
    };
    sqlx::query(sql)
        .bind(plugin_id)
        .bind(project_id)
        .bind(enabled)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::{insert_project, pool, write_tab};

    async fn graph() -> LocalTab {
        write_tab("graph", serde_json::json!({}));
        registry::get("graph").await.unwrap()
    }

    #[tokio::test]
    async fn enabling_requires_current_consent() {
        let pool = pool().await;
        let tab = graph().await;
        let error = set(&pool, &tab, None, Some(true)).await.unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: "PLUGIN_TAB_CONSENT_REQUIRED",
                ..
            }
        ));
        // Turning off never needs consent.
        set(&pool, &tab, None, Some(false)).await.unwrap();
        let hash = tab.permissions_hash().unwrap();
        consent::record(&pool, "graph", &hash).await.unwrap();
        set(&pool, &tab, None, Some(true)).await.unwrap();
        assert_eq!(
            stored(&pool, "graph", None).await.unwrap().global,
            Some(true)
        );
    }

    #[tokio::test]
    async fn project_overrides_global_and_clearing_falls_back() {
        let pool = pool().await;
        let tab = graph().await;
        let project = insert_project(&pool, "p").await;
        let other = insert_project(&pool, "q").await;
        let hash = tab.permissions_hash().unwrap();
        consent::record(&pool, "graph", &hash).await.unwrap();

        assert!(!resolve(&pool, &tab, Some(project)).await.unwrap().effective);
        set(&pool, &tab, None, Some(true)).await.unwrap();
        set(&pool, &tab, Some(project), Some(false)).await.unwrap();
        // Upserts replace, never duplicate.
        set(&pool, &tab, Some(project), Some(false)).await.unwrap();
        let blocked = resolve(&pool, &tab, Some(project)).await.unwrap();
        assert_eq!((blocked.global, blocked.project), (Some(true), Some(false)));
        assert!(!blocked.effective);
        assert!(effective(&pool, "graph", other).await.unwrap());

        set(&pool, &tab, Some(project), None).await.unwrap();
        assert!(effective(&pool, "graph", project).await.unwrap());
        set(&pool, &tab, None, None).await.unwrap();
        assert!(!effective(&pool, "graph", project).await.unwrap());
        assert_eq!(
            stored(&pool, "graph", Some(project)).await.unwrap(),
            StoredEnablement::default()
        );
    }

    #[tokio::test]
    async fn widened_or_invalid_manifests_are_not_effective() {
        let pool = pool().await;
        let tab = graph().await;
        let project = insert_project(&pool, "p").await;
        let hash = tab.permissions_hash().unwrap();
        consent::record(&pool, "graph", &hash).await.unwrap();
        set(&pool, &tab, Some(project), Some(true)).await.unwrap();
        assert!(effective(&pool, "graph", project).await.unwrap());

        write_tab(
            "graph",
            serde_json::json!({"permissions": ["features:read", "git:read", "files:read"]}),
        );
        let widened = resolve(&pool, &registry::get("graph").await.unwrap(), Some(project))
            .await
            .unwrap();
        assert!(widened.consent_required && !widened.effective);

        write_tab("graph", serde_json::json!({"version": "nope"}));
        let invalid = registry::get("graph").await.unwrap();
        assert!(
            !resolve(&pool, &invalid, Some(project))
                .await
                .unwrap()
                .effective
        );
        assert!(matches!(
            set(&pool, &invalid, Some(project), Some(true)).await,
            Err(AppError::Coded {
                code: "PLUGIN_TAB_INVALID",
                ..
            })
        ));
    }
}
