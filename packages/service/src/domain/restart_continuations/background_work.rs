//! Conversations whose runtime still owes them a resume between turns.
//!
//! A provider can launch work that outlives the turn (background commands,
//! agents, monitors, a scheduled wake-up) and start the next turn on its own
//! once it settles. The session is not `running` meanwhile, so the turn
//! capture alone would miss it: a restart kills the work with its runtime and
//! the conversation waits forever. The stream reader records here when its
//! runtime starts and stops owing a resume; the restart capture reads it.
//!
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

/// The form timestamps here are stored and compared in.
pub(super) fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
}

/// Publish work on behalf of the current reader, or forget only that reader's
/// work. A stopped turn's reader may already be writing when Stop arrives.
pub(crate) async fn write_background_work(
    pool: &SqlitePool,
    session_id: i64,
    reader_id: &str,
    owed_since: Option<DateTime<Utc>>,
) -> Result<bool, sqlx::Error> {
    let result = match owed_since {
        Some(since) => {
            sqlx::query(
                "INSERT INTO agent_background_work (session_id, since, reader_id)
             SELECT ?1, ?2, ?3 WHERE NOT EXISTS (
                 SELECT 1 FROM agent_user_stops WHERE session_id = ?1
             )
             ON CONFLICT(session_id) DO UPDATE SET
                 since = excluded.since, reader_id = excluded.reader_id",
            )
            .bind(session_id)
            .bind(stamp(since))
            .bind(reader_id)
            .execute(pool)
            .await?
        }
        None => {
            sqlx::query("DELETE FROM agent_background_work WHERE session_id = ? AND reader_id = ?")
                .bind(session_id)
                .bind(reader_id)
                .execute(pool)
                .await?
        }
    };
    Ok(owed_since.is_some() && result.rows_affected() == 1)
}

#[cfg(test)]
pub(crate) async fn record_background_work(
    pool: &SqlitePool,
    session_id: i64,
    owed_since: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    write_background_work(pool, session_id, "test-reader", owed_since)
        .await
        .map(|_| ())
}

/// Forget every record once the restart capture has read them: the runtimes
/// that owed those resumes are gone. Runs in the capture's transaction.
pub(super) async fn clear(conn: &mut sqlx::SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM agent_background_work")
        .execute(conn)
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

        clear(&mut pool.acquire().await.unwrap()).await.unwrap();
        assert!(recorded(&pool).await.is_empty());
    }

    #[tokio::test]
    async fn an_older_reader_cannot_clear_its_successors_work() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id, "completed").await;
        let since = Some(Utc::now());
        write_background_work(&pool, session_id, "old", since)
            .await
            .unwrap();
        write_background_work(&pool, session_id, "new", since)
            .await
            .unwrap();

        write_background_work(&pool, session_id, "old", None)
            .await
            .unwrap();

        assert_eq!(recorded(&pool).await, vec![session_id]);
        write_background_work(&pool, session_id, "new", None)
            .await
            .unwrap();
        assert!(recorded(&pool).await.is_empty());
    }
}
