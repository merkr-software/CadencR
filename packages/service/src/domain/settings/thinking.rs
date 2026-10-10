use sqlx::SqlitePool;

use super::thinking_effort_model_default;
use crate::domain::agents::providers::{model_supports_thinking_level, runtime_adapter};
use crate::domain::agents::runtime::ModelCatalogEntry;

/// Thinking level a provider/model pair should run at when nothing explicit
/// was requested: the user's last selection for that pair, else the level the
/// CLI advertises as its default. A model without effort support gets none.
///
/// Providers that inherit profile config get no catalog fallback: leaving the
/// level unset lets the profile's own configured level apply, which pinning
/// the model's catalog default would silently override.
///
/// Spawn, model switches, and provider switches all resolve through here so
/// they agree on what "the last used level" means.
pub async fn target_thinking_effort(
    pool: &SqlitePool,
    provider_id: &str,
    model: &ModelCatalogEntry,
) -> Option<String> {
    if model.supports_effort == Some(false)
        || model
            .supported_effort_levels
            .as_ref()
            .is_some_and(Vec::is_empty)
    {
        return None;
    }
    let last_used = thinking_effort_model_default(pool, provider_id, &model.id).await;
    let inherits_profile = runtime_adapter(provider_id)
        .is_some_and(|adapter| adapter.supports_profile_config_inheritance());
    select_omitted_level(model, last_used, inherits_profile)
}

fn select_omitted_level(
    model: &ModelCatalogEntry,
    last_used: Option<String>,
    inherits_profile: bool,
) -> Option<String> {
    if let Some(level) = last_used
        .as_deref()
        .map(str::trim)
        .filter(|level| !level.is_empty())
    {
        if model_supports_thinking_level(model, level) != Some(false) {
            return Some(level.to_string());
        }
    }
    if inherits_profile {
        return None;
    }

    model
        .default_effort_level
        .clone()
        .filter(|level| model_supports_thinking_level(model, level) != Some(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effort_model(default_effort_level: Option<&str>) -> ModelCatalogEntry {
        ModelCatalogEntry {
            id: "target-model".to_string(),
            label: "Target Model".to_string(),
            description: None,
            supports_effort: Some(true),
            supported_effort_levels: Some(vec!["low".to_string(), "high".to_string()]),
            default_effort_level: default_effort_level.map(ToOwned::to_owned),
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        }
    }

    #[test]
    fn omitted_level_prefers_target_models_last_used_level() {
        let selected =
            select_omitted_level(&effort_model(Some("low")), Some("high".to_string()), false);

        assert_eq!(selected.as_deref(), Some("high"));
    }

    #[test]
    fn omitted_level_uses_cli_default_for_unused_model() {
        let selected = select_omitted_level(&effort_model(Some("low")), None, false);

        assert_eq!(selected.as_deref(), Some("low"));
    }

    #[test]
    fn stale_last_used_level_falls_back_to_cli_default() {
        let selected = select_omitted_level(
            &effort_model(Some("low")),
            Some("removed-level".to_string()),
            false,
        );

        assert_eq!(selected.as_deref(), Some("low"));
    }

    #[test]
    fn blank_last_used_level_falls_back_to_cli_default() {
        let selected =
            select_omitted_level(&effort_model(Some("low")), Some("  ".to_string()), false);

        assert_eq!(selected.as_deref(), Some("low"));
    }

    #[test]
    fn profile_inheriting_provider_keeps_last_used_but_skips_catalog_default() {
        let model = effort_model(Some("low"));

        assert_eq!(
            select_omitted_level(&model, Some("high".to_string()), true).as_deref(),
            Some("high")
        );
        assert_eq!(select_omitted_level(&model, None, true), None);
    }

    #[tokio::test]
    async fn target_is_none_for_model_without_effort_support() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let mut model = effort_model(Some("low"));
        model.supports_effort = Some(false);

        assert_eq!(
            target_thinking_effort(&pool, "target-provider", &model).await,
            None
        );
    }
}
