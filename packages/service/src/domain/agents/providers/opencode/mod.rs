//! OpenCode provider catalog & model lookup.
//!
//! The live catalog comes from a short-lived `opencode models --verbose`
//! probe. It lists local OpenCode config/cache data without starting an
//! agent session. Results are cached with a 30s TTL (see `cache.rs`).

mod cache;
mod probe;

use std::collections::HashMap;

use opencode_sdk_rs::ConfigProvidersResponse;

use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

const PROVIDER_ID: &str = "opencode";
const PROVIDER_LABEL: &str = "OpenCode";
const FALLBACK_MODEL_ID: &str = "default/default";
const OPENCODE_FALLBACK_CONTEXT_WINDOW: u64 = 200_000;
const OPENAI_REASONING_EFFORT_LEVELS: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// Static catalog used before the live probe has run (and as the
/// failure fallback inside `cache::live_catalog_entry_with`).
pub(crate) fn catalog_entry() -> ProviderCatalogEntry {
    ProviderCatalogEntry {
        id: PROVIDER_ID.to_string(),
        label: PROVIDER_LABEL.to_string(),
        status: ProviderStatus::Available,
        status_message: None,
        models: vec![ModelCatalogEntry {
            id: FALLBACK_MODEL_ID.to_string(),
            label: "Default".to_string(),
            description: None,
            supports_effort: Some(false),
            supported_effort_levels: None,
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        }],
        modes: Vec::new(),
        default_model: Some(FALLBACK_MODEL_ID.to_string()),
    }
}

pub(crate) async fn catalog_entry_live() -> ProviderCatalogEntry {
    (*cache::live_catalog().await).clone()
}

pub(crate) async fn context_window_for_model(model_id: &str) -> Option<u64> {
    let entry = cache::live_catalog_entry().await;
    Some(
        entry
            .context_windows
            .get(model_id)
            .copied()
            .unwrap_or(OPENCODE_FALLBACK_CONTEXT_WINDOW),
    )
}

pub(crate) async fn default_model_id() -> Option<String> {
    cache::live_catalog().await.default_model.clone()
}

/// Provider-specific shaping of the wire response. Returns the
/// FE-facing catalog + a `model id → context window` lookup table the
/// cache stores alongside it.
///
/// opencode's wire-side `default` is `{ providerID → modelID }` (one
/// entry per provider). Cadencr's catalog wants a single default, so
/// we pick the first model whose `providerID/modelID` matches an
/// entry in that map — a single pass over the providers builds both
/// the model list and resolves the default in one shot.
fn catalog_from_response(
    response: ConfigProvidersResponse,
) -> (ProviderCatalogEntry, HashMap<String, u64>) {
    let mut models = Vec::new();
    let mut context_windows = HashMap::new();
    let mut default_model_from_wire = None;
    for provider in &response.providers {
        let provider_label = provider
            .name
            .clone()
            .unwrap_or_else(|| provider_display_label(&provider.id));
        let wire_default = response.default.get(&provider.id);
        for model in &provider.models {
            let id = format!("{}/{}", provider.id, model.id);
            let model_label = model.name.clone().unwrap_or_else(|| model.id.clone());
            if let Some(context) = model.limit.as_ref().and_then(|limit| limit.context) {
                context_windows.insert(id.clone(), context);
            }
            if default_model_from_wire.is_none() && wire_default == Some(&model.id) {
                default_model_from_wire = Some(id.clone());
            }
            let supported_effort_levels = opencode_supported_effort_levels(&provider.id, &model.id);
            models.push(ModelCatalogEntry {
                id,
                label: format!("{provider_label}: {model_label}"),
                description: None,
                supports_effort: Some(supported_effort_levels.is_some()),
                supported_effort_levels,
                supports_adaptive_thinking: None,
                supports_fast_mode: None,
                supports_auto_mode: None,
            });
        }
    }

    let default_model = default_model_from_wire
        .or_else(|| models.first().map(|model| model.id.clone()))
        .or_else(|| Some(FALLBACK_MODEL_ID.to_string()));

    let catalog = ProviderCatalogEntry {
        id: PROVIDER_ID.to_string(),
        label: PROVIDER_LABEL.to_string(),
        status: ProviderStatus::Available,
        status_message: None,
        models,
        modes: Vec::new(),
        default_model,
    };
    (catalog, context_windows)
}

