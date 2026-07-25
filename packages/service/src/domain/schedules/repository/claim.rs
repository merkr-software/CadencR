use sqlx::SqlitePool;

use super::reads::get;
use crate::domain::schedules::models::Schedule;
use crate::error::AppError;

/// How long a dispatch claim stays honoured before another pass may take it
/// over. A run that is still in flight after this has almost certainly died
/// with the process that owned it; leaving the claim forever would wedge the
/// schedule permanently, which is worse than a rare duplicate.
const STALE_CLAIM_MINUTES: i64 = 15;

pub struct ClaimedSchedule {
    pub schedule: Schedule,
    pub claim_token: String,
}

/// Take ownership of the next due schedule, or `None` when nothing is due.
///
/// The claim is what makes dispatch at-most-once per tick: the row is stamped
/// in the same statement that selects it, so a second pass (or a second
/// process) skips it instead of double-sending.
pub async fn claim_due(pool: &SqlitePool) -> Result<Option<ClaimedSchedule>, AppError> {
    let token = uuid::Uuid::new_v4().to_string();
    let claimed_id: Option<i64> = sqlx::query_scalar(
        "UPDATE schedules
         SET claim_token = ?, claimed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = (
             SELECT id FROM schedules
             WHERE enabled = 1
               AND next_run_at IS NOT NULL
               AND next_run_at <= datetime('now')
               AND (
                   claim_token IS NULL
                   OR claimed_at IS NULL
                   OR claimed_at <= datetime('now', ?)
               )
             ORDER BY next_run_at ASC
             LIMIT 1
         )
         RETURNING id",
    )
    .bind(&token)
    .bind(format!("-{STALE_CLAIM_MINUTES} minutes"))
    .fetch_optional(pool)
    .await?;

    let Some(id) = claimed_id else {
        return Ok(None);
    };
    // The projection joins conversation/project context, which RETURNING can't
    // produce, so the claimed row is read back through the shared query.
    let Some(schedule) = get(pool, id).await? else {
        return Ok(None);
    };
    Ok(Some(ClaimedSchedule {
        schedule,
        claim_token: token,
    }))
}

/// Outcome of one dispatch attempt.
pub struct RunOutcome {
    pub status: &'static str,
    /// Surfaced verbatim on the schedule row so the user sees *why* nothing
    /// arrived, not merely that nothing did.
    pub error: Option<String>,
    /// Conversation the run landed in, for the "open last run" link.
    pub feature_id: Option<i64>,
    /// Where the rule points next; `None` finishes a one-shot schedule.
    pub next_run_at: Option<String>,
}

/// Record the outcome and roll the rule forward, releasing the claim.
///
/// Guarded on the claim token: if the claim was stolen (a stale-claim takeover
/// after this process stalled), the newer owner is authoritative and this write
/// must not clobber it.
pub async fn finish_run(
    pool: &SqlitePool,
    id: i64,
    token: &str,
    outcome: RunOutcome,
) -> Result<(), AppError> {
    // A skipped run never reached the agent, so it must not inflate the count
    // of runs the user sees, but it does replace `last_status` — that is how
    // the UI explains why nothing arrived.
    let counted = matches!(outcome.status, "sent" | "failed");
    let rows = sqlx::query(
        "UPDATE schedules SET
            last_run_at = datetime('now'),
            last_status = ?,
            last_error = ?,
            last_feature_id = COALESCE(?, last_feature_id),
            run_count = run_count + ?,
            next_run_at = datetime(?),
            claim_token = NULL,
            claimed_at = NULL,
            updated_at = datetime('now')
         WHERE id = ? AND claim_token = ?",
    )
    .bind(outcome.status)
    .bind(&outcome.error)
    .bind(outcome.feature_id)
    .bind(i64::from(counted))
    .bind(&outcome.next_run_at)
    .bind(id)
    .bind(token)
    .execute(pool)
    .await?
    .rows_affected();
    if rows != 1 {
        return Err(AppError::Internal(format!(
            "schedule {id} dispatch claim is no longer current"
        )));
    }
    Ok(())
}

