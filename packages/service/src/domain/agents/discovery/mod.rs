//! Provider-neutral CLI binary discovery for the host service.
//!
//! - Persists user-selected paths under two well-known global settings keys.
//! - At startup, pushes those paths into the SDK-level overrides so subsequent
//!   spawns honor them.
//! - Exposes `GET /api/agents/binary-discovery` so onboarding can render a
//!   picker over every candidate provider CLI install on disk.

pub mod routes;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cli_discovery::Candidate;

use sqlx::SqlitePool;
use tracing::info;

use super::adapter::RuntimeError;
use super::providers::{provider_registry, ProviderDiscoveryMetadata};

pub(crate) type BinaryOverrides = HashMap<String, PathBuf>;

/// Read both per-provider override paths from the global settings table and
/// install them into the SDK-level overrides. Called once at app boot, before
/// any adapter starts spawning processes.
///
/// Errors reading settings are swallowed (with a tracing log) so a borked DB
/// doesn't block startup — discovery still falls through to PATH walking +
/// well-known dirs, exactly like the no-override case.
pub async fn apply_binary_overrides_from_settings(read_pool: &SqlitePool) {
    let overrides = read_overrides(read_pool).await;
    for (provider_id, discovery) in provider_registry().discoveries() {
        if let Some(path) = overrides.get(discovery.discovery_id()).cloned() {
            info!(provider_id, path = %path.display(), "applying provider CLI override from settings");
            discovery.apply_override(Some(path));
        }
    }
}

/// Single-pass read of both override settings. Used by both startup wiring and
/// the discovery HTTP handler so we don't hit SQLite four times for two values.
pub(crate) async fn read_overrides(read_pool: &SqlitePool) -> BinaryOverrides {
    futures::future::join_all(
        provider_registry()
            .discoveries()
            .map(|(_, discovery)| async move {
                (
                    discovery.discovery_id().to_string(),
                    read_override_setting(read_pool, discovery.setting_key()).await,
                )
            }),
    )
    .await
    .into_iter()
    .filter_map(|(id, path)| path.map(|path| (id, path)))
    .collect()
}

pub(crate) async fn read_override_setting(read_pool: &SqlitePool, key: &str) -> Option<PathBuf> {
    match crate::domain::workspace::repository::get_nonempty_setting(read_pool, key).await {
        Ok(value) => value.map(PathBuf::from),
        Err(error) => {
            tracing::warn!(key, %error, "failed to read CLI binary override from settings");
            None
        }
    }
}

/// The binary Cadencr would spawn for `discovery`: `override_path` (the
/// persisted override) when set, else the best discovered install, with the
/// version discovery already probed. `None` when the CLI is not installed.
pub(crate) async fn best_cli(
    discovery: &ProviderDiscoveryMetadata,
    override_path: Option<&Path>,
) -> Option<Candidate> {
    let candidates = cli_discovery::discover_all(discovery.spec(), override_path).await;
    cli_discovery::select_best(&candidates).cloned()
}

/// User-facing message for `RuntimeError::CliNotFound`, surfaced via the WS
/// error envelope when an agent fails to spawn. Returns `None` for any other
/// error variant.
#[allow(dead_code)]
pub fn cli_not_found_message(error: &RuntimeError) -> Option<String> {
    let RuntimeError::CliNotFound { provider, searched } = error else {
        return None;
    };
    let dirs = searched
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if dirs.is_empty() {
        String::new()
    } else {
        format!("\nSearched: {dirs}")
    };
    Some(format!(
        "Could not find the `{provider}` CLI binary. Open Settings → Binary Path to point Cadencr at your install.{suffix}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool_with_settings() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn read_override_setting_returns_none_for_empty_string() {
        let pool = test_pool_with_settings().await;
        // CLI path overrides are workspace settings, stored in the JSON store.
        crate::domain::workspace::repository::set_setting(&pool, "claude_cli_path", "")
            .await
            .unwrap();
        assert!(read_override_setting(&pool, "claude_cli_path")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn read_overrides_returns_every_registered_discovery_value() {
        let pool = test_pool_with_settings().await;
        // CLI path overrides are workspace settings, which now live in the JSON
        // store — seed them there (not the legacy SQLite `settings` table).
        let set = crate::domain::workspace::repository::set_setting;
        set(&pool, "claude_cli_path", "/c/claude").await.unwrap();
        set(&pool, "opencode_cli_path", "/o/opencode")
            .await
            .unwrap();
        set(&pool, "codex_cli_path", "/x/codex").await.unwrap();
        let overrides = read_overrides(&pool).await;
        assert_eq!(overrides.get("claude"), Some(&PathBuf::from("/c/claude")));
        assert_eq!(
            overrides.get("opencode"),
            Some(&PathBuf::from("/o/opencode"))
        );
        assert_eq!(overrides.get("codex"), Some(&PathBuf::from("/x/codex")));
    }

    #[test]
    fn cli_not_found_message_includes_provider_and_searched_dirs() {
        let error = RuntimeError::cli_not_found(
            "claude",
            vec![
                PathBuf::from("/usr/bin"),
                PathBuf::from("/opt/homebrew/bin"),
            ],
        );
        let message = cli_not_found_message(&error).expect("message");
        assert!(message.contains("claude"));
        assert!(message.contains("/usr/bin"));
        assert!(message.contains("/opt/homebrew/bin"));
    }

    #[test]
    fn cli_not_found_message_omits_searched_section_when_empty() {
        let error = RuntimeError::cli_not_found("claude", vec![]);
        let message = cli_not_found_message(&error).expect("message");
        assert!(!message.contains("Searched"));
    }

    #[test]
    fn cli_not_found_message_returns_none_for_generic_error() {
        let error = RuntimeError::new("oops");
        assert!(cli_not_found_message(&error).is_none());
    }
}
