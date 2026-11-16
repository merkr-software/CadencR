//! The model id Cadencr hands the Claude CLI, at spawn and on a live switch.

use std::collections::HashMap;
use std::sync::Mutex;

use super::catalog::{model_probe_cache_key, ModelProbeCacheKey};
use super::model_alias::{pin_model_alias, resolve_model_alias};
use super::ClaudeCodeAdapter;
use crate::domain::agents::runtime::ModelCatalogEntry;

/// `value → resolvedModel` of each profile's catalog, keyed like the catalog
/// cache. One entry per profile env ever probed: a handful at most.
pub(super) type ResolvedModels = Mutex<HashMap<ModelProbeCacheKey, HashMap<String, String>>>;

/// The profile's model catalog as the CLI reported it when the runtime was
/// spawned. A session keeps it so a live `set_model` translates ids exactly
/// like the spawn did; a profile change respawns, which takes a new one.
#[derive(Debug, Clone, Default)]
pub(super) struct CliModelResolver {
    catalog: Vec<ModelCatalogEntry>,
    /// Empty while the profile's catalog is not loaded: aliases then pass
    /// through unchanged rather than guessing an id.
    resolved: HashMap<String, String>,
}

impl CliModelResolver {
    /// The id to pass the CLI for the stored model `requested`. The stored
    /// model (and so the picker's label) is unchanged; only the wire id is.
    pub(super) fn resolve(&self, requested: &str) -> String {
        let model = resolve_model_alias(requested, &self.catalog);
        let resolved = pin_model_alias(&model, &self.resolved).map_or(model, str::to_string);
        if resolved != requested {
            tracing::debug!(
                %requested,
                %resolved,
                "rewrote Claude model alias to concrete catalog id for active profile"
            );
        }
        resolved
    }
}

impl ClaudeCodeAdapter {
    /// Probing with the profile env hits the same cache key the settings
    /// catalog populated, so this is a cache read in the common case.
    pub(super) async fn cli_model_resolver(
        &self,
        env: Option<HashMap<String, String>>,
    ) -> CliModelResolver {
        let cache_key = model_probe_cache_key(env.as_ref());
        let catalog = self.load_models_with_env(env).await;
        // Only the resolutions of the catalog just returned: a fallback list
        // (probe failed) comes with none.
        let live = self.probe_state.lock().await.live_key == Some(cache_key);
        let resolved = live
            .then(|| {
                self.resolved_models_cell()
                    .lock()
                    .ok()?
                    .get(&cache_key)
                    .cloned()
            })
            .flatten()
            .unwrap_or_default();
        CliModelResolver { catalog, resolved }
    }

    /// Keep what a successful probe of `cache_key` said each id resolves to.
    pub(super) fn record_resolved_models(
        &self,
        cache_key: ModelProbeCacheKey,
        models: &[claude_agent_sdk_rs::ModelInfo],
    ) {
        let resolved = models
            .iter()
            .filter_map(|model| Some((model.value.clone(), model.resolved_model.clone()?)))
            .collect();
        if let Ok(mut cell) = self.resolved_models_cell().lock() {
            cell.insert(cache_key, resolved);
        }
    }

    fn resolved_models_cell(&self) -> &ResolvedModels {
        self.resolved_models.get_or_init(Default::default)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use crate::domain::agents::adapter::RuntimeError;
    use crate::domain::agents::claude_code::test_support::new_test_adapter;

    fn cli_rows() -> Vec<claude_agent_sdk_rs::ModelInfo> {
        serde_json::from_value(json!([
            {"value": "default", "resolvedModel": "claude-haiku-5-5", "displayName": "Default (recommended)"},
            {"value": "haiku", "resolvedModel": "claude-haiku-5-5", "displayName": "Haiku 5.5"},
            {"value": "opus[1m]", "resolvedModel": "claude-opus-5-5[1m]", "displayName": "Opus (1M context)"},
            {"value": "sonnet", "displayName": "Sonnet"},
        ]))
        .expect("CLI model rows")
    }

    #[tokio::test]
    async fn resolves_through_the_profile_catalog_and_keeps_its_labels() {
        let adapter = new_test_adapter();
        let catalog = adapter
            .load_sdk_models_with(None, |_| async { Ok(cli_rows()) })
            .await;
        // The picker keeps listing the alias under its label.
        assert!(catalog
            .iter()
            .any(|m| m.id == "haiku" && m.label == "Haiku 5.5"));

        let models = adapter.cli_model_resolver(None).await;
        assert_eq!(models.resolve("haiku"), "claude-haiku-5-5");
        assert_eq!(models.resolve("default"), "default");
        assert_eq!(models.resolve("opus[1m]"), "opus[1m]");
        // An older CLI that reports no resolution leaves the alias alone.
        assert_eq!(models.resolve("sonnet"), "sonnet");
    }

    #[tokio::test]
    async fn keeps_aliases_while_the_profile_catalog_is_not_loaded() {
        let adapter = new_test_adapter();
        let bedrock = Some(HashMap::from([(
            "CLAUDE_CODE_USE_BEDROCK".to_string(),
            "1".to_string(),
        )]));
        adapter
            .load_sdk_models_with(None, |_| async { Ok(cli_rows()) })
            .await;
        // Another profile's probe fails (and stays failed for its TTL): its
        // resolutions are unknown, and the Anthropic profile's must not leak.
        adapter
            .load_sdk_models_with(bedrock.clone(), |_| async {
                Err(RuntimeError::Generic("probe failed".to_string()))
            })
            .await;
        let models = adapter.cli_model_resolver(bedrock).await;
        assert_eq!(models.resolve("haiku"), "haiku");
    }
}
