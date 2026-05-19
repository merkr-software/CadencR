pub(crate) mod opencode;

use sqlx::SqlitePool;

use super::adapter::AgentRuntimeAdapter;
use super::runtime::{AgentCatalogResponse, ModelCatalogEntry, DEFAULT_PROVIDER};

/// All registered runtime adapters. Add new providers here.
static ADAPTERS: &[(&str, &dyn AgentRuntimeAdapter)] = &[
    (
        super::claude_code::PROVIDER_ID,
        &super::claude_code::CLAUDE_CODE_ADAPTER,
    ),
    (super::codex::PROVIDER_ID, &super::codex::CODEX_ADAPTER),
    (
        super::opencode::PROVIDER_ID,
        &super::opencode::OPENCODE_ADAPTER,
    ),
];

pub fn runtime_adapter(provider_id: &str) -> Option<&'static dyn AgentRuntimeAdapter> {
    ADAPTERS
        .iter()
        .find(|(id, _)| *id == provider_id)
        .map(|(_, adapter)| *adapter)
}

/// Find the adapter that claims a given model string (for auto-routing).
pub fn adapter_for_model(model: &str) -> Option<(&'static str, &'static dyn AgentRuntimeAdapter)> {
    ADAPTERS
        .iter()
        .find(|(_, adapter)| adapter.accepts_model(model))
        .map(|(id, adapter)| (*id, *adapter))
}

/// Resolve the effective provider for a (configured_provider, model) pair.
///
/// Users commonly change *just* the model — e.g. at project level they pick
/// `openai/gpt-5.4` — without touching the provider setting, which stays at
/// the default. When that happens, route to the adapter that owns the model
/// so the agent actually spawns on the right backend. Explicit non-default
/// provider choices are always preserved.
pub fn resolve_effective_provider(provider_id: String, model: Option<&str>) -> String {
    if provider_id == DEFAULT_PROVIDER {
        if let Some(model) = model {
            if let Some((adapter_id, _)) = adapter_for_model(model) {
                return adapter_id.to_string();
            }
        }
    }
    provider_id
}

/// Merge user-contributed `extra_models` into an adapter's model list. User
/// entries win on id collision so descriptions and labels can be overridden.
fn merge_extra_models(
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

pub async fn provider_catalog_live(read_pool: &SqlitePool) -> AgentCatalogResponse {
    let providers = futures::future::join_all(ADAPTERS.iter().map(|(_, adapter)| async move {
        let mut entry = adapter.catalog_entry_live().await;
        let extra = adapter.extra_models(read_pool).await;
        if !extra.is_empty() {
            entry.models = merge_extra_models(entry.models, extra);
        }
        entry
    }))
    .await;

    AgentCatalogResponse {
        default_provider: DEFAULT_PROVIDER.to_string(),
        providers,
    }
}

pub async fn provider_default_model(provider_id: &str) -> Option<String> {
    if let Some(adapter) = runtime_adapter(provider_id) {
        return adapter.default_model_id().await;
    }

    None
}

pub fn spawn_runtime_startup_warmups() {
    for (_, adapter) in ADAPTERS {
        adapter.spawn_startup_warmup();
    }
}

pub async fn notify_worktree_created_for_all_providers(
    source_project_path: &std::path::Path,
    worktree_path: &std::path::Path,
) -> Result<(), super::adapter::RuntimeError> {
    futures::future::try_join_all(
        ADAPTERS
            .iter()
            .map(|(_, adapter)| adapter.on_worktree_created(source_project_path, worktree_path)),
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
    runtime_adapter(provider_id)?
        .session_finished_text(runtime_session_id)
        .await
}

#[cfg(test)]
mod tests {
    use super::{
        adapter_for_model, merge_extra_models, notify_worktree_created_for_all_providers,
        resolve_effective_provider, runtime_adapter, ADAPTERS,
    };
    use crate::domain::agents::runtime::ModelCatalogEntry;

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
    fn runtime_adapter_registry_has_claude_opencode_and_codex() {
        assert!(runtime_adapter("claude_code").is_some());
        assert!(runtime_adapter("opencode").is_some());
        assert!(runtime_adapter("codex_cli").is_some());
        assert!(runtime_adapter("unknown").is_none());
    }

    #[test]
    fn adapter_for_model_routes_opencode_refs() {
        let (id, _) = adapter_for_model("openai/gpt-5.4").expect("should find opencode adapter");
        assert_eq!(id, "opencode");
    }

    #[test]
    fn adapter_for_model_routes_github_copilot_refs_to_opencode() {
        let (id, _) = adapter_for_model("github-copilot/claude-opus-4.6")
            .expect("should find opencode adapter");
        assert_eq!(id, "opencode");
    }

    #[test]
    fn adapter_for_model_routes_bare_gpt_models_to_codex() {
        let (id, _) = adapter_for_model("gpt-5.4").expect("should find codex adapter");
        assert_eq!(id, "codex_cli");
    }

    #[test]
    fn adapter_for_model_returns_none_for_plain_claude_models() {
        assert!(adapter_for_model("claude-opus-4-6").is_none());
    }

    #[test]
    fn all_adapters_have_catalog_entries() {
        for (id, adapter) in ADAPTERS {
            let entry = adapter.catalog_entry();
            assert_eq!(&entry.id, id, "catalog entry id mismatch for {id}");
        }
    }

    #[test]
    fn resolve_effective_provider_reroutes_default_when_model_belongs_to_other_adapter() {
        let routed = resolve_effective_provider("claude_code".to_string(), Some("openai/gpt-5.4"));
        assert_eq!(routed, "opencode");
    }

    #[test]
    fn resolve_effective_provider_reroutes_default_for_github_copilot_models() {
        let routed = resolve_effective_provider(
            "claude_code".to_string(),
            Some("github-copilot/claude-opus-4.6"),
        );
        assert_eq!(routed, "opencode");
    }

    #[test]
    fn resolve_effective_provider_preserves_default_for_native_claude_model() {
        let routed = resolve_effective_provider("claude_code".to_string(), Some("claude-opus-4-6"));
        assert_eq!(routed, "claude_code");
    }

    #[test]
    fn resolve_effective_provider_preserves_explicit_non_default_provider() {
        // User explicitly chose opencode — don't rewrite even if the model looks claude-ish
        let routed = resolve_effective_provider("opencode".to_string(), Some("claude-opus-4-6"));
        assert_eq!(routed, "opencode");
    }

    #[test]
    fn resolve_effective_provider_without_model_is_passthrough() {
        let routed = resolve_effective_provider("claude_code".to_string(), None);
        assert_eq!(routed, "claude_code");
    }

    #[tokio::test]
    async fn notify_worktree_created_runs_all_provider_copy_policies() {
        let source = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(source.path().join(".claude"))
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
