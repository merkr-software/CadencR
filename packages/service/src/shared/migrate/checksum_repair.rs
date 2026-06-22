//! Narrow compatibility repairs for known sqlx migration checksum revisions.

use std::collections::HashSet;

use anyhow::Context;
use sqlx::{AssertSqlSafe, SqlitePool};
use tracing::info;

use super::checksum_repair_data::{
    FEATURE_STATUS_TRIGGERS, LEGACY_SETTING_KEYS, OLD_REMOVE_WS_FEATURE_CHECKSUMS,
    REMOVED_AGENT_SESSION_COLUMNS, REMOVED_FEATURE_COLUMNS, REMOVED_PROJECT_COLUMNS,
    REMOVE_WS_FEATURE_VERSION,
};
use super::support::{table_columns, table_exists};

pub(super) async fn repair_known_sqlx_checksum_mismatches(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(());
    }

    let Some((applied_checksum, success)) = sqlx::query_as::<_, (Vec<u8>, bool)>(
        "SELECT checksum, success FROM _sqlx_migrations WHERE version = ?",
    )
    .bind(REMOVE_WS_FEATURE_VERSION)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(());
    };

    if !success {
        return Ok(());
    }

    let Some(current_checksum) = current_migration_checksum(migrator, REMOVE_WS_FEATURE_VERSION)
    else {
        return Ok(());
    };

    if applied_checksum == current_checksum {
        return Ok(());
    }

    if !OLD_REMOVE_WS_FEATURE_CHECKSUMS
        .iter()
        .any(|checksum| applied_checksum == checksum)
    {
        return Ok(());
    }

    verify_remove_ws_feature_postconditions(pool).await?;

    let result = sqlx::query(
        "UPDATE _sqlx_migrations
         SET checksum = ?
         WHERE version = ? AND checksum = ? AND success = TRUE",
    )
    .bind(current_checksum)
    .bind(REMOVE_WS_FEATURE_VERSION)
    .bind(&applied_checksum)
    .execute(pool)
    .await?;

    if result.rows_affected() == 1 {
        info!(
            version = REMOVE_WS_FEATURE_VERSION,
            "reconciled known sqlx migration checksum revision"
        );
    }

    Ok(())
}

fn current_migration_checksum(migrator: &sqlx::migrate::Migrator, version: i64) -> Option<Vec<u8>> {
    migrator
        .iter()
        .find(|migration| migration.version == version)
        .map(|migration| migration.checksum.to_vec())
}

async fn verify_remove_ws_feature_postconditions(pool: &SqlitePool) -> anyhow::Result<()> {
    let mut failures = Vec::new();

    for table_name in ["workflow_dependencies", "workflow_queue", "phases", "plans"] {
        if table_exists(pool, table_name).await? {
            failures.push(format!("{table_name} still exists"));
        }
    }

    if table_exists(pool, "features").await? {
        let columns = table_columns(pool, "features").await?;
        assert_columns_absent("features", &columns, REMOVED_FEATURE_COLUMNS, &mut failures);
        assert_feature_status_postconditions(pool, &columns, &mut failures).await?;
    } else {
        failures.push("features is missing".to_string());
    }

    if table_exists(pool, "projects").await? {
        let columns = table_columns(pool, "projects").await?;
        assert_columns_absent("projects", &columns, REMOVED_PROJECT_COLUMNS, &mut failures);
    } else {
        failures.push("projects is missing".to_string());
    }

    if table_exists(pool, "agent_sessions").await? {
        let columns = table_columns(pool, "agent_sessions").await?;
        assert_columns_absent(
            "agent_sessions",
            &columns,
            REMOVED_AGENT_SESSION_COLUMNS,
            &mut failures,
        );
    } else {
        failures.push("agent_sessions is missing".to_string());
    }

    assert_legacy_setting_keys_absent(pool, &mut failures).await?;

    if failures.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(
            "{} checksum repair postcondition failed: {}",
            REMOVE_WS_FEATURE_VERSION,
            failures.join("; ")
        );
    }
}

