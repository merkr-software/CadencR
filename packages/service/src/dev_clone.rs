//! Instance role of a dev service started on a database cloned from another
//! checkout.
//!
//! `pnpm dev:configure-worktree` seeds a linked worktree with a copy of the
//! main checkout's dev database and marks it fresh (see
//! [`crate::dev_env::FRESH_CLONE_MARKER_SUFFIX`]). That copy still holds the
//! main service's *live* runtime bookkeeping: the pids of agents it is running
//! right now (`agent_process_ledger`), the turns it will resume
//! (`restart_continuations`, sessions left `running`), its schedules and its
//! queued agent-to-agent messages. All of it points at the same worktrees and
//! provider sessions as the main checkout, on the same machine. A service that
//! treated the copy as its own past would reap the main service's agents, run
//! a second process on their conversations, and fire every schedule twice.
//!
//! So the first start on a fresh clone runs as [`InstanceRole::FreshClone`]:
//! it forgets that inherited runtime state, in the clone only, before any
//! startup recovery reads it. From then on the database is the worktree's
//! own and the service behaves as a primary.

use std::path::Path;

use anyhow::Context;
use sqlx::SqlitePool;

use crate::dev_env;

/// Who owns the runtime state recorded in the database this service opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceRole {
    /// The database's runtime state was written by this service's previous
    /// runs: reap, resume and schedule from it.
    Primary,
    /// An untouched copy of another checkout's database: its runtime state
    /// belongs to the service that is still running there.
    FreshClone,
}

/// Debug builds only, like the backup skip: release builds never open a
/// worktree clone, and a stray marker must not make them drop state.
fn role_for(debug_build: bool, fresh_clone_marker: bool) -> InstanceRole {
    if debug_build && fresh_clone_marker {
        InstanceRole::FreshClone
    } else {
        InstanceRole::Primary
    }
}

pub fn instance_role(db_path: &Path) -> InstanceRole {
    role_for(
        cfg!(debug_assertions),
        dev_env::fresh_clone_marker(db_path).is_file(),
    )
}

/// What [`forget_inherited_runtime_state`] dropped from the clone.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct InheritedRuntimeState {
    pub agent_processes: u64,
    pub pending_continuations: u64,
    pub running_sessions: u64,
    pub enabled_schedules: u64,
    pub queued_messages: u64,
}

/// Drop the runtime state a cloned database inherited from the checkout it
/// was copied from, in one transaction. Only call this on the clone.
///
/// - agent pids: the processes are the source service's, alive and working;
/// - pending continuations and `running` sessions: the source service still
///   drives those turns (pausing them here keeps the crash capture from
///   queueing a resume);
/// - schedules are paused, not deleted, so the user can re-enable one to test
///   it in the worktree;
/// - queued agent-to-agent messages are cancelled: the source delivers them.
pub async fn forget_inherited_runtime_state(
    pool: &SqlitePool,
) -> Result<InheritedRuntimeState, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let agent_processes = sqlx::query("DELETE FROM agent_process_ledger")
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let pending_continuations =
        sqlx::query("DELETE FROM restart_continuations WHERE state = 'pending'")
            .execute(&mut *tx)
            .await?
            .rows_affected();
    let running_sessions = sqlx::query(
        "UPDATE agent_sessions SET status = 'paused', ended_at = ? WHERE status = 'running'",
    )
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let enabled_schedules = sqlx::query(
        "UPDATE schedules SET enabled = 0, updated_at = datetime('now') WHERE enabled = 1",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let queued_messages = sqlx::query(
        "UPDATE agent_session_message_queue
         SET status = 'cancelled',
             error = 'Copied from another checkout''s database; that checkout delivers it.'
         WHERE status IN ('pending', 'delivering')",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(InheritedRuntimeState {
        agent_processes,
        pending_continuations,
        running_sessions,
        enabled_schedules,
        queued_messages,
    })
}

