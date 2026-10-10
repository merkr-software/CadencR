use crate::app_state::AppState;
use crate::domain::agents::providers::validate_thinking_level_or_error;
use crate::domain::agents::runtime::ModelCatalogEntry;
use crate::domain::settings;
use crate::error::AppError;

use super::trimmed_optional;

pub(super) async fn resolve(
    state: &AppState,
    effective_provider: &str,
    model: Option<ModelCatalogEntry>,
    requested_level: Option<&str>,
) -> Result<Option<String>, AppError> {
    if let Some(thinking_level) = trimmed_optional(requested_level) {
        if let Some(model) = model.as_ref() {
            validate_thinking_level_or_error(effective_provider, model, &thinking_level)
                .map_err(|error| AppError::BadRequest(error.to_string()))?;
        }
        return Ok(Some(thinking_level));
    }

    let Some(model) = model else {
        return Ok(None);
    };
    Ok(settings::target_thinking_effort(&state.read_pool, effective_provider, &model).await)
}

#[cfg(test)]
mod tests {
    use crate::domain::settings;

    #[tokio::test]
    async fn stored_level_is_scoped_to_target_provider_and_model() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::domain::settings_store::global_set(
            &settings::thinking_effort_model_key("target-provider", "target-model"),
            "high",
        )
        .await
        .unwrap();
        crate::domain::settings_store::global_set(
            &settings::thinking_effort_model_key("other-provider", "target-model"),
            "low",
        )
        .await
        .unwrap();

        let selected =
            settings::thinking_effort_model_default(&pool, "target-provider", "target-model").await;

        assert_eq!(selected.as_deref(), Some("high"));
    }
}
