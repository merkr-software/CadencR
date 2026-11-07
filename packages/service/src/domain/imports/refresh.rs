//! Append newer provider events into an existing Cadencr session.
//!
//! A user can start a session in Cadencr, continue it directly in the
//! provider's CLI (which appends to its own on-disk log), then return to
//! Cadencr — where the conversation is now stale. This module re-reads the
//! provider's current on-disk conversation (reusing the importer's loaders)
//! and appends every event newer than the newest message already stored for
//! the session, leaving the existing prefix untouched. The timestamp-based diff
//! that decides "newer" lives in [`super::refresh_diff`].

use sqlx::SqlitePool;

use crate::error::AppError;

use super::models::ImportProvider;
use super::refresh_diff::{append_new_messages, latest_message_time};
use super::service::{load_provider_session, LoadedSession};

/// Result of a refresh: how many provider events were appended, which session
/// they landed in, and the message-id cursor just before the append.
#[derive(Debug, Clone, Copy)]
pub struct RefreshOutcome {
    pub added: u32,
    pub session_db_id: i64,
    pub cursor: i64,
}

#[derive(Debug)]
struct SessionRef {
    id: i64,
    provider: ImportProvider,
    runtime_session_id: String,
    /// The feature's working directory — worktree-aware. Provider CLIs name their
    /// on-disk log directory after the cwd they ran in, so for a worktree-backed
    /// feature this must be the worktree path, not the project root.
    cwd: String,
}

/// Append provider events newer than the newest stored message into the
/// feature's latest CLI-backed session.
///
/// The frontend addresses a conversation by `features.id` (its stable, always-
/// available key) — `agent_sessions.id` is derived/late on the client and not
/// reliable for live sessions — so we resolve the target session here from the
/// feature.
pub async fn refresh_feature_from_provider(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    feature_id: i64,
) -> Result<RefreshOutcome, AppError> {
    let session = resolve_feature_session(read_pool, feature_id).await?;

    let loaded =
        load_provider_session(session.provider, &session.cwd, &session.runtime_session_id).await?;
    let cursor = max_message_id(read_pool, session.id).await?;
    let conv = match loaded {
        LoadedSession::Found(conv) => conv,
        // No on-disk conversation yet (or it has no messages) — nothing to sync.
        LoadedSession::NotFound | LoadedSession::Empty => {
            return Ok(RefreshOutcome {
                added: 0,
                session_db_id: session.id,
                cursor,
            })
        }
    };

    let cutoff = latest_message_time(read_pool, session.id).await?;
    let added = append_new_messages(write_pool, session.id, &conv, cutoff).await?;
    Ok(RefreshOutcome {
        added,
        session_db_id: session.id,
        cursor,
    })
}

/// Highest `agent_messages.id` for a session (`0` when it has none) — the cursor
/// the client fetches `after` to pull exactly the rows this refresh appends.
async fn max_message_id(pool: &SqlitePool, session_id: i64) -> Result<i64, AppError> {
    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(id) FROM agent_messages WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;
    Ok(max.unwrap_or(0))
}

/// Resolve the feature's latest CLI-backed agent session — the one whose
/// conversation the user sees and continues in the CLI. Rejects features with
/// no syncable session, a running session, or an unknown provider.
async fn resolve_feature_session(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<SessionRef, AppError> {
    let row: Option<(i64, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT s.id, s.runtime_provider, s.runtime_session_id, s.status
         FROM agent_sessions s
         WHERE s.feature_id = ?
           AND s.runtime_session_id IS NOT NULL
           AND s.runtime_session_id != ''
         ORDER BY s.id DESC
         LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?;

    let (id, provider, runtime_session_id, status) = row.ok_or_else(|| {
        AppError::BadRequest("This conversation has no CLI-backed session to sync from yet.".into())
    })?;

    if status == "running" {
        return Err(AppError::BadRequest(
            "Can't sync while the agent is running. Pause it first.".into(),
        ));
    }

    let provider = provider
        .as_deref()
        .and_then(ImportProvider::from_id)
        .ok_or_else(|| {
            AppError::BadRequest("This provider doesn't support syncing from the CLI.".into())
        })?;

    let runtime_session_id = runtime_session_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("This session has no provider session id to sync from.".into())
        })?;

    // Worktree-aware (see `SessionRef.cwd`): resolving the project root would
    // read an absent log and always report "already up to date". The recorded
    // path wins even when that worktree is gone — the CLI log is keyed by it,
    // so this is a plain read with no liveness check.
    let cwd: Option<String> = sqlx::query_scalar(
        "SELECT COALESCE(NULLIF(TRIM(fs.value), ''), p.path)
         FROM features f
         JOIN projects p ON p.id = f.project_id
         LEFT JOIN feature_settings fs ON fs.feature_id = f.id AND fs.key = 'worktree_path'
         WHERE f.id = ?",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?;
    let cwd = cwd.ok_or_else(|| AppError::NotFound(format!("feature {feature_id} not found")))?;

    Ok(SessionRef {
        id,
        provider,
        runtime_session_id,
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Real schema (migrations) so `resolve_feature_session` can resolve the
    /// worktree-aware cwd, which reads the `features` and
    /// `feature_settings` tables. Feature 1779 lives in project '/repo'.
    async fn pool_with_sessions() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (5, 'repo', '/repo')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status) VALUES (1779, 5, 'f', 'active')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn add_session(pool: &SqlitePool, id: i64, provider: &str, sid: &str, status: &str) {
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, runtime_provider, runtime_session_id, status) VALUES (?, 1779, 'claude', ?, ?, ?)")
            .bind(id).bind(provider).bind(sid).bind(status)
            .execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn resolves_latest_cli_backed_session_for_feature() {
        let pool = pool_with_sessions().await;
        add_session(&pool, 100, "claude_code", "uuid-old", "completed").await;
        add_session(&pool, 3290, "claude_code", "uuid-new", "paused").await;

        let session = resolve_feature_session(&pool, 1779).await.unwrap();
        assert_eq!(session.id, 3290);
        assert_eq!(session.runtime_session_id, "uuid-new");
        // No worktree setting → cwd is the project root.
        assert_eq!(session.cwd, "/repo");
    }

    #[tokio::test]
    async fn resolves_cwd_from_worktree_not_project_root() {
        // Regression: a worktree-backed feature's CLI log lives under the
        // worktree path, not the project root. Resolving the project root made
        // sync read an absent log and always report "already up to date".
        let pool = pool_with_sessions().await;
        add_session(&pool, 3290, "claude_code", "uuid-new", "paused").await;
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (1779, 'worktree_path', '/repo/.worktrees/wt')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let session = resolve_feature_session(&pool, 1779).await.unwrap();
        assert_eq!(session.cwd, "/repo/.worktrees/wt");
    }

    #[tokio::test]
    async fn rejects_feature_without_cli_session() {
        let pool = pool_with_sessions().await;
        // Session exists but never bound a provider session id.
        add_session(&pool, 100, "claude_code", "", "paused").await;
        let err = resolve_feature_session(&pool, 1779).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn rejects_running_session() {
        let pool = pool_with_sessions().await;
        add_session(&pool, 3290, "claude_code", "uuid-new", "running").await;
        let err = resolve_feature_session(&pool, 1779).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }
}
