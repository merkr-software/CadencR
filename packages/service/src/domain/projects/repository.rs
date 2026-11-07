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

    let feature_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM features WHERE project_id = ?")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    // The same per-feature cascade as deleting one feature, in this
    // transaction: a child row left behind would fail the project delete.
    for feature_id in &feature_ids {
        crate::domain::features::repository::delete_feature_rows(&mut tx, *feature_id).await?;
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
                agent_runtime_session TEXT,
                kind TEXT NOT NULL DEFAULT 'user',
                authoring_target TEXT CHECK (authoring_target IN ('theme', 'provider', 'tab')),
                plugin_id TEXT CHECK ((authoring_target IS NULL) = (plugin_id IS NULL))
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

        sqlx::query(
            "CREATE TABLE diff_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL)"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE TABLE session_runtime_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL)"
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

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The real schema enforces foreign keys, and `diff_comments` and
    /// `session_runtime_ids` reference features/sessions without a cascade:
    /// deleting a project whose feature has either used to fail outright.
    #[tokio::test]
    async fn delete_project_removes_every_non_cascading_feature_child() {
        let pool = migrated_pool().await;
        let project = create_project(&pool, "Cascade FK", "/tmp/cascade-fk")
            .await
            .unwrap();
        let other = create_project(&pool, "Survivor", "/tmp/survivor")
            .await
            .unwrap();
        let mut feature_ids = Vec::new();
        for project_id in [project.id, project.id, other.id] {
            let feature_id: i64 = sqlx::query_scalar(
                "INSERT INTO features (project_id, title) VALUES (?, 'f') RETURNING id",
            )
            .bind(project_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            let session_id: i64 = sqlx::query_scalar(
                "INSERT INTO agent_sessions (feature_id, agent_type) VALUES (?, 'session') RETURNING id",
            )
            .bind(feature_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            for statement in [
                "INSERT INTO session_runtime_ids (session_id, runtime_session_id) VALUES (?, 'runtime')",
                "INSERT INTO agent_messages (session_id, role, message_type, content) VALUES (?, 'user', 'text', 'hi')",
            ] {
                sqlx::query(statement)
                    .bind(session_id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            for statement in [
                "INSERT INTO diff_comments (feature_id, file_path, line_number, side, content) VALUES (?, 'a.rs', 1, 'new', 'c')",
                "INSERT INTO diff_viewed_files (feature_id, file_path, blob_sha) VALUES (?, 'a.rs', 'sha')",
                "INSERT INTO feature_settings (feature_id, key, value) VALUES (?, 'k', 'v')",
            ] {
                sqlx::query(statement)
                    .bind(feature_id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            feature_ids.push(feature_id);
        }

        let deleted = delete_project(&pool, project.id).await.unwrap();

        assert_eq!(deleted, feature_ids[..2]);
        assert_eq!(count(&pool, "projects").await, 1);
        // Only the surviving project's feature keeps its rows.
        for table in [
            "features",
            "agent_sessions",
            "agent_messages",
            "session_runtime_ids",
            "diff_comments",
            "diff_viewed_files",
            "feature_settings",
        ] {
            assert_eq!(count(&pool, table).await, 1, "{table}");
        }
    }
}
