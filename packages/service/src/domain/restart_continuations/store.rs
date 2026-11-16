//! SQL for `restart_continuations`.

use sqlx::{FromRow, SqlitePool};

use super::{transcript, QUIT_MARKER_CONTENT, RESTART_MARKER_CONTENT};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Cause {
    Shutdown,
    Crash,
}

impl Cause {
    fn as_str(self) -> &'static str {
        match self {
            Self::Shutdown => "shutdown",
            Self::Crash => "crash",
        }
    }
}

/// What the user wanted for a captured turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Intent {
    Resume,
    /// They quit Cadencr and chose to stop their agents.
    Stop,
}

impl Intent {
    fn as_str(self) -> &'static str {
        match self {
            Self::Resume => "resume",
            Self::Stop => "stop",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Resolution {
    Resumed,
    Skipped,
    Failed,
}

impl Resolution {
    fn as_str(self) -> &'static str {
        match self {
            Self::Resumed => "resumed",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }
}

/// A captured turn with the session and conversation state the guards read.
#[derive(Debug, Clone, FromRow)]
pub(super) struct PendingContinuation {
    pub id: i64,
    pub session_id: i64,
    pub app_version: Option<String>,
    pub intent: String,
    pub marker_message_id: Option<i64>,
    pub feature_id: i64,
    pub project_id: i64,
    pub feature_title: String,
    pub feature_archived: bool,
    pub has_resume_id: bool,
}

impl PendingContinuation {
    pub(super) fn stop_requested(&self) -> bool {
        self.intent == Intent::Stop.as_str()
    }
}

/// Open a continuation for every top-level session still mid-turn. A session
/// that already has one open (shutdown capture, then the crash capture of the
/// next start) keeps it: the partial unique index turns the insert into a no-op.
pub(super) async fn capture_running(
    pool: &SqlitePool,
    cause: Cause,
    intent: Intent,
    app_version: Option<&str>,
) -> Result<u64, sqlx::Error> {
    capture(pool, cause, intent, app_version, None).await
}

/// [`capture_running`] for one session: a turn shutdown cut off that the
/// capture at the start of the shutdown did not see.
pub(super) async fn capture_session(
    pool: &SqlitePool,
    session_id: i64,
    intent: Intent,
    app_version: Option<&str>,
) -> Result<u64, sqlx::Error> {
    capture(pool, Cause::Shutdown, intent, app_version, Some(session_id)).await
}

async fn capture(
    pool: &SqlitePool,
    cause: Cause,
    intent: Intent,
    app_version: Option<&str>,
    session_id: Option<i64>,
) -> Result<u64, sqlx::Error> {
    // Top-level sessions mid-turn, optionally just one. A `!` command the
    // user runs through Cadencr marks its session `running` too, but there is
    // no agent turn to resume: its transcript row, still `running`, tells it
    // apart.
    let result = sqlx::query(
        "INSERT OR IGNORE INTO restart_continuations (session_id, cause, intent, app_version)
         SELECT id, ?, ?, ? FROM agent_sessions
         WHERE status = 'running' AND agent_type = 'session'
           AND (? IS NULL OR id = ?)
           AND NOT EXISTS (
               SELECT 1 FROM agent_messages m
               WHERE m.session_id = agent_sessions.id
                 AND m.message_type = 'tool_call' AND m.tool_name = 'Bash'
                 AND json_valid(m.content)
                 AND json_extract(m.content, '$.__cadencr_user_shell.strategy') = 'cadencr_managed'
                 AND json_extract(m.content, '$.status') = 'running'
           )",
    )
    .bind(cause.as_str())
    .bind(intent.as_str())
    .bind(app_version)
    .bind(session_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub(super) async fn list_pending(
    pool: &SqlitePool,
) -> Result<Vec<PendingContinuation>, sqlx::Error> {
    sqlx::query_as::<_, PendingContinuation>(
        "SELECT rc.id, rc.session_id, rc.app_version, rc.intent, rc.marker_message_id,
                s.feature_id, f.project_id, COALESCE(f.title, '') AS feature_title,
                (f.status = 'archived') AS feature_archived,
                (NULLIF(s.runtime_session_id, '') IS NOT NULL) AS has_resume_id
         FROM restart_continuations rc
         JOIN agent_sessions s ON s.id = rc.session_id
         JOIN features f ON f.id = s.feature_id
         WHERE rc.state = 'pending'
         ORDER BY rc.id",
    )
    .fetch_all(pool)
    .await
}

/// The session's status now. The pass reads it right before it touches the
/// transcript: something may have started a turn since the capture.
pub(super) async fn session_status(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(pool)
        .await
}

/// How many times a crash cut this conversation's turn off in the last
/// `window_minutes`. Feeds the loop guard.
pub(super) async fn recent_crashes(
    pool: &SqlitePool,
    session_id: i64,
    window_minutes: i64,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM restart_continuations
         WHERE session_id = ? AND cause = 'crash'
           AND captured_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
    )
    .bind(session_id)
    .bind(format!("-{window_minutes} minutes"))
    .fetch_one(pool)
    .await
}

pub(super) async fn resolve(
    pool: &SqlitePool,
    id: i64,
    resolution: Resolution,
    reason: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE restart_continuations
         SET state = ?, reason = ?, resolved_at = ?
         WHERE id = ? AND state = 'pending'",
    )
    .bind(resolution.as_str())
    .bind(reason)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// A resume recorded before its prompt was sent, whose sending then failed.
pub(super) async fn fail_resumed(
    pool: &SqlitePool,
    id: i64,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE restart_continuations SET state = 'failed', reason = ?
         WHERE id = ? AND state = 'resumed'",
    )
    .bind(reason)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark the transcript as interrupted by a restart (or stopped by quitting),
/// once per continuation:
/// close the tool calls the restart killed, then add the marker. All of it is
/// written with the row that remembers it, so a pass that dies and runs again
/// never writes any of it twice.
pub(super) async fn write_marker(
    pool: &SqlitePool,
    continuation: &PendingContinuation,
) -> Result<(), sqlx::Error> {
    if continuation.marker_message_id.is_some() {
        return Ok(());
    }
    let (marker, tool_result) = if continuation.stop_requested() {
        (QUIT_MARKER_CONTENT, transcript::QUIT_TOOL_RESULT)
    } else {
        (RESTART_MARKER_CONTENT, transcript::INTERRUPTED_TOOL_RESULT)
    };
    let mut tx = pool.begin().await?;
    transcript::close_running_tool_calls(&mut tx, continuation.session_id, tool_result).await?;
    let marker_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (session_id, role, content, message_type)
         VALUES (?, 'system', ?, 'turn_interrupted')
         RETURNING id",
    )
    .bind(continuation.session_id)
    .bind(marker)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE restart_continuations SET marker_message_id = ? WHERE id = ?")
        .bind(marker_id)
        .bind(continuation.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::domain::schedules::repository::test_support::fixture;

    pub(in crate::domain::restart_continuations) async fn session(
        pool: &SqlitePool,
        feature_id: i64,
        status: &str,
    ) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status, runtime_session_id)
             VALUES (?, 'session', ?, 'runtime-1') RETURNING id",
        )
        .bind(feature_id)
        .bind(status)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn capture_opens_one_continuation_per_running_session() {
        let (pool, _, feature_id) = fixture().await;
        let running = session(&pool, feature_id, "running").await;
        session(&pool, feature_id, "paused").await;

        let first = capture_running(&pool, Cause::Shutdown, Intent::Resume, Some("1.0.0")).await;
        let second = capture_running(&pool, Cause::Crash, Intent::Resume, None).await;

        assert_eq!(first.unwrap(), 1);
        assert_eq!(second.unwrap(), 0, "the open shutdown capture wins");
        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session_id, running);
        assert_eq!(pending[0].app_version.as_deref(), Some("1.0.0"));
        assert!(pending[0].has_resume_id);
    }

