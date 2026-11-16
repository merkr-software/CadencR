use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::domain::custom_actions::models::{CustomAction, LastRunSummary, Scope};
use crate::domain::custom_actions::service;
use crate::error::AppError;

use super::runs::latest_runs_for_feature;

// ---------------------------------------------------------------------------
// custom_actions
// ---------------------------------------------------------------------------

/// Raw DB columns. The public [`CustomAction`] also carries derived fields
/// (`variable_names`, `last_run`) that are stitched in by [`hydrate`].
#[derive(sqlx::FromRow)]
struct ActionRow {
    id: i64,
    name: String,
    command: String,
    icon_data: Option<String>,
    scope: Scope,
    project_id: Option<i64>,
    position: i64,
    run_in_terminal: bool,
    created_at: String,
    updated_at: String,
}

fn hydrate(row: ActionRow, last_run: Option<LastRunSummary>) -> CustomAction {
    CustomAction {
        variable_names: service::extract_variables(&row.command),
        id: row.id,
        name: row.name,
        command: row.command,
        icon_data: row.icon_data,
        scope: row.scope,
        project_id: row.project_id,
        position: row.position,
        run_in_terminal: row.run_in_terminal,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_run,
    }
}

/// Returns the project's own actions, then the global ones, each group in its
/// user-chosen `position` order. Without a `project_id` only the global actions
/// are listed (the Settings page). When `feature_id` is provided, each action's
/// latest run for that feature is embedded so the header can paint status
/// without N additional HTTP calls.
pub async fn list_for_project(
    pool: &SqlitePool,
    project_id: Option<i64>,
    feature_id: Option<i64>,
) -> Result<Vec<CustomAction>, AppError> {
    // `project_id = NULL` is never true, so a missing project lists globals only.
    let rows = sqlx::query_as::<_, ActionRow>(
        r#"SELECT id, name, command, icon_data, scope, project_id, position, run_in_terminal, created_at, updated_at
           FROM custom_actions
           WHERE scope = 'global' OR project_id = ?
           ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END, position ASC, id ASC"#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    let last_runs = match feature_id {
        Some(fid) => latest_runs_for_feature(pool, fid).await?,
        None => HashMap::new(),
    };

    Ok(rows
        .into_iter()
        .map(|r| {
            let last = last_runs.get(&r.id).cloned();
            hydrate(r, last)
        })
        .collect())
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Option<CustomAction>, AppError> {
    let row = sqlx::query_as::<_, ActionRow>(
        r#"SELECT id, name, command, icon_data, scope, project_id, position, run_in_terminal, created_at, updated_at
           FROM custom_actions WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| hydrate(r, None)))
}

pub async fn insert(
    pool: &SqlitePool,
    name: &str,
    command: &str,
    icon_data: Option<&str>,
    scope: Scope,
    project_id: Option<i64>,
    run_in_terminal: bool,
) -> Result<i64, AppError> {
    // New actions go last in their own list (the project's, or the globals).
    let result = sqlx::query(
        r#"INSERT INTO custom_actions (name, command, icon_data, scope, project_id, run_in_terminal, position)
           VALUES (?, ?, ?, ?, ?, ?,
                   (SELECT COALESCE(MAX(position) + 1, 0) FROM custom_actions
                    WHERE scope = ? AND project_id IS ?))"#,
    )
    .bind(name)
    .bind(command)
    .bind(icon_data)
    .bind(scope)
    .bind(project_id)
    .bind(run_in_terminal)
    .bind(scope)
    .bind(project_id)
    .execute(pool)
    .await?;
    Ok(result.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::pool_with_project_and_feature;
    use super::*;
    use crate::domain::custom_actions::models::TriggeredBy;
    use crate::domain::custom_actions::repository::{finalize_run, insert_run};
    #[tokio::test]
    async fn insert_then_get_returns_hydrated_action_with_variables() {
        let (pool, project_id, _) = pool_with_project_and_feature().await;
        let id = insert(
            &pool,
            "Greet",
            "echo hi ${NAME}",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();

        let row = get(&pool, id).await.unwrap().unwrap();
        assert_eq!(row.name, "Greet");
        assert_eq!(row.variable_names, vec!["NAME".to_string()]);
        assert!(row.last_run.is_none(), "no runs recorded yet");
        assert!(!row.run_in_terminal, "defaults to a backgrounded run");
    }

    #[tokio::test]
    async fn list_for_project_returns_global_and_project_scoped() {
        let (pool, project_id, _) = pool_with_project_and_feature().await;
        let other_project: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
                .bind("o")
                .bind("/tmp/o")
                .fetch_one(&pool)
                .await
                .unwrap();
        insert(&pool, "global", "echo g", None, Scope::Global, None, false)
            .await
            .unwrap();
        insert(
            &pool,
            "mine",
            "echo m",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        insert(
            &pool,
            "other",
            "echo o",
            None,
            Scope::Project,
            Some(other_project),
            false,
        )
        .await
        .unwrap();

        let rows = list_for_project(&pool, Some(project_id), None)
            .await
            .unwrap();
        let names: Vec<_> = rows.iter().map(|r| r.name.clone()).collect();
        assert!(names.contains(&"global".to_string()));
        assert!(names.contains(&"mine".to_string()));
        assert!(!names.contains(&"other".to_string()));
    }

    #[tokio::test]
    async fn list_puts_project_actions_before_globals_and_appends_new_ones() {
        let (pool, project_id, _) = pool_with_project_and_feature().await;
        insert(&pool, "g1", "echo", None, Scope::Global, None, false)
            .await
            .unwrap();
        insert(
            &pool,
            "p1",
            "echo",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        insert(&pool, "g2", "echo", None, Scope::Global, None, false)
            .await
            .unwrap();
        insert(
            &pool,
            "p2",
            "echo",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();

        let rows = list_for_project(&pool, Some(project_id), None)
            .await
            .unwrap();
        let order: Vec<_> = rows.iter().map(|r| (r.name.as_str(), r.position)).collect();
        assert_eq!(order, vec![("p1", 0), ("p2", 1), ("g1", 0), ("g2", 1)]);

        let globals = list_for_project(&pool, None, None).await.unwrap();
        let names: Vec<_> = globals.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["g1", "g2"]);
    }

    #[tokio::test]
    async fn list_for_project_embeds_last_run_for_feature() {
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
        finalize_run(&pool, run_id, Some(0), "ok\n", "")
            .await
            .unwrap();

        let rows = list_for_project(&pool, Some(project_id), Some(feature_id))
            .await
            .unwrap();
        let action = rows.iter().find(|a| a.id == action_id).unwrap();
        let last = action.last_run.as_ref().expect("last_run embedded");
        assert_eq!(last.exit_code, Some(0));
        assert!(last.ended_at.is_some());
    }
}
