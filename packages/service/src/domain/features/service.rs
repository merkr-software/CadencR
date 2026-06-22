use std::collections::HashMap;

use sqlx::SqlitePool;

use super::models::{
    CreateFeatureResponse, Feature, FeatureActivity, FeatureModelSettings, FeatureProviderSettings,
    FeatureSetting, FeatureStatus, IsEmptyResponse, WorkingDirResponse,
};
use super::repository;
use crate::error::AppError;

pub async fn list_by_project(
    pool: &SqlitePool,
    project_id: i64,
    include_archived: bool,
) -> Result<Vec<Feature>, AppError> {
    repository::list_by_project(pool, project_id, include_archived).await
}

pub async fn list_pinned(pool: &SqlitePool) -> Result<Vec<Feature>, AppError> {
    repository::list_pinned(pool).await
}

pub async fn get_by_id(pool: &SqlitePool, id: i64) -> Result<Option<Feature>, AppError> {
    repository::get_by_id(pool, id).await
}

pub async fn list_activity(
    pool: &SqlitePool,
    project_id: i64,
    include_archived: bool,
    terminal_counts: HashMap<i64, i64>,
    custom_action_counts: HashMap<i64, i64>,
) -> Result<Vec<FeatureActivity>, AppError> {
    let features = repository::list_by_project(pool, project_id, include_archived).await?;
    Ok(features
        .into_iter()
        .map(|feature| {
            let foreground_terminal_count = terminal_counts
                .get(&feature.id)
                .copied()
                .unwrap_or_default();
            let background_custom_action_count = custom_action_counts
                .get(&feature.id)
                .copied()
                .unwrap_or_default();
            FeatureActivity {
                feature_id: feature.id,
                shell_count: foreground_terminal_count + background_custom_action_count,
            }
        })
        .collect())
}

/// Create a feature row and persist worktree-mode preferences atomically so a
/// failed settings write cannot leave a partially configured feature behind.
/// Validation happens in the HTTP handler — this layer trusts its inputs.
pub async fn create_feature_with_worktree(
    pool: &SqlitePool,
    project_id: i64,
    title: Option<String>,
    type_: Option<String>,
    worktree_mode: Option<String>,
    reuse_branch: Option<String>,
    base_branch: Option<String>,
) -> Result<CreateFeatureResponse, AppError> {
    // After the ws-feature removal the only valid feature type is ws-session.
    // Reject any other value defensively in case an old client tries to
    // create one.
    let type_str = type_.as_deref().unwrap_or("ws-session");
    if type_str != "ws-session" {
        return Err(AppError::BadRequest(format!(
            "Unsupported feature type '{type_str}'. Only 'ws-session' is supported."
        )));
    }
    let title = match title {
        Some(t) if !t.trim().is_empty() => t,
        _ => {
            let max_num = repository::get_max_session_num(pool, project_id).await?;
            format!("Session {}", max_num + 1)
        }
    };
    let mut tx = pool.begin().await?;
    let result = sqlx::query(
        "INSERT INTO features (project_id, title, status, type) VALUES (?, ?, 'active', ?)",
    )
    .bind(project_id)
    .bind(&title)
    .bind(type_str)
    .execute(&mut *tx)
    .await?;
    let id = result.last_insert_rowid();
    if let Some(mode) = worktree_mode.as_deref() {
        set_feature_setting_in_tx(&mut tx, id, "worktree_mode", mode).await?;
    }
    if let Some(branch) = reuse_branch.as_deref() {
        set_feature_setting_in_tx(&mut tx, id, "worktree_reuse_branch", branch).await?;
    }
    if let Some(branch) = base_branch.as_deref() {
        set_feature_setting_in_tx(&mut tx, id, "worktree_base_branch", branch).await?;
    }
    tx.commit().await?;
    Ok(CreateFeatureResponse { id })
}

async fn set_feature_setting_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    feature_id: i64,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?) ON CONFLICT(feature_id, key) DO UPDATE SET value = excluded.value",
    )
    .bind(feature_id)
    .bind(key)
    .bind(value)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn update_title(pool: &SqlitePool, id: i64, title: &str) -> Result<(), AppError> {
    repository::update_title(pool, id, title).await
}

