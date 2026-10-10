use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::agents::discovery::cli_not_found_message;
use crate::domain::agents::runtime::ModelCatalogEntry;

use super::{ClaudeCodeAdapter, ProbeState};

pub(super) fn fallback_models() -> Vec<ModelCatalogEntry> {
    vec![
        ModelCatalogEntry::alias("opus", "Opus"),
        ModelCatalogEntry::alias("sonnet", "Sonnet"),
        ModelCatalogEntry::alias("haiku", "Haiku"),
    ]
}

pub(super) fn sdk_model_to_catalog_entry(
    model: claude_agent_sdk_rs::ModelInfo,
) -> ModelCatalogEntry {
    ModelCatalogEntry {
        id: model.value,
        label: model.display_name,
        description: model.description,
        supports_effort: model.supports_effort,
        supported_effort_levels: model.supported_effort_levels,
        default_effort_level: None,
        supports_adaptive_thinking: model.supports_adaptive_thinking,
        // Model capability metadata must describe controls Cadencr can
        // actually apply. Claude's transport does not expose a live fast-mode
        // setter yet, so do not surface the shared toggle for Claude models.
        supports_fast_mode: None,
        supports_auto_mode: model.supports_auto_mode,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ModelProbeCacheKey(u64);
const FAILED_PROBE_TTL: Duration = Duration::from_secs(30);

impl ProbeState {
    fn recent_failure_message(&self, cache_key: ModelProbeCacheKey) -> Option<&str> {
        if self.failed_key != Some(cache_key) {
            return None;
        }
        let failed_at = self.failed_at?;
        (failed_at.elapsed() < FAILED_PROBE_TTL)
            .then(|| self.failure_message.as_deref())
            .flatten()
    }

    fn record_failure(&mut self, cache_key: ModelProbeCacheKey, message: String) {
        self.failed_key = Some(cache_key);
        self.failed_at = Some(Instant::now());
        self.failure_message = Some(message);
    }

    fn clear_failure(&mut self) {
        self.failed_key = None;
        self.failed_at = None;
        self.failure_message = None;
    }
}

pub(super) fn model_probe_cache_key(env: Option<&HashMap<String, String>>) -> ModelProbeCacheKey {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let Some(env) = env.filter(|env| !env.is_empty()) else {
        0u8.hash(&mut hasher);
        return ModelProbeCacheKey(hasher.finish());
    };

    1u8.hash(&mut hasher);
    let mut entries = env.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(left, _)| *left);
    for (key, value) in entries {
        key.hash(&mut hasher);
        0xffu8.hash(&mut hasher);
        value.hash(&mut hasher);
        0xfeu8.hash(&mut hasher);
    }
    ModelProbeCacheKey(hasher.finish())
}

pub(super) fn apply_model_probe_result(
    cache: &std::sync::RwLock<Vec<ModelCatalogEntry>>,
    probe_state: &mut ProbeState,
    cache_key: ModelProbeCacheKey,
    result: Result<Vec<ModelCatalogEntry>, RuntimeError>,
) {
    match result {
        Ok(models) if !models.is_empty() => {
            if let Ok(mut cached_models) = cache.write() {
                *cached_models = models;
            }
            probe_state.live = true;
            probe_state.live_key = Some(cache_key);
            probe_state.clear_failure();
        }
        Ok(_) => {
            probe_state.record_failure(cache_key, "Claude Code returned no models".to_string());
            tracing::warn!("Claude Code CLI returned empty model list; retry is TTL-throttled");
        }
        Err(error @ RuntimeError::CliNotFound { .. }) => {
            let message = cli_not_found_message(&error).unwrap_or_else(|| error.to_string());
            probe_state.record_failure(cache_key, message);
        }
        Err(error) => {
            probe_state.record_failure(cache_key, format!("Claude Code unavailable: {error}"));
            tracing::warn!(
                error = %error,
                "Claude Code CLI model probe failed; retry is TTL-throttled"
            );
        }
    }
}

impl ClaudeCodeAdapter {
    /// Return the CLI's preferred default model ID (`"default"` if present,
    /// else the first model in the list).
    pub(super) async fn default_model_id(&self) -> Option<String> {
        self.default_model_id_with_env(None).await
    }

    /// Env-aware variant of [`default_model_id`]. Probes the catalog under the
    /// active profile env so the default is resolved against the same model
    /// list the picker shows — and crucially under the same cache key, so the
    /// default-model probe and the catalog probe never thrash the shared cell.
    pub(super) async fn default_model_id_with_env(
        &self,
        env: Option<HashMap<String, String>>,
    ) -> Option<String> {
        let models = self.load_models_with_env(env).await;
        Self::default_model_from(&models)
    }

    pub(super) fn models_cell(&self) -> &std::sync::RwLock<Vec<ModelCatalogEntry>> {
        self.cached_models
            .get_or_init(|| std::sync::RwLock::new(fallback_models()))
    }

    pub(super) async fn load_models(&self) -> Vec<ModelCatalogEntry> {
        self.load_models_with_env(None).await
    }

    pub(super) async fn load_models_with_env(
        &self,
        env: Option<HashMap<String, String>>,
    ) -> Vec<ModelCatalogEntry> {
        let cache_key = model_probe_cache_key(env.as_ref());
        let mut guard = self.probe_state.lock().await;
        if guard.live_key != Some(cache_key) && guard.recent_failure_message(cache_key).is_none() {
            let cwd = std::env::temp_dir().to_string_lossy().into_owned();
            let probe_result = claude_agent_sdk_rs::supported_models_with_env(&cwd, None, env)
                .await
                .map(|models| {
                    models
                        .into_iter()
                        .map(sdk_model_to_catalog_entry)
                        .collect::<Vec<_>>()
                })
                .map_err(RuntimeError::from);
            apply_model_probe_result(self.models_cell(), &mut guard, cache_key, probe_result);
        }
        let cache_matches_request = guard.live_key == Some(cache_key);
        drop(guard);
        if cache_matches_request {
            self.models_cell()
                .read()
                .map(|models| models.clone())
                .unwrap_or_else(|_| fallback_models())
        } else {
            fallback_models()
        }
    }

    pub(super) async fn model_probe_failure_message(
        &self,
        env: Option<&HashMap<String, String>>,
    ) -> Option<String> {
        let cache_key = model_probe_cache_key(env);
        let guard = self.probe_state.lock().await;
        if guard.live_key == Some(cache_key) {
            return None;
        }
        guard
            .recent_failure_message(cache_key)
            .map(ToString::to_string)
    }

    pub(super) fn default_model_from(models: &[ModelCatalogEntry]) -> Option<String> {
        models
            .iter()
            .find(|model| model.id == "default")
            .map(|model| model.id.clone())
            .or_else(|| models.first().map(|model| model.id.clone()))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::domain::agents::adapter::RuntimeError;
    use crate::domain::agents::runtime::ModelCatalogEntry;

    use super::{
        apply_model_probe_result, model_probe_cache_key, sdk_model_to_catalog_entry,
        ClaudeCodeAdapter, ProbeState,
    };

    use super::super::test_support::new_test_adapter;

    /// Regression for the catalog-cache thrash: the env-aware default-model
    /// resolution must read the catalog cached under the *same* profile env
    /// key, not re-probe with a different key. Here the cell is pre-seeded and
    /// marked live for the Bedrock env, so `default_model_id_with_env` must
    /// hit that cache (returning the Bedrock model) and leave `live_key`
    /// untouched — proving it can't clobber the picker's env-aware catalog.
    #[tokio::test]
    async fn default_model_id_with_env_reuses_catalog_cache_key() {
        let adapter = new_test_adapter();
        let mut env = HashMap::new();
        env.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        env.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            "us.anthropic.claude-sonnet-4-6".to_string(),
        );
        let env_key = model_probe_cache_key(Some(&env));

        {
            let mut cached = adapter.models_cell().write().expect("cache lock");
            *cached = vec![ModelCatalogEntry::alias(
                "us.anthropic.claude-sonnet-4-6",
                "Sonnet",
            )];
        }
        {
            let mut guard = adapter.probe_state.lock().await;
            guard.live_key = Some(env_key);
        }

        let default = adapter.default_model_id_with_env(Some(env)).await;
        assert_eq!(default.as_deref(), Some("us.anthropic.claude-sonnet-4-6"));

        // The cache stayed live for the Bedrock env key — no None-keyed re-probe.
        let guard = adapter.probe_state.lock().await;
        assert_eq!(guard.live_key, Some(env_key));
    }

    #[test]
    fn sdk_model_to_catalog_entry_maps_all_fields() {
        let sdk = claude_agent_sdk_rs::ModelInfo {
            value: "default".to_string(),
            display_name: "Default (recommended)".to_string(),
            description: Some("Opus 4.7 with 1M context".to_string()),
            supports_effort: Some(true),
            supported_effort_levels: Some(vec!["low".to_string(), "max".to_string()]),
            supports_adaptive_thinking: Some(true),
            supports_fast_mode: Some(true),
            supports_auto_mode: Some(true),
        };
        let entry = sdk_model_to_catalog_entry(sdk);
        assert_eq!(entry.id, "default");
        assert_eq!(entry.label, "Default (recommended)");
        assert_eq!(
            entry.description.as_deref(),
            Some("Opus 4.7 with 1M context")
        );
        assert_eq!(entry.supports_effort, Some(true));
        assert_eq!(entry.supports_auto_mode, Some(true));
        assert_eq!(entry.supports_fast_mode, None);
    }

    #[test]
    fn default_model_from_prefers_default_entry() {
        let models = vec![
            ModelCatalogEntry::alias("sonnet", "Sonnet"),
            ModelCatalogEntry::alias("default", "Default"),
        ];
        assert_eq!(
            ClaudeCodeAdapter::default_model_from(&models).as_deref(),
            Some("default")
        );
    }

    #[test]
    fn default_model_from_falls_back_to_first() {
        let models = vec![
            ModelCatalogEntry::alias("opus", "Opus"),
            ModelCatalogEntry::alias("haiku", "Haiku"),
        ];
        assert_eq!(
            ClaudeCodeAdapter::default_model_from(&models).as_deref(),
            Some("opus")
        );
    }

    #[test]
    fn apply_model_probe_result_marks_cache_live_on_success() {
        let adapter = new_test_adapter();
        let mut probe_state = ProbeState::default();
        let cache_key = model_probe_cache_key(None);

        apply_model_probe_result(
            adapter.models_cell(),
            &mut probe_state,
            cache_key,
            Ok(vec![ModelCatalogEntry::alias("default", "Default")]),
        );

        let cached = adapter.models_cell().read().expect("cache lock");
        assert_eq!(probe_state.live_key, Some(cache_key));
        assert_eq!(cached[0].id, "default");
    }

    #[test]
    fn apply_model_probe_result_keeps_fallback_models_when_empty() {
        let adapter = new_test_adapter();
        let mut probe_state = ProbeState::default();

        apply_model_probe_result(
            adapter.models_cell(),
            &mut probe_state,
            model_probe_cache_key(None),
            Ok(vec![]),
        );

        let cached = adapter.models_cell().read().expect("cache lock");
        assert!(probe_state.live_key.is_none());
        assert_eq!(cached[0].id, "opus");
    }

    #[test]
    fn apply_model_probe_result_keeps_fallback_models_on_error() {
        let adapter = new_test_adapter();
        let mut probe_state = ProbeState::default();

        apply_model_probe_result(
            adapter.models_cell(),
            &mut probe_state,
            model_probe_cache_key(None),
            Err(RuntimeError::new("boom")),
        );

        let cached = adapter.models_cell().read().expect("cache lock");
        assert!(probe_state.live_key.is_none());
        assert!(probe_state.failure_message.is_some());
        assert_eq!(cached[0].id, "opus");
    }

    #[test]
    fn model_probe_cache_key_is_stable_for_env_ordering() {
        let mut env_a = HashMap::new();
        env_a.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        env_a.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            "us.anthropic.claude-sonnet-4-6".to_string(),
        );
        let mut env_b = HashMap::new();
        env_b.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            "us.anthropic.claude-sonnet-4-6".to_string(),
        );
        env_b.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());

        assert_eq!(
            model_probe_cache_key(Some(&env_a)),
            model_probe_cache_key(Some(&env_b))
        );
    }

    #[test]
    fn model_probe_cache_key_changes_when_env_value_changes() {
        let mut env_a = HashMap::new();
        env_a.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            "us.anthropic.claude-sonnet-4-6".to_string(),
        );
        let mut env_b = HashMap::new();
        env_b.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            "us.anthropic.claude-sonnet-4-7".to_string(),
        );

        assert_ne!(
            model_probe_cache_key(Some(&env_a)),
            model_probe_cache_key(Some(&env_b))
        );
    }
}
