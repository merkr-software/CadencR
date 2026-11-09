//! The durable record of an archive's cleanup (`feature_archive_cleanup_steps`):
//! the plan written with the archive, then each step's outcome.

use sqlx::{FromRow, Sqlite, SqlitePool, Transaction};

use super::{CleanupReport, CleanupSelection, StepName, StepOutcome, StepStatus};
use crate::error::AppError;

/// One planned step, as stored.
#[derive(Debug, Clone)]
pub struct PlannedStep {
    pub step: StepName,
    pub force: bool,
    pub implied: bool,
    pub outcome: StepOutcome,
}

#[derive(FromRow)]
struct StepRow {
    step: String,
    status: String,
    force: bool,
    implied: bool,
    reason: Option<String>,
    message: Option<String>,
    detail: Option<String>,
}

impl StepRow {
    fn into_planned(self) -> Option<PlannedStep> {
        Some(PlannedStep {
            step: StepName::parse(&self.step)?,
            force: self.force,
            implied: self.implied,
            outcome: StepOutcome {
                status: StepStatus::parse(&self.status)?,
                reason: self.reason,
                message: self.message,
                detail: self.detail,
            },
        })
    }
}

/// The steps a selection asks for, in run order. As in the dialog, removing
/// the branch takes the worktree with it: git won't delete a branch that is
/// still checked out there.
pub fn steps_for(selection: &CleanupSelection) -> Vec<PlannedStep> {
    let mut steps = Vec::new();
    let mut push = |step, force, implied| {
        steps.push(PlannedStep {
            step,
            force,
            implied,
            outcome: StepOutcome::pending(None),
        })
    };
    if selection.kill_terminals {
        push(StepName::Terminals, false, false);
    }
    if selection.close_browser_tabs {
        push(StepName::BrowserTabs, false, false);
    }
    if selection.remove_worktree || selection.remove_branch {
        push(
            StepName::Worktree,
            selection.force_remove_worktree,
            !selection.remove_worktree,
        );
    }
    if selection.remove_branch {
        push(StepName::Branch, selection.force_remove_branch, false);
    }
    steps
}

/// Replace the feature's cleanup with `steps`, all pending. Called inside the
/// archive's transaction: an archive is never committed without its plan.
pub async fn plan(
    tx: &mut Transaction<'_, Sqlite>,
    feature_id: i64,
    steps: &[PlannedStep],
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM feature_archive_cleanup_steps WHERE feature_id = ?")
        .bind(feature_id)
        .execute(&mut **tx)
        .await?;
    for planned in steps {
        sqlx::query(
            "INSERT INTO feature_archive_cleanup_steps \
             (feature_id, step, position, status, force, implied) \
             VALUES (?, ?, ?, 'pending', ?, ?)",
        )
        .bind(feature_id)
        .bind(planned.step.as_str())
        .bind(planned.step.position())
        .bind(planned.force)
        .bind(planned.implied)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub async fn load(pool: &SqlitePool, feature_id: i64) -> Result<Vec<PlannedStep>, AppError> {
    let rows: Vec<StepRow> = sqlx::query_as(
        "SELECT step, status, force, implied, reason, message, detail \
         FROM feature_archive_cleanup_steps WHERE feature_id = ? ORDER BY position",
    )
    .bind(feature_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(StepRow::into_planned).collect())
}

/// The report clients see. An implied worktree step that had nothing to do
/// goes unreported, as in the dialog.
pub fn report(steps: &[PlannedStep]) -> CleanupReport {
    let mut report = CleanupReport::default();
    for planned in steps {
        if planned.implied && planned.outcome.status == StepStatus::Skipped {
            continue;
        }
        *report.slot(planned.step) = Some(planned.outcome.clone());
    }
    report
}

pub async fn record(
    pool: &SqlitePool,
    feature_id: i64,
    step: StepName,
    outcome: &StepOutcome,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE feature_archive_cleanup_steps \
         SET status = ?, reason = ?, message = ?, detail = ?, updated_at = datetime('now') \
         WHERE feature_id = ? AND step = ?",
    )
    .bind(outcome.status.as_str())
    .bind(&outcome.reason)
    .bind(&outcome.message)
    .bind(&outcome.detail)
    .bind(feature_id)
    .bind(step.as_str())
    .execute(pool)
    .await?;
    Ok(())
}

/// The user confirmed forcing `step` (after it was blocked).
pub async fn set_force(pool: &SqlitePool, feature_id: i64, step: StepName) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE feature_archive_cleanup_steps SET force = 1 WHERE feature_id = ? AND step = ?",
    )
    .bind(feature_id)
    .bind(step.as_str())
    .execute(pool)
    .await?;
    Ok(())
}

