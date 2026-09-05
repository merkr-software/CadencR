//! Single source of truth for a session's runtime `(provider, model)` pair.
//!
//! Both the HTTP settings surface and the WebSocket session lifecycle resolve
//! through here, so the pair can never be assembled from two independently
//! resolved halves. The returned model is always a member of the returned
//! provider's catalog.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use utoipa::ToSchema;

use super::providers::{canonical_provider_or_error, provider_model_catalog_entry};
use super::runtime::runtime_setting_key;
use crate::domain::settings::{self, SettingOrigin};

/// Where each half of the selection came from. `ProviderDefault` means no level
/// set it and the provider's own default applies — the frontend renders that as
/// an inherited default rather than an override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SelectionOrigin {
    Feature,
    Project,
    Global,
    ProviderDefault,
}

impl From<SettingOrigin> for SelectionOrigin {
    fn from(origin: SettingOrigin) -> Self {
        match origin {
            SettingOrigin::Feature => SelectionOrigin::Feature,
            SettingOrigin::Project => SelectionOrigin::Project,
            SettingOrigin::Global => SelectionOrigin::Global,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ResolvedSelection {
    pub provider_id: String,
    pub model_id: String,
    pub provider_origin: SelectionOrigin,
    pub model_origin: SelectionOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SelectionError {
    /// The provider resolved fine but exposes no usable model. Surfaced to the
    /// user instead of inventing a plausible model id that would fail later at
    /// session start with an opaque runtime error.
    #[error("provider '{provider_id}' exposes no models; check that its CLI is installed and authenticated")]
    NoModelAvailable { provider_id: String },
}

fn model_setting_key(agent_type: &str) -> String {
    format!("model_{agent_type}")
}

pub async fn resolve_selection(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    agent_type: &str,
    feature_id: Option<i64>,
    project_id: Option<i64>,
    profile: Option<&str>,
) -> Result<ResolvedSelection, SelectionError> {
    let (provider_id, provider_origin) =
        resolve_provider(read_pool, agent_type, feature_id, project_id, cwd, profile).await;
    let (model_id, model_origin) = resolve_model(
        read_pool,
        cwd,
        agent_type,
        &provider_id,
        feature_id,
        project_id,
        profile,
    )
    .await?;

    Ok(ResolvedSelection {
        provider_id,
        model_id,
        provider_origin,
        model_origin,
    })
}

/// An unknown or misspelled stored provider id degrades to the default provider
/// rather than failing: the user can still start a session and fix the setting.
async fn resolve_provider(
    read_pool: &SqlitePool,
    agent_type: &str,
    feature_id: Option<i64>,
    project_id: Option<i64>,
    cwd: Option<&Path>,
    profile: Option<&str>,
) -> (String, SelectionOrigin) {
    let key = runtime_setting_key(agent_type);
    let stored =
        settings::resolve_setting_with_origin(read_pool, &key, feature_id, project_id).await;

    match stored {
        Some((raw, origin)) => match canonical_provider_or_error(&raw) {
            Ok(provider_id) => {
                if provider_is_available(read_pool, cwd, profile, &provider_id).await {
                    (provider_id, origin.into())
                } else {
                    // A stored provider whose CLI is missing would start a
                    // session that cannot run. Surface the substitution instead
                    // of silently honoring a dead selection.
                    tracing::warn!(
                        stored_provider = %provider_id,
                        "stored provider is not available on this machine; falling back to the catalog default"
                    );
                    (
                        available_default_provider(read_pool, cwd, profile).await,
                        SelectionOrigin::ProviderDefault,
                    )
                }
            }
            Err(error) => {
                tracing::warn!(
                    stored_provider = %raw,
                    %error,
                    "stored provider is not a known provider; falling back to the default"
                );
                (
                    available_default_provider(read_pool, cwd, profile).await,
                    SelectionOrigin::ProviderDefault,
                )
            }
        },
        None => (
            available_default_provider(read_pool, cwd, profile).await,
            SelectionOrigin::ProviderDefault,
        ),
    }
}

/// The default provider as the frontend sees it: the live catalog's default,
/// which prefers the first registered provider only when it is actually
/// available. Resolving against the registry alone would hand new sessions a
/// provider whose CLI is not installed on this machine.
///
/// Called on the fallback paths: unset provider, unknown provider, or a stored
/// provider whose CLI is not available on this machine.
async fn available_default_provider(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    profile: Option<&str>,
) -> String {
    crate::domain::agents::providers::provider_catalog_live_for_cwd(read_pool, cwd, profile)
        .await
        .default_provider
}

/// Whether `provider_id`'s CLI is actually usable here. Probes that one
/// adapter only — resolution must never wait on the slowest provider.
async fn provider_is_available(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    profile: Option<&str>,
    provider_id: &str,
) -> bool {
    let Some(adapter) = super::providers::runtime_adapter(provider_id) else {
        return false;
    };
    let entry = super::providers::provider_catalog_entry_live_for_settings(
        read_pool,
        cwd,
        profile,
        adapter.as_adapter(),
    )
    .await;
    entry.status == crate::domain::agents::runtime::ProviderStatus::Available
}

/// The invariant lives here: a stored model is only kept when it belongs to the
/// already-resolved provider's catalog. Validation touches that one adapter, so
/// resolution never waits on the slowest provider probe.
async fn resolve_model(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    agent_type: &str,
    provider_id: &str,
    feature_id: Option<i64>,
    project_id: Option<i64>,
    profile: Option<&str>,
) -> Result<(String, SelectionOrigin), SelectionError> {
    let key = model_setting_key(agent_type);
    let stored =
        settings::resolve_setting_with_origin(read_pool, &key, feature_id, project_id).await;

    if let Some((model_id, origin)) = stored {
        if provider_model_catalog_entry(read_pool, cwd, provider_id, Some(&model_id), profile)
            .await
            .is_some()
        {
            return Ok((model_id, origin.into()));
        }
        tracing::info!(
            provider_id,
            model_id = %model_id,
            "stored model does not belong to the resolved provider; using the provider default"
        );
    }

    provider_model_catalog_entry(read_pool, cwd, provider_id, None, profile)
        .await
        .map(|model| (model.id, SelectionOrigin::ProviderDefault))
        .ok_or_else(|| SelectionError::NoModelAvailable {
            provider_id: provider_id.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;

    use crate::domain::agents::runtime::DEFAULT_PROVIDER;

    use super::{resolve_provider, resolve_selection, SelectionOrigin};

    /// Pool with a feature-level SQLite surface (features + feature_settings)
    /// and a projects table for project-file name resolution.
    async fn pool_with_feature(model: Option<&str>, provider: Option<&str>) -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE features (
                id INTEGER PRIMARY KEY,
                project_id INTEGER,
                model_session TEXT,
                agent_runtime_session TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '/tmp')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name) VALUES (1, 'proj')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, model_session, agent_runtime_session) VALUES (7, 1, ?, ?)",
        )
        .bind(model)
        .bind(provider)
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    /// Whether the stored `claude_code` provider's CLI is probeable on this
    /// machine. The live catalog only lists available providers, so this is the
    /// same signal `resolve_provider` validates against.
    fn stored_provider_available(
        catalog: &crate::domain::agents::runtime::AgentCatalogResponse,
    ) -> bool {
        catalog
            .providers
            .iter()
            .any(|provider| provider.id == "claude_code")
    }

    /// The stored provider is honored with its Feature origin when its CLI is
    /// installed; when it is not, the fallback keeps a usable provider and
    /// reports the substitution instead of a dead selection.
    #[tokio::test]
    async fn feature_override_wins_and_reports_feature_origin() {
        let pool = pool_with_feature(None, Some("claude_code")).await;

        let selection = resolve_selection(&pool, None, "session", Some(7), Some(1), None)
            .await
            .expect("resolvable");

        let catalog =
            crate::domain::agents::providers::provider_catalog_live_for_cwd(&pool, None, None)
                .await;

        if stored_provider_available(&catalog) {
            assert_eq!(selection.provider_id, "claude_code");
            assert_eq!(selection.provider_origin, SelectionOrigin::Feature);
        } else {
            assert_eq!(selection.provider_id, catalog.default_provider);
            assert_eq!(selection.provider_origin, SelectionOrigin::ProviderDefault);
        }
    }

    /// A stored provider that is a *known* provider must be honored when its CLI
    /// is installed, and dropped for the catalog default when it is not. The
    /// review case: `claude_code` stored in settings on a Codex/OpenCode-only
    /// machine must not be handed to a new session.
    #[tokio::test]
    async fn stored_provider_is_honored_only_when_its_cli_is_available() {
        let pool = pool_with_feature(None, Some("claude_code")).await;

        let (provider_id, origin) =
            resolve_provider(&pool, "session", Some(7), Some(1), None, None).await;

        let catalog =
            crate::domain::agents::providers::provider_catalog_live_for_cwd(&pool, None, None)
                .await;

        if stored_provider_available(&catalog) {
            assert_eq!(provider_id, "claude_code");
            assert_eq!(origin, SelectionOrigin::Feature);
        } else {
            assert_eq!(provider_id, catalog.default_provider);
            assert_eq!(origin, SelectionOrigin::ProviderDefault);
        }
    }

    #[tokio::test]
    async fn unset_provider_falls_back_to_the_default_provider() {
        let pool = pool_with_feature(None, None).await;

        let selection = resolve_selection(&pool, None, "session", Some(7), Some(1), None)
            .await
            .expect("resolvable");

        assert_eq!(selection.provider_id, DEFAULT_PROVIDER);
        assert_eq!(selection.provider_origin, SelectionOrigin::ProviderDefault);
    }

    /// The unset-provider fallback must agree with what `/api/agent-catalog`
    /// advertises — the live catalog's default — not simply the first
    /// registered provider. On a machine without Claude, resolving against the
    /// registry alone would hand new sessions a provider whose CLI is not
    /// installed.
    #[tokio::test]
    async fn unset_provider_falls_back_to_an_available_provider() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        let (provider_id, origin) =
            resolve_provider(&pool, "session", None, None, None, None).await;

        let catalog =
            crate::domain::agents::providers::provider_catalog_live_for_cwd(&pool, None, None)
                .await;

        assert_eq!(provider_id, catalog.default_provider);
        assert_eq!(origin, SelectionOrigin::ProviderDefault);
    }

    /// The invariant this whole change exists for: a stored model that does not
    /// belong to the resolved provider must never be returned. Pairing an
    /// opencode model id with claude_code is exactly the bug being fixed.
    #[tokio::test]
    async fn model_outside_the_resolved_provider_catalog_falls_back_to_its_default() {
        let pool = pool_with_feature(Some("lmstudio/qwen-3.6:35b-a3b"), Some("claude_code")).await;

        let selection = resolve_selection(&pool, None, "session", Some(7), Some(1), None)
            .await
            .expect("resolvable");

        assert_eq!(selection.provider_id, "claude_code");
        assert_ne!(selection.model_id, "lmstudio/qwen-3.6:35b-a3b");
        assert_eq!(selection.model_origin, SelectionOrigin::ProviderDefault);
    }

    #[tokio::test]
    async fn unknown_provider_id_falls_back_to_the_default_provider() {
        let pool = pool_with_feature(None, Some("not_a_provider")).await;

        let selection = resolve_selection(&pool, None, "session", Some(7), Some(1), None)
            .await
            .expect("resolvable");

        assert_eq!(selection.provider_id, DEFAULT_PROVIDER);
    }
}
