//! User-added Claude Code models, merged into the live catalog.

use std::collections::HashSet;

use sqlx::{FromRow, SqlitePool};

use crate::domain::agents::runtime::ModelCatalogEntry;
use crate::error::AppError;

#[derive(Clone, Debug, Default)]
pub struct CustomModelEffort {
    pub supports_effort: Option<bool>,
    pub supported_effort_levels: Option<Vec<String>>,
    pub default_effort_level: Option<String>,
}

#[derive(FromRow)]
struct CustomModelRow {
    model_id: String,
    label: String,
    description: Option<String>,
    supports_effort: Option<bool>,
    supported_effort_levels_json: Option<String>,
    default_effort_level: Option<String>,
}

fn validate_model_id(model_id: &str) -> Result<(), AppError> {
    if model_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "custom model id must not be empty".to_string(),
        ));
    }
    Ok(())
}

fn validate_label(label: &str) -> Result<(), AppError> {
    if label.trim().is_empty() {
        return Err(AppError::BadRequest(
            "custom model label must not be empty".to_string(),
        ));
    }
    Ok(())
}

fn validate_effort(effort: CustomModelEffort) -> Result<CustomModelEffort, AppError> {
    if effort.supports_effort != Some(true) {
        return Ok(CustomModelEffort {
            supports_effort: effort.supports_effort,
            ..Default::default()
        });
    }
    let levels = effort.supported_effort_levels.unwrap_or_default();
    if levels.is_empty() {
        return Err(AppError::BadRequest(
            "effort-enabled custom models must declare non-empty supported effort levels".into(),
        ));
    }
    let mut normalized = Vec::with_capacity(levels.len());
    let mut seen = HashSet::with_capacity(levels.len());
    for level in levels {
        let level = level.trim().to_string();
        if level.is_empty() {
            return Err(AppError::BadRequest(
                "effort-enabled custom models must declare non-empty supported effort levels"
                    .into(),
            ));
        }
        if !seen.insert(level.clone()) {
            return Err(AppError::BadRequest(format!(
                "supported effort level '{level}' is duplicated"
            )));
        }
        normalized.push(level);
    }
    let default = effort
        .default_effort_level
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if default
        .as_ref()
        .is_some_and(|value| !normalized.contains(value))
    {
        return Err(AppError::BadRequest(
            "default effort level must be one of the supported effort levels".into(),
        ));
    }
    Ok(CustomModelEffort {
        supports_effort: Some(true),
        supported_effort_levels: Some(normalized),
        default_effort_level: default,
    })
}

fn row_to_entry(row: CustomModelRow) -> Result<ModelCatalogEntry, AppError> {
    let supported_effort_levels = row
        .supported_effort_levels_json
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                AppError::database(format!(
                    "invalid effort metadata for custom model '{}': {error}",
                    row.model_id
                ))
            })
        })
        .transpose()?;
    Ok(entry_from_parts(
        row.model_id,
        row.label,
        row.description,
        CustomModelEffort {
            supports_effort: row.supports_effort,
            supported_effort_levels,
            default_effort_level: row.default_effort_level,
        },
    ))
}

fn entry_from_parts(
    model_id: String,
    label: String,
    description: Option<String>,
    effort: CustomModelEffort,
) -> ModelCatalogEntry {
    ModelCatalogEntry {
        id: model_id,
        label,
        description,
        supports_effort: effort.supports_effort,
        supported_effort_levels: effort.supported_effort_levels,
        default_effort_level: effort.default_effort_level,
        supports_adaptive_thinking: None,
        supports_fast_mode: None,
        supports_auto_mode: None,
    }
}

pub async fn list_custom_models(pool: &SqlitePool) -> Result<Vec<ModelCatalogEntry>, AppError> {
    let rows = sqlx::query_as::<_, CustomModelRow>(
        "SELECT model_id, label, description, supports_effort, supported_effort_levels_json, \
         default_effort_level FROM claude_code_custom_models ORDER BY model_id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_entry).collect()
}

pub async fn upsert_custom_model(
    pool: &SqlitePool,
    model_id: &str,
    label: &str,
    description: Option<&str>,
    effort: CustomModelEffort,
) -> Result<ModelCatalogEntry, AppError> {
    validate_model_id(model_id)?;
    validate_label(label)?;
    let effort = validate_effort(effort)?;
    let levels_json = effort
        .supported_effort_levels
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| {
            AppError::internal(format!("failed to encode effort metadata: {error}"))
        })?;
    sqlx::query(
        "INSERT INTO claude_code_custom_models \
         (model_id, label, description, supports_effort, supported_effort_levels_json, default_effort_level) \
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(model_id) DO UPDATE SET label = excluded.label, \
         description = excluded.description, supports_effort = excluded.supports_effort, \
         supported_effort_levels_json = excluded.supported_effort_levels_json, \
         default_effort_level = excluded.default_effort_level",
    )
    .bind(model_id)
    .bind(label)
    .bind(description)
    .bind(effort.supports_effort)
    .bind(&levels_json)
    .bind(&effort.default_effort_level)
    .execute(pool)
    .await?;
    Ok(entry_from_parts(
        model_id.to_string(),
        label.to_string(),
        description.map(str::to_string),
        effort,
    ))
}

