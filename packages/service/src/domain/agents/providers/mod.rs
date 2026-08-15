pub mod development;
pub mod installed;
mod model_validation;
pub(crate) mod opencode;
mod ownership;
mod registry;

use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

use super::adapter::AgentRuntimeAdapter;
use super::runtime::{
    AgentCatalogResponse, ModelCatalogEntry, ProviderCatalogResponseEntry, ProviderStatus,
};

const LEGACY_OWNERSHIP_TIMEOUT: Duration = Duration::from_secs(5);

pub use model_validation::{
    canonical_provider_or_error, model_supports_thinking_level, provider_alias_metadata,
    provider_aliases, provider_model_catalog_entry, resolve_model_or_error_for_profile,
    valid_provider_ids, validate_thinking_level_or_error,
};
pub use registry::{provider_registry, ProviderAdapterHandle};

/// Resolve a provider id to its registered adapter.
///
/// The returned handle owns its adapter for `'static`, so callers may keep it
/// across `.await` points and move it onto spawned tasks.
pub fn runtime_adapter(provider_id: &str) -> Option<ProviderAdapterHandle> {
    provider_registry().adapter(provider_id)
}

pub fn default_provider_id() -> &'static str {
    provider_registry().default_provider_id()
}

/// Resolve a legacy model-only selection from provider-owned catalog entries.
///
/// Modern callers persist or send the provider alongside the model. This
/// fallback exists for older selections that only stored a model. The selected
/// provider wins whenever its catalog owns the model; otherwise a unique
/// catalog owner may adopt it. Model spelling never participates in routing.
pub async fn resolve_effective_provider(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    provider_id: String,
    model: Option<&str>,
) -> String {
    // A non-default configured provider is an explicit user selection. The
    // legacy ownership fallback only exists for historical model-only rows
    // whose provider remained at the original default.
    if provider_id != default_provider_id() {
        return provider_id;
    }
    let Some(model) = model else {
        return provider_id;
    };
    if let Some(adapter) = runtime_adapter(&provider_id) {
        if adapter
            .catalog_entry()
            .models
            .iter()
            .any(|entry| entry.id == model)
        {
            return provider_id;
        }
        if adapter
            .extra_models(read_pool)
            .await
            .iter()
            .any(|entry| entry.id == model)
        {
            return provider_id;
        }
    }
    let catalogs = match tokio::time::timeout(
        LEGACY_OWNERSHIP_TIMEOUT,
        provider_catalog_entries_live_for_cwd(read_pool, cwd, None),
    )
    .await
    {
        Ok(catalogs) => catalogs,
        Err(_) => {
            tracing::warn!(
                model,
                "legacy model ownership lookup timed out; preserving provider"
            );
            return provider_id;
        }
    };
    ownership::resolve_catalog_provider(provider_id, model, &catalogs)
}

/// Merge user-contributed `extra_models` into an adapter's model list. User
/// entries win on id collision so descriptions and labels can be overridden.
pub(super) fn merge_extra_models(
    mut base: Vec<ModelCatalogEntry>,
    extra: Vec<ModelCatalogEntry>,
) -> Vec<ModelCatalogEntry> {
    for entry in extra {
        if let Some(existing) = base.iter_mut().find(|m| m.id == entry.id) {
            *existing = entry;
        } else {
            base.push(entry);
        }
    }
    base
}

pub async fn provider_catalog_live_for_cwd(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    profile: Option<&str>,
) -> AgentCatalogResponse {
    let providers = provider_catalog_entries_with_origin_live_for_cwd(read_pool, cwd, profile)
        .await
        .into_iter()
        .filter(|provider| provider.status == ProviderStatus::Available)
        .collect::<Vec<_>>();

    let default_provider = providers
        .iter()
        .find(|provider| provider.id == default_provider_id())
        .or_else(|| providers.first())
        .map(|provider| provider.id.clone())
        .unwrap_or_else(|| default_provider_id().to_string());

    AgentCatalogResponse {
        default_provider,
        providers,
    }
}

/// Resolve every registered provider's live catalog without hiding unavailable
/// entries. Discovery surfaces use this to explain provider availability while
/// the frontend catalog keeps filtering down to providers that can be selected.
pub async fn provider_catalog_entries_live_for_cwd(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    profile: Option<&str>,
) -> Vec<super::runtime::ProviderCatalogEntry> {
    provider_catalog_entries_with_origin_live_for_cwd(read_pool, cwd, profile)
        .await
        .into_iter()
        .map(|entry| entry.provider)
        .collect()
}