/// Run once migrations succeeded, before any startup recovery. On a fresh
/// clone, forget the inherited runtime state, then retire the marker; the
/// marker stays when that fails, so the next start retries instead of
/// recovering someone else's agents.
pub async fn adopt_database(pool: &SqlitePool, db_path: &Path) -> anyhow::Result<()> {
    if instance_role(db_path) == InstanceRole::FreshClone {
        let forgotten = forget_inherited_runtime_state(pool).await.context(
            "Failed to drop the runtime state this cloned dev database inherited from the main \
             checkout; refusing to start so it cannot stop or resume the main checkout's agents",
        )?;
        tracing::warn!(
            ?forgotten,
            "fresh worktree clone: dropped the runtime state it inherited from the main checkout"
        );
    }
    dev_env::consume_fresh_clone_marker(db_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        pool
    }

    async fn scalar(pool: &SqlitePool, sql: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The main checkout's live state, as the clone copied it.
    async fn seed_inherited_state(pool: &SqlitePool) -> i64 {
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO schedules (prompt, target_kind, feature_id, recurrence_kind, interval_seconds)
             VALUES ('review', 'conversation', 1, 'interval', 3600)",
        )
        .execute(pool)
        .await
        .unwrap();
        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (1, 'session', 'running') RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_process_ledger (session_id, pid, identity) VALUES (?, ?, 'x')",
        )
        .bind(session_id)
        .bind(i64::from(std::process::id()))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO restart_continuations (session_id, cause) VALUES (?, 'shutdown')")
            .bind(session_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO restart_continuations (session_id, cause, state) VALUES (?, 'crash', 'resumed')",
        )
        .bind(session_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_session_message_queue (target_session_id, content) VALUES (?, 'hi')",
        )
        .bind(session_id)
        .execute(pool)
        .await
        .unwrap();
        session_id
    }

    #[test]
    fn only_a_marked_debug_database_is_a_clone() {
        assert_eq!(role_for(true, true), InstanceRole::FreshClone);
        assert_eq!(role_for(true, false), InstanceRole::Primary);
        assert_eq!(role_for(false, true), InstanceRole::Primary);
    }

    #[tokio::test]
    async fn forgets_inherited_runtime_state_but_keeps_history() {
        let pool = migrated_pool().await;
        let session_id = seed_inherited_state(&pool).await;

        let forgotten = forget_inherited_runtime_state(&pool).await.unwrap();

        assert_eq!(forgotten.agent_processes, 1);
        assert_eq!(forgotten.pending_continuations, 1);
        assert_eq!(forgotten.running_sessions, 1);
        assert_eq!(forgotten.queued_messages, 1);
        assert_eq!(forgotten.enabled_schedules, 1);
        assert_eq!(
            scalar(&pool, "SELECT COUNT(*) FROM schedules WHERE enabled = 1").await,
            0,
            "schedules stay, paused"
        );
        assert_eq!(scalar(&pool, "SELECT COUNT(*) FROM schedules").await, 1);
        assert_eq!(
            scalar(&pool, "SELECT COUNT(*) FROM agent_process_ledger").await,
            0
        );
        assert_eq!(
            scalar(
                &pool,
                "SELECT COUNT(*) FROM restart_continuations WHERE state = 'resumed'"
            )
            .await,
            1,
            "resolved continuations are transcript history"
        );
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "paused");
        assert_eq!(
            scalar(
                &pool,
                "SELECT COUNT(*) FROM agent_session_message_queue WHERE status = 'cancelled'"
            )
            .await,
            1
        );
    }

    // `instance_role` only reads the marker in debug builds.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn adopting_a_fresh_clone_scrubs_it_once_then_runs_as_primary() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cadencr.local.db");
        let marker = dev_env::fresh_clone_marker(&db_path);
        std::fs::write(&marker, "fresh").unwrap();
        let pool = migrated_pool().await;
        seed_inherited_state(&pool).await;

        assert_eq!(instance_role(&db_path), InstanceRole::FreshClone);
        adopt_database(&pool, &db_path).await.unwrap();

        assert!(!marker.exists());
        assert_eq!(instance_role(&db_path), InstanceRole::Primary);
        assert_eq!(
            scalar(&pool, "SELECT COUNT(*) FROM agent_process_ledger").await,
            0
        );

        // A later start owns its ledger: adopting again leaves it alone.
        sqlx::query(
            "INSERT INTO agent_process_ledger (session_id, pid, identity) VALUES (1, 1, 'own')",
        )
        .execute(&pool)
        .await
        .unwrap();
        adopt_database(&pool, &db_path).await.unwrap();
        assert_eq!(
            scalar(&pool, "SELECT COUNT(*) FROM agent_process_ledger").await,
            1
        );
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_failed_scrub_keeps_the_marker_and_refuses_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cadencr.local.db");
        let marker = dev_env::fresh_clone_marker(&db_path);
        std::fs::write(&marker, "fresh").unwrap();
        // Unmigrated: the scrub's tables do not exist.
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

        let error = adopt_database(&pool, &db_path).await.unwrap_err();

        assert!(error.to_string().contains("refusing to start"));
        assert!(marker.exists());
    }
}
