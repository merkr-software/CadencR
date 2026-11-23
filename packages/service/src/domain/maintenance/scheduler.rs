use sqlx::SqlitePool;

use super::{
    run_cleanup_once, run_once, StorageMaintenanceBroadcaster, StorageMaintenanceRunGuard,
};

/// Delay before the first sweep, so maintenance never competes with session
/// restore, worktree scanning, and the rest of a cold launch.
const STARTUP_DELAY: std::time::Duration = std::time::Duration::from_secs(30);

/// Gap between sweeps. Long: the passes are cursor-based, so a sweep with
/// nothing to do is nearly free, and there is no urgency to reclaiming bytes.
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Spawn the periodic maintenance loop. Detached: the caller doesn't wait on it
/// and it has no shutdown signal, because every pass is safe to abandon
/// mid-flight — the cursor simply stays where it was.
pub fn spawn(read_pool: SqlitePool, write_pool: SqlitePool, events: StorageMaintenanceBroadcaster) {
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            run_scheduled_sweep(&read_pool, &write_pool, &events).await;
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    });
}

async fn run_scheduled_sweep(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
) {
    if let Some(_run) = events.try_begin_run() {
        run_once(read_pool, write_pool, events).await;
    }
}

/// Start a user-requested cleanup after the route has reserved the runner.
pub(super) fn spawn_cleanup(
    read_pool: SqlitePool,
    write_pool: SqlitePool,
    events: StorageMaintenanceBroadcaster,
    run: StorageMaintenanceRunGuard,
) {
    tokio::spawn(async move {
        run_cleanup_once(&read_pool, &write_pool, &events).await;
        drop(run);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::maintenance::{state, StorageMaintenanceBroadcaster};
    use crate::shared::db;

    const TEST_SCHEMA: &str = r#"CREATE TABLE maintenance_state (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
               );
               CREATE TABLE agent_messages (
                   id INTEGER PRIMARY KEY,
                   session_id INTEGER NOT NULL,
                   role TEXT NOT NULL DEFAULT 'assistant',
                   content TEXT NOT NULL,
                   message_type TEXT NOT NULL,
                   tool_name TEXT,
                   tool_use_id TEXT
               );
               INSERT INTO agent_messages
                   (id, session_id, content, message_type, tool_name, tool_use_id)
               VALUES
                   (1, 1, '{"command":"test","output":"kept in result"}',
                    'tool_call', 'Bash', 'tool-1'),
                   (2, 1, 'kept in result', 'tool_result', NULL, 'tool-1');"#;

    async fn pool_with_duplicate_output() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn scheduled_sweep_completes_initial_optimization_and_requests_compaction() {
        let pool = pool_with_duplicate_output().await;

        run_scheduled_sweep(&pool, &pool, &StorageMaintenanceBroadcaster::new(4)).await;

        let content =
            sqlx::query_scalar::<_, String>("SELECT content FROM agent_messages WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(content, r#"{"command":"test"}"#);
        assert_eq!(
            state::get(&pool, state::INITIAL_OPTIMIZATION_COMPLETED)
                .await
                .as_deref(),
            Some("1")
        );
        assert_eq!(
            state::get(&pool, state::DATABASE_COMPACTION_REQUESTED)
                .await
                .as_deref(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn scheduled_sweep_runs_reads_on_query_only_read_pool_and_writes_on_write_pool() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("maintenance.db");
        let path_str = path.to_str().unwrap();

        let write_pool = db::create_write_pool(path_str).await.unwrap();
        sqlx::raw_sql(TEST_SCHEMA)
            .execute(&write_pool)
            .await
            .unwrap();
        let read_pool = db::create_read_pool(path_str).await.unwrap();

        run_scheduled_sweep(
            &read_pool,
            &write_pool,
            &StorageMaintenanceBroadcaster::new(4),
        )
        .await;

        let content =
            sqlx::query_scalar::<_, String>("SELECT content FROM agent_messages WHERE id = 1")
                .fetch_one(&read_pool)
                .await
                .unwrap();
        assert_eq!(content, r#"{"command":"test"}"#);
        assert_eq!(
            state::get(&read_pool, state::INITIAL_OPTIMIZATION_COMPLETED)
                .await
                .as_deref(),
            Some("1")
        );

        read_pool.close().await;
        write_pool.close().await;
    }
}
