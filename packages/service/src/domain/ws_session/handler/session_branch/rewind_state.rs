//! State mutation helpers for `branch.rewind`.

use tracing::warn;

use super::BranchInputs;
use crate::domain::checkpoints;

/// Result of attempting the worktree code restore during a rewind.
pub(super) enum CodeRestoreOutcome {
    /// No pre-turn checkpoint existed for this message — nothing to restore.
    NoCheckpoint,
    /// The worktree was rolled back to the checkpoint.
    Restored,
    /// A checkpoint existed but `git restore` failed; the message is surfaced.
    Failed(String),
}

pub(super) enum RewindStateError {
    CodeRestore(String),
    Db(sqlx::Error),
}

impl CodeRestoreOutcome {
    /// `(code_restored, code_restore_error)` for the WS reply: a missing
    /// checkpoint and a failed restore are distinct (the UI labels them
    /// differently) rather than both collapsing to a bare `false`.
    pub(super) fn to_wire(&self) -> (bool, Option<String>) {
        match self {
            CodeRestoreOutcome::Restored => (true, None),
            CodeRestoreOutcome::NoCheckpoint => (false, None),
            CodeRestoreOutcome::Failed(reason) => (false, Some(reason.clone())),
        }
    }
}

/// Restore the worktree to the checkpoint. A restore failure is surfaced to the
/// caller so rewind can abort before deleting conversation rows.
async fn restore_code(inputs: &BranchInputs, checkpoint: Option<&str>) -> CodeRestoreOutcome {
    let Some(sha) = checkpoint else {
        return CodeRestoreOutcome::NoCheckpoint;
    };
    match checkpoints::restore(&inputs.cwd, sha).await {
        Ok(()) => CodeRestoreOutcome::Restored,
        Err(error) => {
            warn!(
                inputs.db_session_id,
                error = %error,
                "checkpoint restore failed; aborting rewind before conversation mutation"
            );
            CodeRestoreOutcome::Failed(error.to_string())
        }
    }
}

/// Restore code first, then delete conversation rows and swap the runtime id.
/// A code restore failure aborts before DB mutation so users never lose the
/// conversation tail while the worktree remains unreverted.
pub(super) async fn apply_rewind_state(
    pool: &sqlx::SqlitePool,
    inputs: &BranchInputs,
    checkpoint: Option<&str>,
    new_runtime_session_id: Option<&str>,
) -> Result<CodeRestoreOutcome, RewindStateError> {
    let code_outcome = restore_code(inputs, checkpoint).await;
    if let CodeRestoreOutcome::Failed(reason) = &code_outcome {
        return Err(RewindStateError::CodeRestore(reason.clone()));
    }

    apply_db_rewind(
        pool,
        inputs.db_session_id,
        inputs.message_id,
        new_runtime_session_id,
    )
    .await
    .map_err(RewindStateError::Db)?;

    Ok(code_outcome)
}

/// Delete the cut message and everything after it, then swap the provider
/// session id. Checkpoints are removed explicitly (the FK also cascades).
async fn apply_db_rewind(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    message_id: i64,
    new_runtime_session_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    // One transaction so a failure partway through can never leave the
    // conversation half-deleted or pointing at a stale runtime session id.
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM turn_checkpoints WHERE message_id IN \
         (SELECT id FROM agent_messages WHERE session_id = ? AND id >= ?)",
    )
    .bind(db_session_id)
    .bind(message_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM agent_messages WHERE session_id = ? AND id >= ?")
        .bind(db_session_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE agent_sessions SET runtime_session_id = ? WHERE id = ?")
        .bind(new_runtime_session_id)
        .bind(db_session_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool_with_messages() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, runtime_session_id TEXT);
             CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
                role TEXT, content TEXT, message_type TEXT);
             CREATE TABLE turn_checkpoints (message_id INTEGER PRIMARY KEY, commit_sha TEXT);
             INSERT INTO agent_sessions (id, runtime_session_id) VALUES (1, 'old-sid');
             INSERT INTO agent_messages (id, session_id, role, content, message_type) VALUES
                (1, 1, 'user', 'q1', 'user_message'),
                (2, 1, 'assistant', 'a1', 'text'),
                (3, 1, 'user', 'q2', 'user_message'),
                (4, 1, 'assistant', 'a2', 'text'),
                (5, 1, 'user', 'q3', 'user_message');
             INSERT INTO turn_checkpoints (message_id, commit_sha) VALUES
                (1, 'c1'), (3, 'c3'), (5, 'c5');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[test]
    fn code_restore_outcome_distinguishes_missing_from_failed() {
        assert_eq!(CodeRestoreOutcome::Restored.to_wire(), (true, None));
        // A missing checkpoint and a failed restore both report `false` but only
        // the failure carries an error the UI can show.
        assert_eq!(CodeRestoreOutcome::NoCheckpoint.to_wire(), (false, None));
        assert_eq!(
            CodeRestoreOutcome::Failed("git boom".into()).to_wire(),
            (false, Some("git boom".to_string())),
        );
    }

    #[tokio::test]
    async fn apply_db_rewind_deletes_from_cut_and_swaps_runtime_id() {
        let pool = pool_with_messages().await;

        apply_db_rewind(&pool, 1, 3, Some("new-sid")).await.unwrap();

        let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM agent_messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec![1, 2], "messages >= cut are deleted");

        let checkpoints: Vec<i64> =
            sqlx::query_scalar("SELECT message_id FROM turn_checkpoints ORDER BY message_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            checkpoints,
            vec![1],
            "checkpoints for deleted messages are gone"
        );

        let sid: Option<String> =
            sqlx::query_scalar("SELECT runtime_session_id FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(sid.as_deref(), Some("new-sid"));
    }

    #[tokio::test]
    async fn apply_db_rewind_can_clear_runtime_id_for_fresh_start() {
        let pool = pool_with_messages().await;
        apply_db_rewind(&pool, 1, 1, None).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "rewinding to the first message clears the session"
        );
        let sid: Option<String> =
            sqlx::query_scalar("SELECT runtime_session_id FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(sid.is_none(), "fresh start nulls the runtime session id");
    }

    #[tokio::test]
    pub(super) async fn apply_rewind_state_does_not_delete_messages_when_code_restore_fails() {
        let pool = pool_with_messages().await;
        let dir = tempfile::tempdir().unwrap();
        let inputs = BranchInputs {
            db_session_id: 1,
            feature_id: 7,
            message_id: 3,
            provider_id: "claude_code".to_string(),
            cwd: dir.path().to_path_buf(),
            message_text: "q2".to_string(),
            cut_user_ordinal: 2,
            cut_provider_uuid: None,
        };

        let result =
            apply_rewind_state(&pool, &inputs, Some("not-a-commit"), Some("new-sid")).await;

        assert!(
            result.is_err(),
            "failed code restore aborts before DB rewind"
        );
        let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM agent_messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            remaining,
            vec![1, 2, 3, 4, 5],
            "conversation stays intact when code restore fails"
        );
        let sid: Option<String> =
            sqlx::query_scalar("SELECT runtime_session_id FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(sid.as_deref(), Some("old-sid"));
    }
}