pub async fn update_status(
    pool: &SqlitePool,
    id: i64,
    status: FeatureStatus,
) -> Result<(), AppError> {
    repository::update_status(pool, id, status).await
}

pub async fn update_label(pool: &SqlitePool, id: i64, label: Option<&str>) -> Result<(), AppError> {
    repository::update_label(pool, id, label).await
}

pub async fn set_pinned(pool: &SqlitePool, id: i64, is_pinned: bool) -> Result<(), AppError> {
    repository::set_pinned(pool, id, is_pinned).await
}

pub async fn is_empty(pool: &SqlitePool, id: i64) -> Result<IsEmptyResponse, AppError> {
    let empty = repository::is_empty(pool, id).await?;
    Ok(IsEmptyResponse { empty })
}

pub async fn get_feature_settings(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Vec<FeatureSetting>, AppError> {
    repository::get_feature_settings(pool, feature_id).await
}

pub async fn set_feature_setting(
    pool: &SqlitePool,
    feature_id: i64,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    repository::set_feature_setting(pool, feature_id, key, value).await
}

pub async fn get_feature_model_settings(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<FeatureModelSettings, AppError> {
    repository::get_feature_model_settings(pool, feature_id).await
}

pub async fn set_feature_model_setting(
    pool: &SqlitePool,
    feature_id: i64,
    model_type: &str,
    model: &str,
) -> Result<(), AppError> {
    repository::set_feature_model_setting(pool, feature_id, model_type, model).await
}

pub async fn get_feature_provider_settings(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<FeatureProviderSettings, AppError> {
    repository::get_feature_provider_settings(pool, feature_id).await
}

pub async fn set_feature_provider_setting(
    pool: &SqlitePool,
    feature_id: i64,
    provider_type: &str,
    provider: &str,
) -> Result<(), AppError> {
    repository::set_feature_provider_setting(pool, feature_id, provider_type, provider).await
}

pub async fn resolve_working_dir(
    pool: &SqlitePool,
    feature_id: i64,
    project_id: i64,
) -> Result<WorkingDirResponse, AppError> {
    let path = repository::resolve_working_dir(pool, feature_id, project_id).await?;
    Ok(WorkingDirResponse { path })
}

/// Delete a feature.
pub async fn delete_feature(
    write_pool: &SqlitePool,
    _read_pool: &SqlitePool,
    id: i64,
) -> Result<(), AppError> {
    repository::delete_feature(write_pool, id).await
}

/// Resolve the working directory for a feature without requiring the caller to
/// know the `project_id`. Falls back to the project root if no worktree is set.
pub async fn get_feature_cwd(pool: &SqlitePool, feature_id: i64) -> Result<String, AppError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT project_id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(pool)
        .await?;
    let project_id = row
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} not found")))?
        .0;
    let path = repository::resolve_working_dir(pool, feature_id, project_id).await?;
    path.ok_or_else(|| AppError::NotFound(format!("no working dir for feature {feature_id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool_with_features() -> (SqlitePool, i64, i64, i64) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project_id: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('p', '/tmp/p') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let first_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title, status) VALUES (?, 'one', 'active') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let second_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title, status) VALUES (?, 'two', 'active') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        (pool, project_id, first_id, second_id)
    }

    #[tokio::test]
    async fn list_activity_combines_terminal_and_custom_action_counts() {
        let (pool, project_id, first_id, second_id) = pool_with_features().await;
        let terminal_counts = [(second_id, 2)].into_iter().collect();
        let custom_action_counts = [(first_id, 1)].into_iter().collect();

        let activity = list_activity(
            &pool,
            project_id,
            false,
            terminal_counts,
            custom_action_counts,
        )
        .await
        .unwrap();

        let first = activity
            .iter()
            .find(|item| item.feature_id == first_id)
            .unwrap();
        let second = activity
            .iter()
            .find(|item| item.feature_id == second_id)
            .unwrap();
        assert_eq!(first.shell_count, 1);
        assert_eq!(second.shell_count, 2);
    }
}
