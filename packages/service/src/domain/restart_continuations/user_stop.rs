//! The durable Stop and the transcript entry it owes until settled.

use chrono::{DateTime, Utc};
use sqlx::{SqliteConnection, SqlitePool};

use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::{background_work::stamp, transcript};

/// Only the request that inserted a Stop can undo it. A repeated Stop may
/// be refused while the earlier accepted Stop is still settling.
pub(crate) struct UserStop {
    session_id: i64,
    stopped_at: String,
}

pub(crate) async fn record_user_stop(
    pool: &SqlitePool,
    session_id: i64,
    at: DateTime<Utc>,
) -> Result<Option<UserStop>, sqlx::Error> {
    let stopped_at = stamp(at);
    let inserted = sqlx::query(
        "INSERT INTO agent_user_stops (session_id, stopped_at, marker_pending) VALUES (?, ?, 1)
         ON CONFLICT(session_id) DO NOTHING",
    )
    .bind(session_id)
    .bind(&stopped_at)
    .execute(pool)
    .await?
    .rows_affected();
    Ok((inserted == 1).then_some(UserStop {
        session_id,
        stopped_at,
    }))
}

impl UserStop {
    /// The runtime refused. The existing background record was only masked
    /// by the Stop, so removing the Stop makes that record eligible again.
    pub(crate) async fn undo(self, pool: &SqlitePool) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM agent_user_stops
             WHERE session_id = ? AND stopped_at = ? AND marker_pending = 1",
        )
        .bind(self.session_id)
        .bind(self.stopped_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// The Stop withdrew a prompt before it reached the provider.
    pub(crate) async fn no_turn_started(self, pool: &SqlitePool) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE agent_user_stops SET marker_pending = 0
             WHERE session_id = ? AND stopped_at = ?",
        )
        .bind(self.session_id)
        .bind(self.stopped_at)
        .execute(pool)
        .await?;
        Ok(())
    }
}

/// Finish a live interruption. Other controls, such as sleep, can write
/// the same marker without a durable user Stop.
pub(crate) async fn write_stop_marker(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let pending: Option<bool> = sqlx::query_scalar(
        "UPDATE agent_user_stops SET marker_pending = 0 WHERE session_id = ?
         AND marker_pending = 1 RETURNING TRUE",
    )
    .bind(session_id)
    .fetch_optional(&mut *tx)
    .await?;
    if pending.is_some() || !stop_exists(&mut tx, session_id).await? {
        transcript::insert_marker(&mut tx, session_id, "").await?;
    }
    tx.commit().await
}

async fn stop_exists(conn: &mut SqliteConnection, session_id: i64) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM agent_user_stops WHERE session_id = ?)")
        .bind(session_id)
        .fetch_one(conn)
        .await
}

/// Complete Stops whose process died before the stream reader appended the
/// marker. Runs inside the startup capture transaction, before status resets.
pub(super) async fn reconcile(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE restart_continuations
         SET state = 'skipped', reason = 'stopped_by_user', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE state = 'pending' AND EXISTS (
             SELECT 1 FROM agent_user_stops u WHERE u.session_id = restart_continuations.session_id
         )",
    )
    .execute(&mut *conn)
    .await?;
    // An unmarked legacy Stop can be recovered while the old turn is still
    // recorded as running and its last prompt has no later stop marker.
    let stopped: Vec<i64> = sqlx::query_scalar(
        "UPDATE agent_user_stops AS stop SET marker_pending = 0
         WHERE marker_pending = 1 OR (
             marker_pending IS NULL
             AND EXISTS (SELECT 1 FROM agent_sessions WHERE id = stop.session_id AND status = 'running')
             AND NOT EXISTS (
                 SELECT 1 FROM agent_messages marker
                 WHERE marker.session_id = stop.session_id
                   AND marker.message_type = 'turn_interrupted' AND marker.content = ''
                   AND marker.id > COALESCE((
                       SELECT MAX(id) FROM agent_messages
                       WHERE session_id = stop.session_id AND message_type = 'user_message'
                   ), 0)
             )
         )
         RETURNING session_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    for session_id in stopped {
        WsSessionPersistence::try_clear_all_pending_user_input_static(&mut *conn, session_id)
            .await?;
        transcript::close_running_tool_calls(conn, session_id, transcript::STOP_TOOL_RESULT)
            .await?;
        transcript::insert_marker(conn, session_id, "").await?;
    }
    sqlx::query("UPDATE agent_user_stops SET marker_pending = 0 WHERE marker_pending IS NULL")
        .execute(conn)
        .await?;
    Ok(())
}

/// A finished Stop may still owe its marker if the write failed when the
/// turn ended. Retry before the next prompt enters its transcript.
pub(crate) async fn settle_before_prompt(
    conn: &mut SqliteConnection,
    session_id: i64,
) -> Result<(), sqlx::Error> {
    let pending: Option<bool> = sqlx::query_scalar(
        "UPDATE agent_user_stops SET marker_pending = 0 WHERE session_id = ?1 AND marker_pending = 1
         AND EXISTS (SELECT 1 FROM agent_sessions WHERE id = ?1 AND status <> 'running')
         RETURNING TRUE",
    )
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    if pending.is_some() {
        transcript::insert_marker(conn, session_id, "").await?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum TurnHandoff {
    Prompt,
    Provider,
}

/// Start the successor turn atomically with clearing the previous Stop.
/// Its old background work must not become eligible again, and a late
/// marker for the previous turn must not interrupt the new transcript.
pub(crate) async fn mark_running_after_stop(
    pool: &SqlitePool,
    session_id: i64,
    handoff: TurnHandoff,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    // A known new prompt can supersede a still-ending turn. A provider
    // signal can also be late, so it only forgets a settled Stop.
    if matches!(handoff, TurnHandoff::Provider) {
        settle_before_prompt(&mut tx, session_id).await?;
    }
    let stopped: Option<bool> = sqlx::query_scalar(
        "DELETE FROM agent_user_stops WHERE session_id = ? AND (marker_pending = 0 OR ?) RETURNING TRUE",
    )
    .bind(session_id)
    .bind(matches!(handoff, TurnHandoff::Prompt))
    .fetch_optional(&mut *tx)
    .await?;
    if stopped.is_some() {
        sqlx::query("DELETE FROM agent_background_work WHERE session_id = ?")
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
    }
    WsSessionPersistence::mark_running_static(&mut *tx, session_id).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::tests::session;
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn a_failed_live_marker_is_repaired_before_the_next_prompt() {
        let (pool, _, feature_id) = fixture().await;
        let id = session(&pool, feature_id, "completed").await;
        record_user_stop(&pool, id, Utc::now()).await.unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER reject_stop_marker BEFORE INSERT ON agent_messages
             WHEN NEW.message_type = 'turn_interrupted'
             BEGIN SELECT RAISE(ABORT, 'unavailable'); END;",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(write_stop_marker(&pool, id).await.is_err());
        sqlx::query("DROP TRIGGER reject_stop_marker")
            .execute(&pool)
            .await
            .unwrap();
        let persistence = WsSessionPersistence::with_session_id(pool.clone(), feature_id, Some(id));

        persistence
            .persist_prompt_user_message("New turn", uuid::Uuid::new_v4(), None)
            .await
            .unwrap();
        mark_running_after_stop(&pool, id, TurnHandoff::Prompt)
            .await
            .unwrap();

        let transcript: Vec<String> = sqlx::query_scalar(
            "SELECT message_type FROM agent_messages WHERE session_id = ? ORDER BY id",
        )
        .bind(id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(transcript, ["turn_interrupted", "user_message"]);
    }
}