fn provider_display_label(provider_id: &str) -> String {
    match provider_id {
        "opencode" => "OpenCode".to_string(),
        "github-copilot" => "GitHub Copilot".to_string(),
        "openai" => "OpenAI".to_string(),
        _ => provider_id.to_string(),
    }
}

fn opencode_supported_effort_levels(provider_id: &str, model_id: &str) -> Option<Vec<String>> {
    let provider = provider_id.to_ascii_lowercase();
    let model = model_id.to_ascii_lowercase();
    let is_openai_reasoning_model = provider == "openai"
        && (model.starts_with("gpt-5")
            || model.starts_with("o1")
            || model.starts_with("o3")
            || model.starts_with("o4"));

    is_openai_reasoning_model.then(|| {
        OPENAI_REASONING_EFFORT_LEVELS
            .iter()
            .map(ToString::to_string)
            .collect()
    })
}

pub(crate) fn supports_effort_level_for_model_ref(model_ref: &str, effort: &str) -> bool {
    let Some((provider_id, model_id)) =
        crate::domain::agents::model_refs::parse_opencode_model_ref(model_ref)
    else {
        return false;
    };
    opencode_supported_effort_levels(provider_id, model_id)
        .is_some_and(|levels| levels.iter().any(|level| level == effort))
}

#[cfg(test)]
mod tests {
    use super::{
        catalog_entry, catalog_from_response, context_window_for_model, FALLBACK_MODEL_ID,
        OPENCODE_FALLBACK_CONTEXT_WINDOW,
    };
    use crate::domain::agents::runtime::ProviderStatus;
    use opencode_sdk_rs::ConfigProvidersResponse;
    use serde_json::json;

    use super::cache::TEST_LOCK;

    fn parse(value: serde_json::Value) -> ConfigProvidersResponse {
        serde_json::from_value(value).expect("fixture parses")
    }

    #[test]
    fn fallback_catalog_entry_is_available() {
        let entry = catalog_entry();
        assert_eq!(entry.id, "opencode");
        assert_eq!(entry.status, ProviderStatus::Available);
        assert_eq!(entry.default_model.as_deref(), Some(FALLBACK_MODEL_ID));
        assert!(entry
            .models
            .iter()
            .any(|model| model.id == FALLBACK_MODEL_ID));
    }

    #[test]
    fn fallback_catalog_has_only_provider_default_model() {
        let entry = catalog_entry();
        assert_eq!(entry.models.len(), 1);
        assert_eq!(entry.models[0].id, FALLBACK_MODEL_ID);
        assert_eq!(entry.models[0].supports_effort, Some(false));
        assert!(entry.models[0].supported_effort_levels.is_none());
    }

    #[test]
    fn catalog_from_response_uses_default_provider_model() {
        let response = parse(json!({
            "providers": [
                {
                    "id": "anthropic",
                    "name": "Anthropic",
                    "models": {
                        "claude-sonnet-4-5": {
                            "name": "Claude Sonnet 4.5",
                            "limit": { "context": 200000 }
                        },
                        "claude-haiku-4-5": {
                            "name": "Claude Haiku 4.5"
                        }
                    }
                }
            ],
            "default": { "anthropic": "claude-sonnet-4-5" }
        }));
        let (catalog, windows) = catalog_from_response(response);
        assert_eq!(
            catalog.default_model.as_deref(),
            Some("anthropic/claude-sonnet-4-5")
        );
        assert_eq!(catalog.models.len(), 2);
        let sonnet = catalog
            .models
            .iter()
            .find(|m| m.id == "anthropic/claude-sonnet-4-5")
            .expect("sonnet entry");
        assert_eq!(sonnet.label, "Anthropic: Claude Sonnet 4.5");
        assert_eq!(
            windows.get("anthropic/claude-sonnet-4-5").copied(),
            Some(200_000)
        );
        assert!(!windows.contains_key("anthropic/claude-haiku-4-5"));
    }

