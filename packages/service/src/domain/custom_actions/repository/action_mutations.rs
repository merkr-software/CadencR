use sqlx::SqlitePool;

use super::super::models::Scope;
use crate::error::AppError;

/// Single-statement partial update using `COALESCE`: any field passed as `None`
/// keeps its current DB value. The icon clear path uses `Some(Some(""))` to
/// distinguish "leave alone" (`None`) from "set to NULL" (`Some(None)`).
pub async fn update(
    pool: &SqlitePool,
    id: i64,
    name: Option<&str>,
    command: Option<&str>,
    icon_data: Option<Option<&str>>,
    scope: Option<Scope>,
    project_id: Option<Option<i64>>,
    position: Option<i64>,
    run_in_terminal: Option<bool>,
) -> Result<(), AppError> {
    // `clear_icon = 1` lets us pass NULL through the COALESCE without losing
    // the "leave alone" semantics encoded by `Option<Option<&str>>`.
    let (icon_param, clear_icon) = match icon_data {
        Some(Some(s)) => (Some(s), false),
        Some(None) => (None, true),
        None => (None, false),
    };
    let (project_param, clear_project) = match project_id {
        Some(Some(id)) => (Some(id), false),
        Some(None) => (None, true),
        None => (None, false),
    };

    let result = sqlx::query(
        r#"UPDATE custom_actions SET
               name       = COALESCE(?, name),
               command    = COALESCE(?, command),
               icon_data  = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, icon_data) END,
               project_id = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, project_id) END,
               scope      = COALESCE(?, scope),
               position   = COALESCE(?, position),
               run_in_terminal = COALESCE(?, run_in_terminal),
               updated_at = datetime('now')
           WHERE id = ?"#,
    )
    .bind(name)
    .bind(command)
    .bind(clear_icon as i64)
    .bind(icon_param)
    .bind(clear_project as i64)
    .bind(project_param)
    .bind(scope)
    .bind(position)
    .bind(run_in_terminal)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Custom action {id} not found")));
    }
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM custom_actions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::pool_with_project_and_feature;
    use super::*;
    use crate::domain::custom_actions::models::TriggeredBy;
    use crate::domain::custom_actions::repository::{
        finalize_run, get, insert, insert_run, list_runs, list_variables, upsert_variable,
    };
    #[tokio::test]
    async fn run_in_terminal_round_trips_through_insert_and_update() {
        let (pool, project_id, _) = pool_with_project_and_feature().await;
        let id = insert(
            &pool,
            "n",
            "npm run dev",
            None,
            Scope::Project,
            Some(project_id),
            true,
        )
        .await
        .unwrap();
        assert!(get(&pool, id).await.unwrap().unwrap().run_in_terminal);

        // Flipping it off persists; passing None leaves it untouched.
        update(&pool, id, None, None, None, None, None, None, Some(false))
            .await
            .unwrap();
        assert!(!get(&pool, id).await.unwrap().unwrap().run_in_terminal);
        update(
            &pool,
            id,
            Some("renamed"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(!get(&pool, id).await.unwrap().unwrap().run_in_terminal);
    }

    #[tokio::test]
    async fn update_partial_keeps_unset_fields() {
        let (pool, project_id, _) = pool_with_project_and_feature().await;
        let id = insert(
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
        update(
            &pool,
            id,
            Some("renamed"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let row = get(&pool, id).await.unwrap().unwrap();
        assert_eq!(row.name, "renamed");
        assert_eq!(row.command, "echo");
    }

    #[tokio::test]
    async fn update_can_clear_icon_via_some_none() {
        let (pool, project_id, _) = pool_with_project_and_feature().await;
        let id = insert(
            &pool,
            "n",
            "echo",
            Some("data:image/png;base64,xx"),
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        update(&pool, id, None, None, Some(None), None, None, None, None)
            .await
            .unwrap();
        let row = get(&pool, id).await.unwrap().unwrap();
        assert!(row.icon_data.is_none());
    }

    #[tokio::test]
    async fn update_returns_not_found_for_missing_id() {
        let (pool, _, _) = pool_with_project_and_feature().await;
        let err = update(&pool, 9_999, Some("x"), None, None, None, None, None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_cascades_to_variables_runs_and_schedules() {
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
        upsert_variable(&pool, action_id, feature_id, "X", "v")
            .await
            .unwrap();
        let run_id = insert_run(&pool, action_id, feature_id, TriggeredBy::Manual)
            .await
            .unwrap();
        finalize_run(&pool, run_id, Some(0), "", "").await.unwrap();
        // A schedule on the Schedules page that runs this action.
        sqlx::query(
            "INSERT INTO schedules
                (prompt, target_kind, feature_id, custom_action_id, recurrence_kind, interval_seconds)
             VALUES ('', 'conversation', ?, ?, 'interval', 60)",
        )
        .bind(feature_id)
        .bind(action_id)
        .execute(&pool)
        .await
        .unwrap();

        delete(&pool, action_id).await.unwrap();

        assert!(list_variables(&pool, action_id, feature_id)
            .await
            .unwrap()
            .is_empty());
        assert!(list_runs(&pool, action_id, feature_id, 10)
            .await
            .unwrap()
            .is_empty());
        let schedules: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM schedules WHERE custom_action_id = ?")
                .bind(action_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(schedules, 0);
    }
}
