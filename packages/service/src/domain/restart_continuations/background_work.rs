//! Conversations whose runtime still owes them a resume between turns.
//!
//! A provider can launch work that outlives the turn (background commands,
//! agents, monitors, a scheduled wake-up) and start the next turn on its own
//! once it settles. The session is not `running` meanwhile, so the turn
//! capture alone would miss it: a restart kills the work with its runtime and
//! the conversation waits forever. The stream reader records here when its
//! runtime starts and stops owing a resume; the restart capture reads it.

use sqlx::SqlitePool;

/// Record whether the runtime of `session_id` owes the conversation a resume.
pub async fn record_background_work(
    pool: &SqlitePool,
    session_id: i64,
    owed: bool,
) -> Result<(), sqlx::Error> {
    let query = if owed {
        "INSERT OR IGNORE INTO agent_background_work (session_id) VALUES (?)"
    } else {
        "DELETE FROM agent_background_work WHERE session_id = ?"
    };
    sqlx::query(query).bind(session_id).execute(pool).await?;
    Ok(())
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

        record_background_work(&pool, first, true).await.unwrap();
        record_background_work(&pool, first, true).await.unwrap();
        record_background_work(&pool, second, true).await.unwrap();
        assert_eq!(recorded(&pool).await, vec![first, second]);

        record_background_work(&pool, first, false).await.unwrap();
        assert_eq!(recorded(&pool).await, vec![second]);

        clear(&pool).await.unwrap();
        assert!(recorded(&pool).await.is_empty());
    }
}
