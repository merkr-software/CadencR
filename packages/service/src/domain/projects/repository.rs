use super::models::{Project, ProjectModelSettings, ProjectProviderSettings, ProjectSetting};
use crate::domain::agents::runtime::{runtime_setting_key, validate_agent_type};
use crate::error::AppError;
use sqlx::{AssertSqlSafe, SqlitePool};

pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<Project>, AppError> {
    let rows = sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(
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
           SELECT p.id, p.name, p.path, p.branch_prefix, p.created_at
           FROM projects p
           LEFT JOIN latest_project_activity activity ON activity.project_id = p.id
           ORDER BY COALESCE(activity.activity_at, datetime(p.created_at)) DESC, p.id DESC"#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, name, path, branch_prefix, created_at)| Project {
            id,
            name,
            path,
            branch_prefix,
            created_at,
        })
        .collect())
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

    let row = sqlx::query_as::<_, (i64, String, String, Option<String>, String)>(
        "SELECT id, name, path, branch_prefix, created_at FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;

    Ok(Project {
        id: row.0,
        name: row.1,
        path: row.2,
        branch_prefix: row.3,
        created_at: row.4,
    })
}

pub async fn delete_project(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
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

    if !feature_ids.is_empty() {
        let ph = feature_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");

        let session_ids: Vec<i64> = {
            let query = format!("SELECT id FROM agent_sessions WHERE feature_id IN ({})", ph);
            let mut q = sqlx::query_as::<_, (i64,)>(AssertSqlSafe(query));
            for fid in &feature_ids {
                q = q.bind(fid);
            }
            q.fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|r| r.0)
                .collect()
        };

        if !session_ids.is_empty() {
            let sp = session_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            let query = format!("DELETE FROM agent_messages WHERE session_id IN ({})", sp);
            let mut q = sqlx::query(AssertSqlSafe(query));
            for sid in &session_ids {
                q = q.bind(sid);
            }
            q.execute(&mut *tx).await?;
        }

        {
            let query = format!("DELETE FROM agent_sessions WHERE feature_id IN ({})", ph);
            let mut q = sqlx::query(AssertSqlSafe(query));
            for fid in &feature_ids {
                q = q.bind(fid);
            }
            q.execute(&mut *tx).await?;
        }
        {
            let query = format!("DELETE FROM feature_settings WHERE feature_id IN ({})", ph);
            let mut q = sqlx::query(AssertSqlSafe(query));
            for fid in &feature_ids {
                q = q.bind(fid);
            }
            q.execute(&mut *tx).await?;
        }
        {
            let query = format!("DELETE FROM diff_viewed_files WHERE feature_id IN ({})", ph);
            let mut q = sqlx::query(AssertSqlSafe(query));
            for fid in &feature_ids {
                q = q.bind(fid);
            }
            q.execute(&mut *tx).await?;
        }
        sqlx::query("DELETE FROM features WHERE project_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

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

    Ok(())
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

pub async fn get_project_model_settings(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<ProjectModelSettings, AppError> {
    let session = crate::domain::settings_store::project_get(pool, project_id, "model_session")
        .await?
        .unwrap_or_default();
    Ok(ProjectModelSettings { session })
}

pub async fn set_project_model_setting(
    pool: &SqlitePool,
    project_id: i64,
    model_type: &str,
    model: &str,
) -> Result<(), AppError> {
    if !validate_agent_type(model_type) {
        return Err(AppError::BadRequest(format!(
            "Invalid model type: {}",
            model_type
        )));
    }
    crate::domain::agents::runtime::reject_workspace_only(model_type, "project")?;
    let key = format!("model_{}", model_type);
    crate::domain::settings_store::project_set(pool, project_id, &key, model).await
}

pub async fn get_project_provider_settings(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<ProjectProviderSettings, AppError> {
    let session =
        crate::domain::settings_store::project_get(pool, project_id, "agent_runtime_session")
            .await?
            .unwrap_or_default();
    Ok(ProjectProviderSettings {
        session,
        auto_name: String::new(),
    })
}

pub async fn set_project_provider_setting(
    pool: &SqlitePool,
    project_id: i64,
    provider_type: &str,
    provider: &str,
) -> Result<(), AppError> {
    if !validate_agent_type(provider_type) {
        return Err(AppError::BadRequest(format!(
            "Invalid provider type: {}",
            provider_type
        )));
    }
    crate::domain::agents::runtime::reject_workspace_only(provider_type, "project")?;
    let key = runtime_setting_key(provider_type);
    crate::domain::settings_store::project_set(pool, project_id, &key, provider).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query(
            r#"CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                branch_prefix TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                model_session TEXT,
                agent_runtime_session TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT, type TEXT NOT NULL DEFAULT 'ws-session', created_at TEXT DEFAULT (datetime('now')))"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL, started_at TEXT)"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT, created_at TEXT DEFAULT (datetime('now')))"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE TABLE project_settings (project_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(project_id, key))"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE TABLE diff_viewed_files (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL)"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(feature_id, key))"
        ).execute(&pool).await.unwrap();

        pool
    }

    #[tokio::test]
    async fn test_create_and_list_projects() {
        let pool = setup_test_db().await;
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
        let pool = setup_test_db().await;
        let alpha = create_project(&pool, "Alpha", "/tmp/alpha").await.unwrap();
        let beta = create_project(&pool, "Beta", "/tmp/beta").await.unwrap();

        // Helper: insert a feature + session, returning the session id.
        async fn session_for(pool: &SqlitePool, project_id: i64) -> i64 {
            let fid = sqlx::query_as::<_, (i64,)>(
                "INSERT INTO features (project_id, title) VALUES (?, 'f') RETURNING id",
            )
            .bind(project_id)
            .fetch_one(pool)
            .await
            .unwrap()
            .0;
            sqlx::query_as::<_, (i64,)>(
                "INSERT INTO agent_sessions (feature_id) VALUES (?) RETURNING id",
            )
            .bind(fid)
            .fetch_one(pool)
            .await
            .unwrap()
            .0
        }

        let alpha_session = session_for(&pool, alpha.id).await;
        let beta_session = session_for(&pool, beta.id).await;

        // Alpha gets the newest *user* message; Beta only gets a newer
        // *assistant* message, which must NOT affect ordering.
        sqlx::query("INSERT INTO agent_messages (session_id, role, created_at) VALUES (?, 'user', '2026-01-02T00:00:00Z')")
            .bind(alpha_session)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_messages (session_id, role, created_at) VALUES (?, 'user', '2026-01-01T00:00:00Z')")
            .bind(beta_session)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_messages (session_id, role, created_at) VALUES (?, 'assistant', '2026-01-03T00:00:00Z')")
            .bind(beta_session)
            .execute(&pool)
            .await
            .unwrap();

        let projects = list_projects(&pool).await.unwrap();
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "Beta"]);
    }

    #[tokio::test]
    async fn test_delete_project_cascade() {
        let pool = setup_test_db().await;
        let project = create_project(&pool, "Cascade", "/tmp/cascade")
            .await
            .unwrap();
        let pid = project.id;

        let fid: i64 = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO features (project_id, title) VALUES (?, 'feat') RETURNING id",
        )
        .bind(pid)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let session_id: i64 = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO agent_sessions (feature_id) VALUES (?) RETURNING id",
        )
        .bind(fid)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        sqlx::query("INSERT INTO agent_messages (session_id) VALUES (?)")
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();

        delete_project(&pool, pid).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM projects WHERE id = ?")
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM agent_messages WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn test_set_project_setting_rejects_workspace_only_agent() {
        let pool = setup_test_db().await;
        let project = create_project(&pool, "WsOnly", "/tmp/wsonly")
            .await
            .unwrap();
        let err = set_project_model_setting(&pool, project.id, "auto_name", "haiku")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }
}
