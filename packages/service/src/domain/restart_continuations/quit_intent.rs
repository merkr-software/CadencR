//! What the desktop said the next start should do with the agents its quit
//! stops, kept in the database until that start consumes it.
//!
//! The shutdown capture applies it as it records each cut-off turn. When that
//! capture fails, the next start captures the leftovers as a crash; without
//! this record it would resume them, against what the user chose.

use sqlx::SqlitePool;

use super::store::{Intent, Intents};

fn intent(resume: bool) -> Intent {
    if resume {
        Intent::Resume
    } else {
        Intent::Stop
    }
}

/// Keep the intent of the quit about to happen. Resuming everything is what
/// a start without one does, so that intent is kept as no record.
pub(super) async fn record(
    pool: &SqlitePool,
    resume_turns: bool,
    resume_background_work: bool,
) -> Result<(), sqlx::Error> {
    if resume_turns && resume_background_work {
        sqlx::query("DELETE FROM restart_quit_intent")
            .execute(pool)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO restart_quit_intent (id, resume_turns, resume_background_work)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             resume_turns = excluded.resume_turns,
             resume_background_work = excluded.resume_background_work,
             recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(resume_turns)
    .bind(resume_background_work)
    .execute(pool)
    .await?;
    Ok(())
}

/// Consume the last process's quit intent: what this start does with the
/// turns that process left behind. None after a crash or an update. Runs in
/// the capture's transaction, so a failed capture keeps it for the next start.
pub(super) async fn take(
    conn: &mut sqlx::SqliteConnection,
) -> Result<Option<Intents>, sqlx::Error> {
    let row: Option<(bool, bool)> = sqlx::query_as(
        "DELETE FROM restart_quit_intent WHERE id = 1 RETURNING resume_turns, resume_background_work",
    )
    .fetch_optional(conn)
    .await?;
    Ok(row.map(intents))
}

pub(super) async fn read(conn: &mut sqlx::SqliteConnection) -> Result<Intents, sqlx::Error> {
    let row = sqlx::query_as(
        "SELECT resume_turns, resume_background_work FROM restart_quit_intent WHERE id = 1",
    )
    .fetch_optional(conn)
    .await?;
    Ok(row.map(intents).unwrap_or(Intent::Resume.into()))
}

fn intents((turns, background): (bool, bool)) -> Intents {
    Intents {
        turn: intent(turns),
        background: intent(background),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn the_next_start_consumes_the_last_quit_intent_once() {
        let (pool, _, _) = fixture().await;
        assert_eq!(
            take(&mut pool.acquire().await.unwrap()).await.unwrap(),
            None,
            "a crash leaves none"
        );

        record(&pool, false, false).await.unwrap();
        record(&pool, true, false).await.unwrap();

        let expected = Intents {
            turn: Intent::Resume,
            background: Intent::Stop,
        };
        assert_eq!(
            take(&mut pool.acquire().await.unwrap()).await.unwrap(),
            Some(expected)
        );
        assert_eq!(
            take(&mut pool.acquire().await.unwrap()).await.unwrap(),
            None
        );
    }

    /// A quit that failed sets the intent back to resuming everything.
    #[tokio::test]
    async fn resuming_everything_is_kept_as_no_record() {
        let (pool, _, _) = fixture().await;
        record(&pool, false, false).await.unwrap();
        record(&pool, true, true).await.unwrap();
        assert_eq!(
            take(&mut pool.acquire().await.unwrap()).await.unwrap(),
            None
        );
    }
}