/// Record a manual "run now" outcome. Unlike [`finish_run`] this holds no claim
/// and never touches `next_run_at` — running a schedule by hand reports the
/// result without disturbing when it fires next.
pub async fn record_manual_run(
    pool: &SqlitePool,
    id: i64,
    status: &str,
    error: Option<&str>,
    feature_id: Option<i64>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE schedules SET
            last_run_at = datetime('now'), last_status = ?, last_error = ?,
            last_feature_id = COALESCE(?, last_feature_id),
            run_count = run_count + 1, updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(status)
    .bind(error)
    .bind(feature_id)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{fixture, once_into_conversation};
    use super::super::{insert, set_enabled};
    use super::*;

    /// Insert a schedule and force it due, bypassing the "future only" rule the
    /// save path enforces.
    async fn due_schedule(pool: &SqlitePool, feature_id: i64) -> Schedule {
        let created = insert(
            pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE schedules SET next_run_at = '2000-01-01 09:00:00' WHERE id = ?")
            .bind(created.id)
            .execute(pool)
            .await
            .unwrap();
        created
    }

    #[tokio::test]
    async fn claim_takes_one_due_row_at_a_time() {
        let (pool, _, feature_id) = fixture().await;
        let created = due_schedule(&pool, feature_id).await;

        let claim = claim_due(&pool).await.unwrap().unwrap();
        assert_eq!(claim.schedule.id, created.id);
        // Already claimed: a second pass finds nothing rather than re-sending.
        assert!(claim_due(&pool).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn future_and_paused_schedules_are_never_due() {
        let (pool, _, feature_id) = fixture().await;
        insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        assert!(claim_due(&pool).await.unwrap().is_none());

        let paused = due_schedule(&pool, feature_id).await;
        set_enabled(&pool, paused.id, false).await.unwrap();
        assert!(claim_due(&pool).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn finishing_a_one_off_clears_its_next_run() {
        let (pool, _, feature_id) = fixture().await;
        let created = due_schedule(&pool, feature_id).await;
        let claim = claim_due(&pool).await.unwrap().unwrap();

        finish_run(
            &pool,
            created.id,
            &claim.claim_token,
            RunOutcome {
                status: "sent",
                error: None,
                feature_id: Some(feature_id),
                next_run_at: None,
            },
        )
        .await
        .unwrap();

        let after = super::get(&pool, created.id).await.unwrap().unwrap();
        assert!(after.completed);
        assert_eq!(after.run_count, 1);
        assert_eq!(after.last_run.as_ref().unwrap().status, "sent");
        assert_eq!(after.last_run.unwrap().feature_id, Some(feature_id));
        assert!(claim_due(&pool).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_skipped_run_records_itself_without_counting_as_a_run() {
        let (pool, _, feature_id) = fixture().await;
        let created = due_schedule(&pool, feature_id).await;
        let claim = claim_due(&pool).await.unwrap().unwrap();

        finish_run(
            &pool,
            created.id,
            &claim.claim_token,
            RunOutcome {
                status: "skipped",
                error: Some("missed by more than 24 hours".into()),
                feature_id: None,
                next_run_at: None,
            },
        )
        .await
        .unwrap();

        let after = super::get(&pool, created.id).await.unwrap().unwrap();
        assert_eq!(after.run_count, 0);
        assert_eq!(after.last_run.as_ref().unwrap().status, "skipped");
    }

    // A stolen claim means another pass owns the row; writing anyway would
    // resurrect a run the new owner already rolled forward.
    #[tokio::test]
    async fn finishing_with_a_stale_token_is_rejected() {
        let (pool, _, feature_id) = fixture().await;
        let created = due_schedule(&pool, feature_id).await;
        claim_due(&pool).await.unwrap().unwrap();

        let result = finish_run(
            &pool,
            created.id,
            "not-the-current-token",
            RunOutcome {
                status: "sent",
                error: None,
                feature_id: None,
                next_run_at: None,
            },
        )
        .await;
        assert!(result.is_err());
    }

    // A process that died mid-dispatch must not wedge the schedule forever.
    #[tokio::test]
    async fn an_abandoned_claim_is_reclaimed_once_it_goes_stale() {
        let (pool, _, feature_id) = fixture().await;
        let created = due_schedule(&pool, feature_id).await;
        claim_due(&pool).await.unwrap().unwrap();

        sqlx::query("UPDATE schedules SET claimed_at = datetime('now', '-1 hour') WHERE id = ?")
            .bind(created.id)
            .execute(&pool)
            .await
            .unwrap();

        let reclaimed = claim_due(&pool).await.unwrap().unwrap();
        assert_eq!(reclaimed.schedule.id, created.id);
    }

    #[tokio::test]
    async fn a_manual_run_records_history_without_moving_the_next_run() {
        let (pool, _, feature_id) = fixture().await;
        let created = insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();

        record_manual_run(&pool, created.id, "sent", None, Some(feature_id))
            .await
            .unwrap();

        let after = super::get(&pool, created.id).await.unwrap().unwrap();
        assert_eq!(after.run_count, 1);
        assert_eq!(after.next_run_at, created.next_run_at);
    }
}