async fn provider_catalog_entries_with_origin_live_for_cwd(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    profile: Option<&str>,
) -> Vec<ProviderCatalogResponseEntry> {
    futures::future::join_all(provider_registry().iter().map(|registered| async move {
        let provider = provider_catalog_entry_live_for_settings(
            read_pool,
            cwd,
            profile,
            registered.adapter().as_adapter(),
        )
        .await;
        ProviderCatalogResponseEntry {
            provider,
            origin: registered.origin(),
        }
    }))
    .await
}

pub(super) async fn provider_catalog_entry_live_for_settings(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    profile: Option<&str>,
    adapter: &dyn AgentRuntimeAdapter,
) -> super::runtime::ProviderCatalogEntry {
    let mut entry = adapter
        .catalog_entry_live_for_settings(read_pool, cwd, profile)
        .await;
    let extra = adapter.extra_models(read_pool).await;
    if !extra.is_empty() {
        entry.models = merge_extra_models(entry.models, extra);
    }
    enforce_available_catalog_invariant(&mut entry);
    entry
}

fn enforce_available_catalog_invariant(entry: &mut super::runtime::ProviderCatalogEntry) {
    if entry.status != ProviderStatus::Available {
        return;
    }
    let valid_default = entry
        .default_model
        .as_ref()
        .is_some_and(|default| entry.models.iter().any(|model| model.id == *default));
    if !entry.models.is_empty() && valid_default {
        return;
    }
    entry.status = ProviderStatus::Unavailable;
    entry.status_message = Some(
        "provider did not supply a verified non-empty model catalog and valid default model"
            .to_string(),
    );
}

pub async fn provider_default_model(read_pool: &SqlitePool, provider_id: &str) -> Option<String> {
    if let Some(adapter) = runtime_adapter(provider_id) {
        return adapter.default_model_id_for_settings(read_pool).await;
    }

    None
}

pub fn spawn_runtime_startup_warmups() {
    for adapter in provider_registry().adapters() {
        adapter.spawn_startup_warmup();
    }
}

pub async fn notify_worktree_created_for_all_providers(
    source_project_path: &std::path::Path,
    worktree_path: &std::path::Path,
) -> Result<(), super::adapter::RuntimeError> {
    futures::future::try_join_all(
        provider_registry()
            .adapters()
            .map(|adapter| adapter.on_worktree_created(source_project_path, worktree_path)),
    )
    .await?;
    Ok(())
}

pub async fn shutdown_runtime_servers() {
    // Previously shut down a long-running OpenCode HTTP server. With the
    // ACP-only transport, OpenCode subprocesses are owned by individual
    // sessions and torn down with their owning runtime — there's no
    // shared server to terminate from here.
}

pub async fn runtime_session_finished(provider_id: &str, runtime_session_id: &str) -> bool {
    let Some(adapter) = runtime_adapter(provider_id) else {
        return false;
    };

    adapter.session_finished(runtime_session_id).await
}

/// Free-function dispatch for `AgentRuntimeAdapter::session_finished_text`.
/// See the trait doc for the `None` / `Some("")` / `Some(text)` semantics.
pub async fn runtime_session_finished_text(
    provider_id: &str,
    runtime_session_id: &str,
) -> Option<String> {
    let adapter = runtime_adapter(provider_id)?;
    adapter.session_finished_text(runtime_session_id).await
}

#[cfg(test)]
mod tests {
    use super::{
        enforce_available_catalog_invariant, merge_extra_models,
        notify_worktree_created_for_all_providers, provider_registry, resolve_effective_provider,
        runtime_adapter,
    };
    use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

    fn available_catalog(
        models: Vec<ModelCatalogEntry>,
        default_model: Option<&str>,
    ) -> ProviderCatalogEntry {
        ProviderCatalogEntry {
            id: "provider".to_string(),
            label: "Provider".to_string(),
            status: ProviderStatus::Available,
            status_message: None,
            models,
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model: default_model.map(str::to_string),
        }
    }

