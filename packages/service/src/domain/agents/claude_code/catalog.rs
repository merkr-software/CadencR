use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::agents::discovery::cli_not_found_message;
use crate::domain::agents::runtime::ModelCatalogEntry;
use crate::shared::keyed_locks::KeyedLocks;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
        self.load_models_with(env, |env| async move {
            let cwd = std::env::temp_dir().to_string_lossy().into_owned();
            claude_agent_sdk_rs::supported_models_with_env(&cwd, None, env)
                .await
                .map(|models| models.into_iter().map(sdk_model_to_catalog_entry).collect())
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// The catalog under `env`, asking the CLI through `probe` when no live
    /// or recently failed answer is cached for it. `probe_state` is never held
    /// while the CLI answers, so a slow probe blocks only the readers of the
    /// same profile, which wait for it rather than spawn their own.
    async fn load_models_with<F, Fut>(
        &self,
        env: Option<HashMap<String, String>>,
        probe: F,
    ) -> Vec<ModelCatalogEntry>
    where
        F: FnOnce(Option<HashMap<String, String>>) -> Fut,
        Fut: Future<Output = Result<Vec<ModelCatalogEntry>, RuntimeError>>,
    {
        let cache_key = model_probe_cache_key(env.as_ref());
        if self.needs_model_probe(cache_key).await {
            let flight = self
                .model_probe_flights
                .get_or_init(KeyedLocks::default)
                .lock_for(&cache_key)
                .await;
            let _flight = flight.lock().await;
            // A probe of this profile that ran while we waited answered for us.
            if self.needs_model_probe(cache_key).await {
                let result = probe(env).await;
                let probed = result
                    .as_ref()
                    .ok()
                    .filter(|models| !models.is_empty())
                    .cloned();
                let mut guard = self.probe_state.lock().await;
                apply_model_probe_result(self.models_cell(), &mut guard, cache_key, result);
                if let Some(models) = probed {
                    return models;
                }
            }
        }
        // Read under the state lock: another profile's probe writes the cell
        // under it too, so the cell matches `live_key` here.
        let guard = self.probe_state.lock().await;
        let cached = (guard.live_key == Some(cache_key))
            .then(|| self.models_cell().read().ok().map(|models| models.clone()))
            .flatten();
        drop(guard);
        cached.unwrap_or_else(fallback_models)
    }

    async fn needs_model_probe(&self, cache_key: ModelProbeCacheKey) -> bool {
        let guard = self.probe_state.lock().await;
        guard.live_key != Some(cache_key) && guard.recent_failure_message(cache_key).is_none()
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

    fn profile_env(name: &str) -> Option<HashMap<String, String>> {
        Some(HashMap::from([(
            "ANTHROPIC_BASE_URL".to_string(),
            name.to_string(),
        )]))
    }

    /// Finding: the probe ran under `probe_state`, so one slow CLI froze every
    /// other profile's catalog and even the failure-status read.
    #[tokio::test]
    async fn a_slow_probe_blocks_neither_another_profile_nor_status_reads() {
        let adapter: &'static ClaudeCodeAdapter = Box::leak(Box::new(new_test_adapter()));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let held = std::sync::Arc::clone(&release);
        let slow = tokio::spawn(
            adapter.load_models_with(profile_env("a"), move |_| async move {
                let _ = started_tx.send(());
                held.notified().await;
                Ok(vec![ModelCatalogEntry::alias("model-a", "A")])
            }),
        );
        started_rx.await.unwrap();

        let within = std::time::Duration::from_secs(2);
        let other = tokio::time::timeout(
            within,
            adapter.load_models_with(profile_env("b"), |_| async {
                Ok(vec![ModelCatalogEntry::alias("model-b", "B")])
            }),
        )
        .await
        .expect("profile b waited for profile a's probe");
        assert_eq!(other[0].id, "model-b");
        tokio::time::timeout(within, adapter.model_probe_failure_message(None))
            .await
            .expect("the status read waited for the probe");

        release.notify_one();
        assert_eq!(slow.await.unwrap()[0].id, "model-a");
    }

    #[tokio::test]
    async fn readers_of_one_profile_share_its_probe() {
        let adapter: &'static ClaudeCodeAdapter = Box::leak(Box::new(new_test_adapter()));
        let probes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let readers = (0..4).map(|_| {
            let probes = std::sync::Arc::clone(&probes);
            tokio::spawn(
                adapter.load_models_with(profile_env("a"), move |_| async move {
                    probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    Ok(vec![ModelCatalogEntry::alias("model-a", "A")])
                }),
            )
        });
        for reader in readers.collect::<Vec<_>>() {
            assert_eq!(reader.await.unwrap()[0].id, "model-a");
        }
        assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 1);
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
