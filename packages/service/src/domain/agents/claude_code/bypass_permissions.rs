use sqlx::SqlitePool;

use crate::domain::settings;

const BYPASS_PERMISSIONS_KEY: &str = "claude_bypass_permissions_enabled";
const FALSE: &str = "false";
const TRUE: &str = "true";

pub(super) async fn enabled(
    read_pool: &SqlitePool,
    feature_id: Option<i64>,
    project_id: Option<i64>,
) -> bool {
    let resolved_project_id = match (project_id, feature_id) {
        (Some(project_id), _) => Some(project_id),
        (None, Some(feature_id)) => project_id_for_feature(read_pool, feature_id).await,
        (None, None) => None,
    };

    settings::resolve_setting(
        read_pool,
        BYPASS_PERMISSIONS_KEY,
        feature_id,
        resolved_project_id,
        Some(FALSE),
    )
    .await
    .unwrap_or_else(|| FALSE.to_string())
        == TRUE
}

async fn project_id_for_feature(read_pool: &SqlitePool, feature_id: i64) -> Option<i64> {
    sqlx::query_scalar::<_, Option<i64>>("SELECT project_id FROM features WHERE id = ? LIMIT 1")
        .bind(feature_id)
        .fetch_optional(read_pool)
        .await
        .ok()
        .flatten()
        .flatten()
}

#[cfg(test)]
mod tests {
    use crate::domain::agents::runtime_adapter;

    #[tokio::test]
    async fn adapter_requires_explicit_scoped_opt_in_without_affecting_other_providers() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER); CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT); INSERT INTO features VALUES (1, NULL), (2, NULL); INSERT INTO feature_settings VALUES (1, 'claude_bypass_permissions_enabled', 'true'), (2, 'claude_bypass_permissions_enabled', 'false');")
            .execute(&pool).await.unwrap();
        let adapter = runtime_adapter(super::super::PROVIDER_ID).unwrap();
        assert_eq!(
            adapter.bypass_permission_opt_in(&pool, 1, None).await,
            Some(true)
        );
        assert_eq!(
            adapter.bypass_permission_opt_in(&pool, 2, None).await,
            Some(false)
        );
        let other = runtime_adapter(crate::domain::agents::codex::PROVIDER_ID).unwrap();
        assert_eq!(other.bypass_permission_opt_in(&pool, 1, None).await, None);
    }
}