    #[tokio::test]
    async fn a_resolved_continuation_lets_a_later_restart_capture_again() {
        let (pool, _, feature_id) = fixture().await;
        let running = session(&pool, feature_id, "running").await;
        capture_running(&pool, Cause::Crash, Intent::Resume, None)
            .await
            .unwrap();
        let id = list_pending(&pool).await.unwrap()[0].id;

        resolve(&pool, id, Resolution::Resumed, None).await.unwrap();
        assert!(list_pending(&pool).await.unwrap().is_empty());
        assert_eq!(
            capture_running(&pool, Cause::Crash, Intent::Resume, None)
                .await
                .unwrap(),
            1
        );
        assert_eq!(recent_crashes(&pool, running, 10).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn only_crashes_count_toward_the_loop_guard() {
        let (pool, _, feature_id) = fixture().await;
        let running = session(&pool, feature_id, "running").await;
        for cause in [Cause::Shutdown, Cause::Crash] {
            capture_running(&pool, cause, Intent::Resume, None)
                .await
                .unwrap();
            let id = list_pending(&pool).await.unwrap()[0].id;
            resolve(&pool, id, Resolution::Resumed, None).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO restart_continuations (session_id, cause, captured_at, state)
             VALUES (?, 'crash', '2000-01-01T00:00:00.000Z', 'resumed')",
        )
        .bind(running)
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(recent_crashes(&pool, running, 10).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn a_user_shell_command_is_not_an_agent_turn_to_resume() {
        let (pool, _, feature_id) = fixture().await;
        let shell = session(&pool, feature_id, "running").await;
        sqlx::query(
            r#"INSERT INTO agent_messages (session_id, role, message_type, tool_name, content)
               VALUES (?, 'assistant', 'tool_call', 'Bash',
                 '{"status":"running","__cadencr_user_shell":{"strategy":"cadencr_managed"}}')"#,
        )
        .bind(shell)
        .execute(&pool)
        .await
        .unwrap();
        let agent = session(&pool, feature_id, "running").await;

        assert_eq!(
            capture_running(&pool, Cause::Shutdown, Intent::Resume, None)
                .await
                .unwrap(),
            1
        );
        assert_eq!(list_pending(&pool).await.unwrap()[0].session_id, agent);
        assert_eq!(
            capture_session(&pool, shell, Intent::Resume, None)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn a_session_capture_only_opens_that_session() {
        let (pool, _, feature_id) = fixture().await;
        session(&pool, feature_id, "running").await;
        let late = session(&pool, feature_id, "running").await;

        assert_eq!(
            capture_session(&pool, late, Intent::Stop, None)
                .await
                .unwrap(),
            1
        );
        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session_id, late);
        assert!(pending[0].stop_requested());
    }

    #[tokio::test]
    async fn the_restart_marker_is_written_once() {
        let (pool, _, feature_id) = fixture().await;
        let running = session(&pool, feature_id, "running").await;
        capture_running(&pool, Cause::Shutdown, Intent::Resume, None)
            .await
            .unwrap();

        let pending = list_pending(&pool).await.unwrap().remove(0);
        write_marker(&pool, &pending).await.unwrap();
        let reloaded = list_pending(&pool).await.unwrap().remove(0);
        write_marker(&pool, &reloaded).await.unwrap();

        let markers: Vec<(String,)> = sqlx::query_as(
            "SELECT content FROM agent_messages
             WHERE session_id = ? AND message_type = 'turn_interrupted'",
        )
        .bind(running)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(markers, vec![(RESTART_MARKER_CONTENT.to_string(),)]);
    }
}