    #[test]
    fn merge_extra_models_appends_new_entries() {
        let base = vec![ModelCatalogEntry::alias("opus", "Opus")];
        let extra = vec![ModelCatalogEntry::alias("custom", "Custom")];
        let merged = merge_extra_models(base, extra);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].id, "custom");
    }

    #[test]
    fn merge_extra_models_overrides_on_id_collision() {
        let base = vec![ModelCatalogEntry::alias("opus", "Opus")];
        let extra = vec![ModelCatalogEntry::alias("opus", "Opus (gateway)")];
        let merged = merge_extra_models(base, extra);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].label, "Opus (gateway)");
    }

    #[test]
    fn available_catalog_requires_models_and_a_valid_default() {
        for mut entry in [
            available_catalog(Vec::new(), None),
            available_catalog(vec![ModelCatalogEntry::alias("m1", "M1")], None),
            available_catalog(vec![ModelCatalogEntry::alias("m1", "M1")], Some("missing")),
        ] {
            enforce_available_catalog_invariant(&mut entry);
            assert_eq!(entry.status, ProviderStatus::Unavailable);
            assert!(entry.status_message.is_some());
        }

        let mut valid = available_catalog(vec![ModelCatalogEntry::alias("m1", "M1")], Some("m1"));
        enforce_available_catalog_invariant(&mut valid);
        assert_eq!(valid.status, ProviderStatus::Available);
        assert!(valid.status_message.is_none());
    }

    #[test]
    fn runtime_adapter_registry_has_all_first_class_providers() {
        assert!(runtime_adapter("claude_code").is_some());
        assert!(runtime_adapter("opencode").is_some());
        let codex = runtime_adapter("codex_cli").expect("codex adapter");
        assert!(codex.session_branching().is_some());
        assert!(runtime_adapter("cursor").is_some());
        assert!(runtime_adapter("unknown").is_none());
    }

    /// Catalog resolution fans out over the registry, so the response order
    /// must equal registration order — the provider picker renders it as-is.
    ///
    /// Uses the static `catalog_entry()` fan-out rather than the live one: the
    /// live path shells out to each provider CLI and writes the process-global
    /// probe caches that `seed_static_catalog_for_tests` drives for other tests
    /// in this binary.
    #[test]
    fn catalog_entries_preserve_registry_order() {
        let ids: Vec<String> = provider_registry()
            .adapters()
            .map(|adapter| adapter.catalog_entry().id)
            .collect();
        assert_eq!(ids, provider_registry().provider_ids());
    }

    #[tokio::test]
    async fn explicit_non_default_provider_never_enters_legacy_catalog_routing() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let provider =
            resolve_effective_provider(&pool, None, "opencode".to_string(), Some("opus")).await;
        assert_eq!(provider, "opencode");
    }

    #[tokio::test]
    async fn notify_worktree_created_runs_all_provider_copy_policies() {
        let source = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(source.path().join(".claude"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(source.path().join(".claude/skills/qa"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(source.path().join(".claude/commands"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(source.path().join(".claude/rules"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(source.path().join(".codex/agents"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(source.path().join(".opencode/commands"))
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".claude/settings.local.json"), "claude")
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".claude/settings.json"), "shared")
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".claude/skills/qa/SKILL.md"), "skill")
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".claude/commands/review.md"), "command")
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".claude/rules/provider.md"), "rule")
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".codex/agents/reviewer.md"), "codex")
            .await
            .unwrap();
        tokio::fs::write(source.path().join(".opencode/commands/qa.md"), "open")
            .await
            .unwrap();
        tokio::fs::write(source.path().join("opencode.json"), r#"{"theme":"system"}"#)
            .await
            .unwrap();

        notify_worktree_created_for_all_providers(source.path(), worktree.path())
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".claude/settings.local.json"))
                .await
                .unwrap(),
            "claude"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".claude/settings.json"))
                .await
                .unwrap(),
            "shared"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".claude/skills/qa/SKILL.md"))
                .await
                .unwrap(),
            "skill"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".claude/commands/review.md"))
                .await
                .unwrap(),
            "command"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".claude/rules/provider.md"))
                .await
                .unwrap(),
            "rule"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".codex/agents/reviewer.md"))
                .await
                .unwrap(),
            "codex"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join(".opencode/commands/qa.md"))
                .await
                .unwrap(),
            "open"
        );
        assert_eq!(
            tokio::fs::read_to_string(worktree.path().join("opencode.json"))
                .await
                .unwrap(),
            r#"{"theme":"system"}"#
        );
    }
}