/// Unarchiving abandons the cleanup: the conversation is in use again.
pub async fn clear(pool: &SqlitePool, feature_id: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM feature_archive_cleanup_steps WHERE feature_id = ?")
        .bind(feature_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Startup: nothing runs any more, so a running step, or a pending one that
/// was only queued, was cut short. A step pending on something else (the
/// desktop app, the worktree) still waits for it.
pub async fn interrupt_unsettled(pool: &SqlitePool) -> Result<u64, AppError> {
    let result = sqlx::query(
        "UPDATE feature_archive_cleanup_steps \
         SET status = 'interrupted', reason = NULL, updated_at = datetime('now') \
         WHERE status = 'running' OR (status = 'pending' AND reason IS NULL)",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Archived conversations whose cleanup has a step left to settle.
pub async fn unsettled_feature_ids(pool: &SqlitePool) -> Result<Vec<i64>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT c.feature_id FROM feature_archive_cleanup_steps c \
         JOIN features f ON f.id = c.feature_id \
         WHERE f.status = 'archived' AND c.status NOT IN ('done', 'skipped') \
         ORDER BY c.feature_id",
    )
    .fetch_all(pool)
    .await?)
}

/// Archived conversations whose browser step waits for a desktop or was cut short.
pub async fn browser_steps_to_resume(pool: &SqlitePool) -> Result<Vec<i64>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT c.feature_id FROM feature_archive_cleanup_steps c \
         JOIN features f ON f.id = c.feature_id \
         WHERE f.status = 'archived' AND c.step = 'browser_tabs' \
           AND c.status IN ('pending', 'interrupted') \
         ORDER BY c.feature_id",
    )
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup() -> (SqlitePool, i64) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('p', '/tmp/p') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let feature: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title, status) VALUES (?, 'f', 'archived') RETURNING id",
        )
        .bind(project)
        .fetch_one(&pool)
        .await
        .unwrap();
        (pool, feature)
    }

    async fn plan_for(pool: &SqlitePool, feature: i64, selection: &CleanupSelection) {
        let mut tx = pool.begin().await.unwrap();
        plan(&mut tx, feature, &steps_for(selection)).await.unwrap();
        tx.commit().await.unwrap();
    }

    #[test]
    fn removing_the_branch_implies_the_worktree_and_keeps_run_order() {
        let steps = steps_for(&CleanupSelection {
            close_browser_tabs: true,
            kill_terminals: true,
            remove_branch: true,
            force_remove_branch: true,
            ..Default::default()
        });
        let names: Vec<_> = steps.iter().map(|s| s.step).collect();
        assert_eq!(
            names,
            [
                StepName::Terminals,
                StepName::BrowserTabs,
                StepName::Worktree,
                StepName::Branch
            ]
        );
        assert!(steps[2].implied && !steps[2].force);
        assert!(steps[3].force && !steps[3].implied);
    }

    #[tokio::test]
    async fn a_restart_interrupts_what_was_pending_or_running_and_keeps_the_rest() {
        let (pool, feature) = setup().await;
        let selection = CleanupSelection {
            kill_terminals: true,
            close_browser_tabs: true,
            remove_worktree: true,
            remove_branch: true,
            ..Default::default()
        };
        plan_for(&pool, feature, &selection).await;
        record(
            &pool,
            feature,
            StepName::Terminals,
            &StepOutcome::done(None),
        )
        .await
        .unwrap();
        record(
            &pool,
            feature,
            StepName::BrowserTabs,
            &StepOutcome::running(),
        )
        .await
        .unwrap();

        assert_eq!(interrupt_unsettled(&pool).await.unwrap(), 3);
        let report = report(&load(&pool, feature).await.unwrap());
        assert_eq!(report.terminals.unwrap().status, StepStatus::Done);
        assert_eq!(report.browser_tabs.unwrap().status, StepStatus::Interrupted);
        assert_eq!(report.worktree.unwrap().status, StepStatus::Interrupted);
        assert_eq!(unsettled_feature_ids(&pool).await.unwrap(), [feature]);
        assert_eq!(browser_steps_to_resume(&pool).await.unwrap(), [feature]);
    }

    #[tokio::test]
    async fn a_restart_leaves_a_step_waiting_for_the_desktop_waiting() {
        let (pool, feature) = setup().await;
        let selection = CleanupSelection {
            close_browser_tabs: true,
            ..Default::default()
        };
        plan_for(&pool, feature, &selection).await;
        let waiting = StepOutcome::pending(Some("waiting for the desktop app".into()));
        record(&pool, feature, StepName::BrowserTabs, &waiting)
            .await
            .unwrap();

        assert_eq!(interrupt_unsettled(&pool).await.unwrap(), 0);
        let report = report(&load(&pool, feature).await.unwrap());
        assert_eq!(report.browser_tabs, Some(waiting));
        assert_eq!(browser_steps_to_resume(&pool).await.unwrap(), [feature]);
    }

    #[tokio::test]
    async fn an_implied_worktree_with_nothing_to_remove_goes_unreported() {
        let (pool, feature) = setup().await;
        let selection = CleanupSelection {
            remove_branch: true,
            ..Default::default()
        };
        plan_for(&pool, feature, &selection).await;
        record(
            &pool,
            feature,
            StepName::Worktree,
            &StepOutcome::skipped("none"),
        )
        .await
        .unwrap();
        record(&pool, feature, StepName::Branch, &StepOutcome::done(None))
            .await
            .unwrap();
        let report = report(&load(&pool, feature).await.unwrap());
        assert!(report.worktree.is_none());
        assert!(report.is_settled());
        assert!(unsettled_feature_ids(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn replanning_replaces_and_unarchive_clears_and_delete_cascades() {
        let (pool, feature) = setup().await;
        plan_for(
            &pool,
            feature,
            &CleanupSelection {
                remove_worktree: true,
                ..Default::default()
            },
        )
        .await;
        plan_for(
            &pool,
            feature,
            &CleanupSelection {
                kill_terminals: true,
                ..Default::default()
            },
        )
        .await;
        let steps = load(&pool, feature).await.unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].step, StepName::Terminals);
        set_force(&pool, feature, StepName::Terminals)
            .await
            .unwrap();
        assert!(load(&pool, feature).await.unwrap()[0].force);
        clear(&pool, feature).await.unwrap();
        assert!(load(&pool, feature).await.unwrap().is_empty());

        plan_for(
            &pool,
            feature,
            &CleanupSelection {
                kill_terminals: true,
                ..Default::default()
            },
        )
        .await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM features WHERE id = ?")
            .bind(feature)
            .execute(&pool)
            .await
            .unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM feature_archive_cleanup_steps")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(left, 0);
    }
}