async fn assert_feature_status_postconditions(
    pool: &SqlitePool,
    feature_columns: &HashSet<String>,
    failures: &mut Vec<String>,
) -> anyhow::Result<()> {
    if feature_columns.contains("status") {
        let invalid_statuses: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM features WHERE status NOT IN ('active', 'archived')",
        )
        .fetch_one(pool)
        .await
        .context("failed to verify normalized feature statuses")?;
        if invalid_statuses > 0 {
            failures.push(format!(
                "{invalid_statuses} feature status value(s) are not normalized"
            ));
        }
    } else {
        failures.push("features.status is missing".to_string());
    }

    for trigger_name in FEATURE_STATUS_TRIGGERS {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name = ?)",
        )
        .bind(trigger_name)
        .fetch_one(pool)
        .await
        .with_context(|| format!("failed to verify trigger {trigger_name}"))?;
        if !exists {
            failures.push(format!("{trigger_name} trigger is missing"));
        }
    }

    Ok(())
}

async fn assert_legacy_setting_keys_absent(
    pool: &SqlitePool,
    failures: &mut Vec<String>,
) -> anyhow::Result<()> {
    for table_name in ["settings", "project_settings", "feature_settings"] {
        if table_exists(pool, table_name).await? {
            let sql = format!(
                "SELECT COUNT(*) FROM {table_name} WHERE key IN ({})",
                placeholders(LEGACY_SETTING_KEYS.len())
            );
            let mut query = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql));
            for key in LEGACY_SETTING_KEYS {
                query = query.bind(key);
            }
            let count = query
                .fetch_one(pool)
                .await
                .with_context(|| format!("failed to verify legacy keys in {table_name}"))?;
            if count > 0 {
                failures.push(format!(
                    "{table_name} still has {count} legacy setting key(s)"
                ));
            }
        }
    }
    Ok(())
}

fn assert_columns_absent(
    table_name: &str,
    existing_columns: &HashSet<String>,
    columns: &[&str],
    failures: &mut Vec<String>,
) {
    for column_name in columns {
        if existing_columns.contains(*column_name) {
            failures.push(format!("{table_name}.{column_name} still exists"));
        }
    }
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::super::{run_migrations, MigrationContext};
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use std::str::FromStr;

    async fn test_pool(path: &str) -> SqlitePool {
        let options = SqliteConnectOptions::from_str(&format!("sqlite:{path}"))
            .unwrap()
            .create_if_missing(true);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap()
    }

    fn current_remove_ws_feature_checksum() -> Vec<u8> {
        let migrator = sqlx::migrate!("./migrations");
        current_migration_checksum(&migrator, REMOVE_WS_FEATURE_VERSION)
            .expect("remove ws-feature migration must exist")
    }

    async fn overwrite_remove_ws_feature_checksum(pool: &SqlitePool, checksum: &[u8]) {
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(checksum)
            .bind(REMOVE_WS_FEATURE_VERSION)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn applied_remove_ws_feature_checksum(pool: &SqlitePool) -> Vec<u8> {
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
            .bind(REMOVE_WS_FEATURE_VERSION)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reconciles_known_old_remove_ws_feature_checksums() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        for checksum in OLD_REMOVE_WS_FEATURE_CHECKSUMS {
            overwrite_remove_ws_feature_checksum(&pool, &checksum).await;

            run_migrations(&MigrationContext::pool_only(&pool))
                .await
                .unwrap();

            assert_eq!(
                applied_remove_ws_feature_checksum(&pool).await,
                current_remove_ws_feature_checksum()
            );
        }
    }

    #[tokio::test]
    async fn refuses_checksum_repair_when_postconditions_fail() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        overwrite_remove_ws_feature_checksum(&pool, &OLD_REMOVE_WS_FEATURE_CHECKSUMS[0]).await;
        sqlx::query("DROP TRIGGER features_status_update_normalize")
            .execute(&pool)
            .await
            .unwrap();

        let error = run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("20260514123657 checksum repair postcondition failed"),
            "{error:#}"
        );
        assert_eq!(
            applied_remove_ws_feature_checksum(&pool).await,
            OLD_REMOVE_WS_FEATURE_CHECKSUMS[0]
        );
    }
}
