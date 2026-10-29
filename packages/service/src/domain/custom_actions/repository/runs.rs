use std::collections::HashMap;

use sqlx::SqlitePool;

use super::super::models::{CustomActionRun, LastRunSummary, TriggeredBy};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// custom_action_runs
// ---------------------------------------------------------------------------

pub async fn insert_run(
    pool: &SqlitePool,
    action_id: i64,
    feature_id: i64,
    triggered_by: TriggeredBy,
) -> Result<i64, AppError> {
    let result = sqlx::query(
        r#"INSERT INTO custom_action_runs (action_id, feature_id, triggered_by)
           VALUES (?, ?, ?)"#,
    )
    .bind(action_id)
    .bind(feature_id)
    .bind(triggered_by)
    .execute(pool)
    .await?;
    Ok(result.last_insert_rowid())
}

/// Persist the captured streams for an in-flight run without finishing it
/// (`exit_code`/`ended_at` stay NULL). Lets the UI stream long-running output
/// as it arrives instead of waiting for the process to exit.
pub async fn update_run_output(
    pool: &SqlitePool,
    run_id: i64,
    stdout: &str,
    stderr: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE custom_action_runs SET stdout = ?, stderr = ? WHERE id = ?")
        .bind(stdout)
        .bind(stderr)
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Finalize a run with the captured exit code and streams. Returns the
/// `ended_at` we just stamped so the caller doesn't need a follow-up SELECT.
pub async fn finalize_run(
    pool: &SqlitePool,
    run_id: i64,
    exit_code: Option<i64>,
    stdout: &str,
    stderr: &str,
) -> Result<String, AppError> {
    let ended_at: (String,) = sqlx::query_as(
        r#"UPDATE custom_action_runs
           SET exit_code = ?, stdout = ?, stderr = ?, ended_at = datetime('now')
           WHERE id = ?
           RETURNING ended_at"#,
    )
    .bind(exit_code)
    .bind(stdout)
    .bind(stderr)
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    Ok(ended_at.0)
}

/// Finalize every run still marked in-flight (`ended_at IS NULL`). Called once
/// at startup: such a run's process died with the previous service instance, so
/// without this its UI would be stuck "running" forever and the user could
/// never re-trigger the action. Returns the number of rows reconciled.
pub async fn fail_orphaned_runs(pool: &SqlitePool) -> Result<u64, AppError> {
    let result = sqlx::query(
        r#"UPDATE custom_action_runs
           SET exit_code = -1,
               ended_at  = datetime('now'),
               stderr    = stderr || ?
           WHERE ended_at IS NULL"#,
    )
    .bind("\n[cadencr] Interrupted — the app restarted while this command was running.")
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn list_runs(
    pool: &SqlitePool,
    action_id: i64,
    feature_id: i64,
    limit: i64,
) -> Result<Vec<CustomActionRun>, AppError> {
    let rows = sqlx::query_as::<_, CustomActionRun>(
        r#"SELECT id, action_id, feature_id, exit_code, stdout, stderr,
                  started_at, ended_at, triggered_by
           FROM custom_action_runs
           WHERE action_id = ? AND feature_id = ?
           ORDER BY started_at DESC, id DESC
           LIMIT ?"#,
    )
    .bind(action_id)
    .bind(feature_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Latest run per action for a given feature, keyed by `action_id`.
pub(super) async fn latest_runs_for_feature(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<HashMap<i64, LastRunSummary>, AppError> {
    let rows: Vec<(i64, i64, Option<i64>, Option<String>, String)> = sqlx::query_as(
        r#"SELECT r.action_id, r.id, r.exit_code, r.ended_at, r.started_at
           FROM custom_action_runs r
           INNER JOIN (
               SELECT action_id, MAX(id) AS max_id
               FROM custom_action_runs
               WHERE feature_id = ?
               GROUP BY action_id
           ) latest ON latest.max_id = r.id"#,
    )
    .bind(feature_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(action_id, run_id, exit_code, ended_at, started_at)| {
            (
                action_id,
                LastRunSummary {
                    run_id,
                    exit_code,
                    ended_at,
                    started_at,
                },
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::pool_with_project_and_feature;
    use super::*;
    use crate::domain::custom_actions::models::Scope;
    use crate::domain::custom_actions::repository::insert;
    #[tokio::test]
    async fn finalize_run_returns_stamped_ended_at() {
        let (pool, project_id, feature_id) = pool_with_project_and_feature().await;
        let action_id = insert(
            &pool,
            "n",
            "echo",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        let run_id = insert_run(&pool, action_id, feature_id, TriggeredBy::Schedule)
            .await
            .unwrap();
        let ended = finalize_run(&pool, run_id, Some(2), "out", "err")
            .await
            .unwrap();
        assert!(
            !ended.is_empty(),
            "finalize_run returns the stamped timestamp"
        );

        let runs = list_runs(&pool, action_id, feature_id, 10).await.unwrap();
        assert_eq!(runs[0].exit_code, Some(2));
        assert_eq!(runs[0].stdout, "out");
        assert_eq!(runs[0].stderr, "err");
        assert_eq!(runs[0].ended_at.as_deref(), Some(ended.as_str()));
    }

    #[tokio::test]
    async fn update_run_output_streams_without_finishing_the_run() {
        let (pool, project_id, feature_id) = pool_with_project_and_feature().await;
        let action_id = insert(
            &pool,
            "n",
            "echo",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        let run_id = insert_run(&pool, action_id, feature_id, TriggeredBy::Manual)
            .await
            .unwrap();

        update_run_output(&pool, run_id, "partial out", "partial err")
            .await
            .unwrap();

        let runs = list_runs(&pool, action_id, feature_id, 10).await.unwrap();
        assert_eq!(runs[0].stdout, "partial out");
        assert_eq!(runs[0].stderr, "partial err");
        assert!(runs[0].exit_code.is_none(), "still running");
        assert!(runs[0].ended_at.is_none(), "not finalized yet");

        // A later finalize overwrites the partial output with the full result.
        finalize_run(&pool, run_id, Some(0), "final out", "")
            .await
            .unwrap();
        let runs = list_runs(&pool, action_id, feature_id, 10).await.unwrap();
        assert_eq!(runs[0].stdout, "final out");
        assert_eq!(runs[0].exit_code, Some(0));
        assert!(runs[0].ended_at.is_some());
    }

    #[tokio::test]
    async fn fail_orphaned_runs_finalizes_only_in_flight_rows() {
        let (pool, project_id, feature_id) = pool_with_project_and_feature().await;
        let action_id = insert(
            &pool,
            "n",
            "echo",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        // One in-flight run (no finalize) and one already finished.
        let orphan = insert_run(&pool, action_id, feature_id, TriggeredBy::Manual)
            .await
            .unwrap();
        let finished = insert_run(&pool, action_id, feature_id, TriggeredBy::Manual)
            .await
            .unwrap();
        finalize_run(&pool, finished, Some(0), "ok", "")
            .await
            .unwrap();

        let reconciled = fail_orphaned_runs(&pool).await.unwrap();
        assert_eq!(reconciled, 1, "only the in-flight run is reconciled");

        let runs = list_runs(&pool, action_id, feature_id, 10).await.unwrap();
        let orphan_row = runs.iter().find(|r| r.id == orphan).unwrap();
        assert_eq!(orphan_row.exit_code, Some(-1));
        assert!(orphan_row.ended_at.is_some());
        assert!(orphan_row.stderr.contains("restarted"));
        // The already-finished run is left untouched.
        let finished_row = runs.iter().find(|r| r.id == finished).unwrap();
        assert_eq!(finished_row.exit_code, Some(0));
        assert_eq!(finished_row.stderr, "");
    }
}
