use super::models::{Project, ProjectAuthoringTarget, ProjectSetting};
use crate::error::AppError;
use sqlx::SqlitePool;

pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<Project>, AppError> {
    let rows = sqlx::query_as::<_, ProjectRow>(
        // Order projects by the most recent *user* message across all their
        // features, falling back to the feature creation time when a project
        // has no user messages yet.
        r#"WITH latest_project_activity AS (
               SELECT
                   f.project_id,
                   MAX(datetime(COALESCE(um.created_at, f.created_at))) AS activity_at
               FROM features f
               LEFT JOIN agent_sessions s ON s.feature_id = f.id
               LEFT JOIN agent_messages um ON um.session_id = s.id AND um.role = 'user'
               GROUP BY f.project_id
           )
           SELECT p.id, p.name, p.path, p.branch_prefix, p.created_at,
                  p.authoring_target, p.plugin_id
           FROM projects p
           LEFT JOIN latest_project_activity activity ON activity.project_id = p.id
           ORDER BY COALESCE(activity.activity_at, datetime(p.created_at)) DESC, p.id DESC"#,
    )
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(project_from_row)
        .collect::<Result<Vec<_>, _>>()
}

pub async fn create_project(
    pool: &SqlitePool,
    name: &str,
    path: &str,
) -> Result<Project, AppError> {
    let id = sqlx::query("INSERT INTO projects (name, path) VALUES (?, ?)")
        .bind(name)
        .bind(path)
        .execute(pool)
        .await?
        .last_insert_rowid();

    project_by_id(pool, id).await
}

#[bon::builder]
pub async fn create_author_project(
    pool: &SqlitePool,
    name: &str,
    path: &str,
    authoring_target: ProjectAuthoringTarget,
    plugin_id: &str,
) -> Result<Project, AppError> {
    let id = sqlx::query(
        "INSERT INTO projects (name, path, kind, authoring_target, plugin_id) \
         VALUES (?, ?, 'user', ?, ?)",
    )
    .bind(name)
    .bind(path)
    .bind(authoring_target.as_str())
    .bind(plugin_id)
    .execute(pool)
    .await?
    .last_insert_rowid();
    project_by_id(pool, id).await
}

type ProjectRow = (
    i64,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

async fn project_by_id(pool: &SqlitePool, id: i64) -> Result<Project, AppError> {
    let row = sqlx::query_as::<_, ProjectRow>(
        "SELECT id, name, path, branch_prefix, created_at, authoring_target, plugin_id \
         FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;

    project_from_row(row)
}

fn project_from_row(row: ProjectRow) -> Result<Project, AppError> {
    let authoring_target = row
        .5
        .as_deref()
        .map(ProjectAuthoringTarget::try_from)
        .transpose()
        .map_err(AppError::Internal)?;
    Ok(Project {
        id: row.0,
        name: row.1,
        path: row.2,
        branch_prefix: row.3,
        created_at: row.4,
        authoring_target,
        plugin_id: row.6,
    })
}

/// Delete a project and all its conversations; returns the deleted
/// conversations' ids.
pub async fn delete_project(pool: &SqlitePool, id: i64) -> Result<Vec<i64>, AppError> {
    // Resolve the project's settings file path while the project row still
    // exists (path derivation reads its name). We only remove the file after the
    // DB delete commits, and only when no other project shares this name —
    // same name = same configuration, so a surviving sibling still relies on it.
    let shared = crate::domain::settings_store::name_is_shared(pool, id)
        .await
        .unwrap_or(false);
    let settings_file = if shared {
        None
    } else {
        crate::domain::settings_store::project_path(pool, id)
            .await
            .ok()
    };

    let mut tx = pool.begin().await?;

    let feature_ids: Vec<i64> =
        sqlx::query_as::<_, (i64,)>("SELECT id FROM features WHERE project_id = ?")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|r| r.0)
            .collect();

    crate::domain::features::repository::delete_features_cascade(&mut tx, &feature_ids).await?;

    sqlx::query("DELETE FROM project_settings WHERE project_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // Best-effort: drop the project's JSON settings file (ignore if absent).
    if let Some(path) = settings_file {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = %path.display(), "failed to remove project settings file: {e}");
            }
        }
    }

    Ok(feature_ids)
}

// Project settings now live in `~/.cadencr/settings/<name>.settings.json`
// instead of the `project_settings` table + real columns on `projects`. These
// functions delegate to `settings_store` (the legacy table/columns are left
// intact as a backup, but no longer read or written).

pub async fn get_project_settings(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<Vec<ProjectSetting>, AppError> {
    crate::domain::settings_store::project_list(pool, project_id).await
}

pub async fn set_project_setting(
    pool: &SqlitePool,
    project_id: i64,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    crate::domain::settings_store::project_set(pool, project_id, key, value).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::test_db::{insert_conversation, insert_session, migrated_pool};

    #[tokio::test]
    async fn test_create_and_list_projects() {
        let pool = migrated_pool().await;
        let p1 = create_project(&pool, "Alpha", "/tmp/alpha").await.unwrap();
        let p2 = create_project(&pool, "Beta", "/tmp/beta").await.unwrap();

        let projects = list_projects(&pool).await.unwrap();
        assert_eq!(projects.len(), 2);
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"Alpha"));
        assert!(names.contains(&"Beta"));
        assert_eq!(p1.name, "Alpha");
        assert_eq!(p2.path, "/tmp/beta");
    }

    #[tokio::test]
    async fn list_projects_orders_by_latest_user_message() {
        let pool = migrated_pool().await;
        let alpha = create_project(&pool, "Alpha", "/tmp/alpha").await.unwrap();
        let beta = create_project(&pool, "Beta", "/tmp/beta").await.unwrap();

        let alpha_session = insert_session(&pool, insert_conversation(&pool, alpha.id).await).await;
        let beta_session = insert_session(&pool, insert_conversation(&pool, beta.id).await).await;

        // Alpha gets the newest *user* message; Beta only gets a newer
        // *assistant* message, which must NOT affect ordering.
        sqlx::query("INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, 'user', '', '2026-01-02T00:00:00Z')")
            .bind(alpha_session)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, 'user', '', '2026-01-01T00:00:00Z')")
            .bind(beta_session)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, 'assistant', '', '2026-01-03T00:00:00Z')")
            .bind(beta_session)
            .execute(&pool)
            .await
            .unwrap();

        let projects = list_projects(&pool).await.unwrap();
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Beta"]);
    }
}