pub async fn delete_custom_model(pool: &SqlitePool, model_id: &str) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM claude_code_custom_models WHERE model_id = ?")
        .bind(model_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "custom model '{model_id}' not found"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE claude_code_custom_models (\
                id INTEGER PRIMARY KEY, \
                model_id TEXT NOT NULL UNIQUE, \
                label TEXT NOT NULL, \
                description TEXT, \
                supports_effort BOOLEAN, \
                supported_effort_levels_json TEXT, \
                default_effort_level TEXT, \
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn upsert_and_list_roundtrip() {
        let pool = setup().await;
        upsert_custom_model(
            &pool,
            "claude-sonnet-3-5",
            "Sonnet 3.5 (legacy)",
            Some("older model via proxy"),
            CustomModelEffort::default(),
        )
        .await
        .unwrap();

        let models = list_custom_models(&pool).await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-sonnet-3-5");
        assert_eq!(models[0].label, "Sonnet 3.5 (legacy)");
        assert_eq!(
            models[0].description.as_deref(),
            Some("older model via proxy")
        );
        // Capability flags default to None.
        assert!(models[0].supports_effort.is_none());
    }

    #[tokio::test]
    async fn upsert_replaces_existing_entry() {
        let pool = setup().await;
        upsert_custom_model(&pool, "m1", "Old", None, CustomModelEffort::default())
            .await
            .unwrap();
        upsert_custom_model(&pool, "m1", "New", Some("d"), CustomModelEffort::default())
            .await
            .unwrap();
        let models = list_custom_models(&pool).await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label, "New");
        assert_eq!(models[0].description.as_deref(), Some("d"));
    }

    #[tokio::test]
    async fn upsert_rejects_empty_fields() {
        let pool = setup().await;
        let err = upsert_custom_model(&pool, "   ", "label", None, CustomModelEffort::default())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
        let err = upsert_custom_model(&pool, "m1", "  ", None, CustomModelEffort::default())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn delete_removes_entry() {
        let pool = setup().await;
        upsert_custom_model(&pool, "m1", "M1", None, CustomModelEffort::default())
            .await
            .unwrap();
        delete_custom_model(&pool, "m1").await.unwrap();
        assert!(list_custom_models(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_missing_is_not_found() {
        let pool = setup().await;
        let err = delete_custom_model(&pool, "m1").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn effort_metadata_roundtrips_and_validates_default() {
        let pool = setup().await;
        let effort = CustomModelEffort {
            supports_effort: Some(true),
            supported_effort_levels: Some(vec!["low".into(), " high ".into(), "max".into()]),
            default_effort_level: Some("high".into()),
        };
        upsert_custom_model(&pool, "proxy-model", "Proxy", None, effort)
            .await
            .unwrap();
        let model = list_custom_models(&pool).await.unwrap().remove(0);
        assert_eq!(model.supports_effort, Some(true));
        assert_eq!(
            model.supported_effort_levels.as_deref(),
            Some(vec!["low".to_string(), "high".to_string(), "max".to_string()].as_slice())
        );
        assert_eq!(model.default_effort_level.as_deref(), Some("high"));

        let blank_default = CustomModelEffort {
            supports_effort: Some(true),
            supported_effort_levels: Some(vec!["low".into(), "high".into()]),
            default_effort_level: Some("   ".into()),
        };
        let model = upsert_custom_model(&pool, "proxy-model", "Proxy", None, blank_default)
            .await
            .unwrap();
        assert!(model.default_effort_level.is_none());

        let invalid = CustomModelEffort {
            supports_effort: Some(true),
            supported_effort_levels: Some(vec!["low".into()]),
            default_effort_level: Some("high".into()),
        };
        let error = upsert_custom_model(&pool, "proxy-model", "Proxy", None, invalid)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
    }
}
