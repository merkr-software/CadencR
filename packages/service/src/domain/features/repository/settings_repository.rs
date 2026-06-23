use sqlx::{AssertSqlSafe, SqlitePool};

use super::super::models::{FeatureModelSettings, FeatureProviderSettings, FeatureSetting};
use crate::domain::agents::runtime::{runtime_setting_key, validate_agent_type};
use crate::error::AppError;

pub async fn get_feature_settings(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Vec<FeatureSetting>, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as(r#"SELECT model_session FROM features WHERE id = ?"#)
            .bind(feature_id)
            .fetch_optional(pool)
            .await?;

    let provider_row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT agent_runtime_session FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_optional(pool)
            .await?;

    let mut result = Vec::new();
    if let Some((session,)) = row {
        let columns = [("model_session", session)];
        for (key, val) in columns {
            if let Some(v) = val {
                result.push(FeatureSetting {
                    key: key.to_string(),
                    value: v,
                });
            }
        }
    }

    if let Some((runtime_session,)) = provider_row {
        let columns = [("agent_runtime_session", runtime_session)];
        for (key, val) in columns {
            if let Some(v) = val {
                result.push(FeatureSetting {
                    key: key.to_string(),
                    value: v,
                });
            }
        }
    }

    let settings: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM feature_settings WHERE feature_id = ?")
            .bind(feature_id)
            .fetch_all(pool)
            .await?;
    for (key, value) in settings {
        result.push(FeatureSetting { key, value });
    }

    Ok(result)
}

pub async fn set_feature_setting(
    pool: &SqlitePool,
    feature_id: i64,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    let real_columns = ["model_session", "agent_runtime_session"];

    if real_columns.contains(&key) {
        let sql = format!(r#"UPDATE features SET "{}" = ? WHERE id = ?"#, key);
        sqlx::query(AssertSqlSafe(sql))
            .bind(value)
            .bind(feature_id)
            .execute(pool)
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?) ON CONFLICT(feature_id, key) DO UPDATE SET value = excluded.value",
        )
        .bind(feature_id)
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn get_feature_model_settings(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<FeatureModelSettings, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT model_session FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_optional(pool)
            .await?;

    let (session,) = row.unwrap_or_default();

    Ok(FeatureModelSettings {
        session: session.unwrap_or_default(),
    })
}

pub async fn set_feature_model_setting(
    pool: &SqlitePool,
    feature_id: i64,
    model_type: &str,
    model: &str,
) -> Result<(), AppError> {
    if !validate_agent_type(model_type) {
        return Err(AppError::BadRequest(format!(
            "Invalid model type: {}",
            model_type
        )));
    }
    crate::domain::agents::runtime::reject_workspace_only(model_type, "feature")?;
    let col = format!("model_{}", model_type);
    let sql = format!(r#"UPDATE features SET "{}" = ? WHERE id = ?"#, col);
    sqlx::query(AssertSqlSafe(sql))
        .bind(model)
        .bind(feature_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_feature_provider_settings(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<FeatureProviderSettings, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT agent_runtime_session FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_optional(pool)
            .await?;

    let (session,) = row.unwrap_or_default();

    // Return empty strings (not provider defaults) for unset fields so the
    // frontend inheritance cascade can distinguish "inherit from parent" from
    // "explicit override to claude_code". `auto_name` has no feature-level
    // override column — it's intentionally a workspace-only agent type, so
    // it always inherits (empty string).
    Ok(FeatureProviderSettings {
        session: session.unwrap_or_default(),
        auto_name: String::new(),
    })
}

pub async fn set_feature_provider_setting(
    pool: &SqlitePool,
    feature_id: i64,
    provider_type: &str,
    provider: &str,
) -> Result<(), AppError> {
    if !validate_agent_type(provider_type) {
        return Err(AppError::BadRequest(format!(
            "Invalid provider type: {}",
            provider_type
        )));
    }
    crate::domain::agents::runtime::reject_workspace_only(provider_type, "feature")?;
    let col = runtime_setting_key(provider_type);
    let sql = format!(r#"UPDATE features SET "{}" = ? WHERE id = ?"#, col);
    sqlx::query(AssertSqlSafe(sql))
        .bind(provider)
        .bind(feature_id)
        .execute(pool)
        .await?;
    Ok(())
}
