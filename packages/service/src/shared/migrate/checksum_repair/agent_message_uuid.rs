use sqlx::{AssertSqlSafe, SqlitePool};

use super::{applied_migration, current_migration_checksum, replace_checksum};
use crate::shared::migrate::checksum_repair_data::{
    AGENT_MESSAGE_UUID_VERSION, OLD_AGENT_MESSAGE_UUID_CHECKSUMS,
};
use crate::shared::migrate::support::table_columns;

pub(super) async fn repair_agent_message_uuid_checksum(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    let Some((applied_checksum, success)) =
        applied_migration(pool, AGENT_MESSAGE_UUID_VERSION).await?
    else {
        return Ok(());
    };
    let Some(current_checksum) = current_migration_checksum(migrator, AGENT_MESSAGE_UUID_VERSION)
    else {
        return Ok(());
    };
    if !success
        || applied_checksum == current_checksum
        || !OLD_AGENT_MESSAGE_UUID_CHECKSUMS
            .iter()
            .any(|checksum| applied_checksum == checksum)
    {
        return Ok(());
    }
    verify_base_postconditions(pool).await?;
    add_column_if_missing(
        pool,
        "agent_message_dispatches",
        "await_reply",
        "ALTER TABLE agent_message_dispatches ADD COLUMN await_reply INTEGER NOT NULL DEFAULT 0 CHECK (await_reply IN (0, 1))",
    )
    .await?;
    add_column_if_missing(
        pool,
        "agent_message_dispatches",
        "link_to_current_session",
        "ALTER TABLE agent_message_dispatches ADD COLUMN link_to_current_session INTEGER NOT NULL DEFAULT 1 CHECK (link_to_current_session IN (0, 1))",
    )
    .await?;
    replace_checksum(
        pool,
        AGENT_MESSAGE_UUID_VERSION,
        &applied_checksum,
        &current_checksum,
    )
    .await
}

async fn add_column_if_missing(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    sql: &str,
) -> anyhow::Result<()> {
    if !table_columns(pool, table).await?.contains(column) {
        sqlx::query(AssertSqlSafe(sql.to_string()))
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn verify_base_postconditions(pool: &SqlitePool) -> anyhow::Result<()> {
    let message_columns = table_columns(pool, "agent_messages").await?;
    let queue_columns = table_columns(pool, "agent_session_message_queue").await?;
    let dispatch_columns = table_columns(pool, "agent_message_dispatches").await?;
    for (table, columns, required) in [
        ("agent_messages", &message_columns, &["message_uuid"][..]),
        (
            "agent_session_message_queue",
            &queue_columns,
            &["message_uuid"][..],
        ),
        (
            "agent_message_dispatches",
            &dispatch_columns,
            &["message_id", "status"][..],
        ),
    ] {
        for column in required {
            if !columns.contains(*column) {
                anyhow::bail!(
                    "{} checksum repair postcondition failed: {table}.{column} is missing",
                    AGENT_MESSAGE_UUID_VERSION
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    const MESSAGE_DELIVERY_DURABILITY_VERSION: i64 = 20260713121500;
    const SCHEDULES_VERSION: i64 = 20260724120000;

    #[tokio::test]
    async fn reconciles_initial_agent_message_uuid_migration() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let pool = test_pool(tmp.path().to_str().unwrap()).await;
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        remove_later_schema(&pool).await;

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        assert_repaired_schema(&pool).await;
    }

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

    async fn remove_later_schema(pool: &SqlitePool) {
        // Rewind past the schedules migration too, restoring `scheduled_messages`
        // in its post-durability shape. That migration folds the table into
        // `schedules` and drops it, so without this the ALTERs below (and the
        // re-run of the durability migration) would target a table that no
        // longer exists.
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version IN (?, ?)")
            .bind(MESSAGE_DELIVERY_DURABILITY_VERSION)
            .bind(SCHEDULES_VERSION)
            .execute(pool)
            .await
            .unwrap();
        sqlx::raw_sql(
            "DROP TABLE IF EXISTS schedules;
             CREATE TABLE scheduled_messages (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 feature_id INTEGER NOT NULL,
                 text TEXT NOT NULL,
                 scheduled_at TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending',
                 error TEXT,
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                 claim_token TEXT,
                 claimed_at TEXT,
                 attempt_count INTEGER NOT NULL DEFAULT 0,
                 FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
             );",
        )
        .execute(pool)
        .await
        .unwrap();
        for sql in [
            "ALTER TABLE agent_message_dispatches DROP COLUMN await_reply",
            "ALTER TABLE agent_message_dispatches DROP COLUMN link_to_current_session",
            "ALTER TABLE agent_messages DROP COLUMN delivery_state",
            "ALTER TABLE agent_session_message_queue DROP COLUMN claim_token",
            "ALTER TABLE agent_session_message_queue DROP COLUMN claimed_at",
            "ALTER TABLE agent_session_message_queue DROP COLUMN attempt_count",
            "ALTER TABLE scheduled_messages DROP COLUMN claim_token",
            "ALTER TABLE scheduled_messages DROP COLUMN claimed_at",
            "ALTER TABLE scheduled_messages DROP COLUMN attempt_count",
        ] {
            sqlx::raw_sql(sql).execute(pool).await.unwrap();
        }
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(&OLD_AGENT_MESSAGE_UUID_CHECKSUMS[0][..])
            .bind(AGENT_MESSAGE_UUID_VERSION)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn assert_repaired_schema(pool: &SqlitePool) {
        assert!(table_columns(pool, "agent_messages")
            .await
            .unwrap()
            .contains("delivery_state"));
        let dispatch_columns = table_columns(pool, "agent_message_dispatches")
            .await
            .unwrap();
        assert!(dispatch_columns.contains("await_reply"));
        assert!(dispatch_columns.contains("link_to_current_session"));
        let applied: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ? AND success = TRUE",
        )
        .bind(MESSAGE_DELIVERY_DURABILITY_VERSION)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(applied, 1);
    }
}
