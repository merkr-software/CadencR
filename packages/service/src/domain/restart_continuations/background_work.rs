//! Conversations whose runtime still owes them a resume between turns.
//!
//! A provider can launch work that outlives the turn (background commands,
//! agents, monitors, a scheduled wake-up) and start the next turn on its own
//! once it settles. The session is not `running` meanwhile, so the turn
//! capture alone would miss it: a restart kills the work with its runtime and
//! the conversation waits forever. The stream reader records here when its
//! runtime starts and stops owing a resume; the restart capture reads it.
//!
//! A user's Stop ends that resume for good: [`record_user_stop`] forgets the
//! record and remembers when, so a record written by a reader that decided
//! before the Stop is never resumed either.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

/// The form timestamps here are stored and compared in.
fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
}

/// Record that the runtime of `session_id` owes the conversation a resume,
/// as decided at `owed_since`, or (`None`) that it no longer does.
pub async fn record_background_work(
    pool: &SqlitePool,
    session_id: i64,
    owed_since: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    match owed_since {
        Some(since) => {
            sqlx::query(
                "INSERT OR IGNORE INTO agent_background_work (session_id, since) VALUES (?, ?)",
            )
            .bind(session_id)
            .bind(stamp(since))
            .execute(pool)
            .await?
        }
        None => {
            sqlx::query("DELETE FROM agent_background_work WHERE session_id = ?")
                .bind(session_id)
                .execute(pool)
                .await?
        }
    };
    Ok(())
}

/// The user is stopping `session_id`'s agent: forget the resume its runtime
/// owed, and remember the Stop so the restart capture skips any record from
/// before it. Both in one write, before the runtime is told to stop: the
/// marker that shows the stop comes later.
pub async fn record_user_stop(
    pool: &SqlitePool,
    session_id: i64,
    at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM agent_background_work WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO agent_user_stops (session_id, stopped_at) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET stopped_at = excluded.stopped_at",
    )
    .bind(session_id)
    .bind(stamp(at))
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Forget every record once the restart capture has read them: the runtimes
/// that owed those resumes are gone.
pub(super) async fn clear(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM agent_background_work")
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::tests::session;
    use crate::domain::schedules::repository::test_support::fixture;

    async fn recorded(pool: &SqlitePool) -> Vec<i64> {
        sqlx::query_scalar("SELECT session_id FROM agent_background_work ORDER BY session_id")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn records_are_idempotent_and_cleared_per_session_or_all_at_once() {
        let (pool, _, feature_id) = fixture().await;
        let first = session(&pool, feature_id, "completed").await;
        let second = session(&pool, feature_id, "completed").await;
        let now = Some(Utc::now());

        record_background_work(&pool, first, now).await.unwrap();
        record_background_work(&pool, first, now).await.unwrap();
        record_background_work(&pool, second, now).await.unwrap();
        assert_eq!(recorded(&pool).await, vec![first, second]);

        record_background_work(&pool, first, None).await.unwrap();
        assert_eq!(recorded(&pool).await, vec![second]);

        clear(&pool).await.unwrap();
        assert!(recorded(&pool).await.is_empty());
    }

    #[tokio::test]
    async fn a_user_stop_forgets_the_record_and_remembers_when() {
        let (pool, _, feature_id) = fixture().await;
        let stopped = session(&pool, feature_id, "running").await;
        record_background_work(&pool, stopped, Some(Utc::now()))
            .await
            .unwrap();
        let at = Utc::now();

        record_user_stop(&pool, stopped, at).await.unwrap();
        record_user_stop(&pool, stopped, at).await.unwrap();

        assert!(recorded(&pool).await.is_empty());
        let stops: Vec<(i64, String)> =
            sqlx::query_as("SELECT session_id, stopped_at FROM agent_user_stops")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(stops, vec![(stopped, stamp(at))]);
    }
}