    #[test]
    fn catalog_from_response_marks_openai_reasoning_models_as_effort_capable() {
        let response = parse(json!({
            "providers": [
                {
                    "id": "openai",
                    "name": "OpenAI",
                    "models": {
                        "gpt-5.4": {
                            "name": "GPT-5.4",
                            "limit": { "context": 200000 }
                        }
                    }
                }
            ],
            "default": { "openai": "gpt-5.4" }
        }));
        let (catalog, _) = catalog_from_response(response);
        let model = catalog
            .models
            .iter()
            .find(|model| model.id == "openai/gpt-5.4")
            .expect("gpt-5.4 entry");
        assert_eq!(model.supports_effort, Some(true));
        let expected_levels = vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "xhigh".to_string(),
        ];
        assert_eq!(
            model.supported_effort_levels.as_deref(),
            Some(expected_levels.as_slice())
        );
    }

    #[test]
    fn supports_effort_level_for_model_ref_rejects_non_reasoning_models() {
        assert!(super::supports_effort_level_for_model_ref(
            "openai/gpt-5.5",
            "high"
        ));
        assert!(!super::supports_effort_level_for_model_ref(
            "openrouter/z-ai/glm-5.2",
            "high"
        ));
    }

    #[test]
    fn catalog_from_response_labels_known_providers_without_wire_names() {
        let response = parse(json!({
            "providers": [
                {
                    "id": "openai",
                    "models": {
                        "gpt-5.4": { "name": "GPT-5.4" }
                    }
                }
            ],
            "default": { "openai": "gpt-5.4" }
        }));
        let (catalog, _) = catalog_from_response(response);
        let model = catalog
            .models
            .iter()
            .find(|model| model.id == "openai/gpt-5.4")
            .expect("gpt-5.4 entry");
        assert_eq!(model.label, "OpenAI: GPT-5.4");
    }

    #[test]
    fn catalog_from_response_labels_github_copilot_without_wire_name() {
        let response = parse(json!({
            "providers": [
                {
                    "id": "github-copilot",
                    "models": {
                        "claude-opus-4.6": { "name": "Claude Opus 4.6" }
                    }
                }
            ],
            "default": { "github-copilot": "claude-opus-4.6" }
        }));
        let (catalog, _) = catalog_from_response(response);
        let model = catalog
            .models
            .iter()
            .find(|model| model.id == "github-copilot/claude-opus-4.6")
            .expect("copilot opus entry");
        assert_eq!(model.label, "GitHub Copilot: Claude Opus 4.6");
    }

    #[test]
    fn catalog_from_response_falls_back_to_first_model_when_default_missing() {
        let response = parse(json!({
            "providers": [
                {
                    "id": "local",
                    "models": { "default": {} }
                }
            ]
        }));
        let (catalog, _) = catalog_from_response(response);
        assert_eq!(catalog.default_model.as_deref(), Some("local/default"));
    }

    #[test]
    fn catalog_from_response_falls_back_to_static_when_empty() {
        let response = parse(json!({ "providers": [] }));
        let (catalog, windows) = catalog_from_response(response);
        assert_eq!(catalog.default_model.as_deref(), Some(FALLBACK_MODEL_ID));
        assert!(windows.is_empty());
    }

    #[tokio::test]
    async fn context_window_returns_cached_window_when_present() {
        let _guard = TEST_LOCK.lock().await;
        super::cache::reset_for_test().await;
        let probe = || async {
            Ok(parse(json!({
                "providers": [
                    {
                        "id": "anthropic",
                        "models": {
                            "claude-sonnet-4-5": { "limit": { "context": 250000 } }
                        }
                    }
                ]
            })))
        };
        // Seed the cache through the probe seam.
        let _ = super::cache::live_catalog_entry_with(probe).await;
        // Re-read via the public path which uses the same cache.
        let window = context_window_for_model("anthropic/claude-sonnet-4-5").await;
        assert_eq!(window, Some(250_000));
        super::cache::reset_for_test().await;
    }

    #[tokio::test]
    async fn context_window_falls_back_for_unknown_model() {
        let _guard = TEST_LOCK.lock().await;
        super::cache::reset_for_test().await;
        let probe = || async {
            Ok(parse(json!({
                "providers": [
                    {
                        "id": "anthropic",
                        "models": {
                            "claude-sonnet-4-5": { "limit": { "context": 250000 } }
                        }
                    }
                ]
            })))
        };
        let _ = super::cache::live_catalog_entry_with(probe).await;
        let window = context_window_for_model("unknown/model").await;
        assert_eq!(window, Some(OPENCODE_FALLBACK_CONTEXT_WINDOW));
        super::cache::reset_for_test().await;
    }
}
