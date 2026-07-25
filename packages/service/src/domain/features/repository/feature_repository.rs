use sqlx::{AssertSqlSafe, SqlitePool};

use super::super::models::{Feature, FeatureStatus};
use super::super::title::{GeneratedTitlePolicy, MANUAL_TITLE_SETTING_KEY};
use crate::error::AppError;

const FEATURE_COLUMNS: &str = r#"f.id, f.project_id, f.title, f.status,
           COALESCE(f.type, 'ws-session') as type_, f.label,
           COALESCE(ls.model, f.model_session) AS model_session,
           COALESCE(ls.runtime_provider, f.agent_runtime_session) AS runtime_provider,
           ls.thinking_effort AS thinking_effort,
           ls.permission_mode AS permission_mode,
           ls.codex_permission_mode AS access_mode,
           ls.profile AS profile,
           COALESCE(f.created_at, datetime('now')) as created_at,
           f.is_pinned,
           (SELECT source_session.feature_id FROM agent_session_links link
            JOIN agent_sessions target_session ON target_session.id = link.target_session_id
            JOIN agent_sessions source_session ON source_session.id = link.source_session_id
            WHERE target_session.feature_id = f.id AND link.link_type IN ('spawned', 'handoff')
            ORDER BY link.created_at ASC, link.id ASC LIMIT 1) AS spawned_by_feature_id,
           (SELECT link.link_type FROM agent_session_links link
            JOIN agent_sessions target_session ON target_session.id = link.target_session_id
            WHERE target_session.feature_id = f.id AND link.link_type IN ('spawned', 'handoff')
            ORDER BY link.created_at ASC, link.id ASC LIMIT 1) AS spawn_link_type"#;

/// Join the latest agent session once so model/provider/thinking come from the same row.
const LATEST_SESSION_JOIN: &str = r#"
LEFT JOIN agent_sessions ls ON ls.id = (
  SELECT id FROM agent_sessions WHERE feature_id = f.id ORDER BY id DESC LIMIT 1
)"#;

pub async fn list_by_project(
    pool: &SqlitePool,
    project_id: i64,
    include_archived: bool,
) -> Result<Vec<Feature>, AppError> {
    let status_filter = if include_archived {
        ""
    } else {
        " AND f.status = 'active'"
    };
    // Order conversations by the most recent *user* message in any of their
    // sessions, falling back to the feature creation time when none exists.
    let sql = format!(
        "SELECT {FEATURE_COLUMNS} \
         FROM features f \
         {LATEST_SESSION_JOIN} \
         LEFT JOIN ( \
             SELECT s.feature_id AS feature_id, MAX(m.created_at) AS last_user_at \
             FROM agent_sessions s \
             JOIN agent_messages m ON m.session_id = s.id AND m.role = 'user' \
             GROUP BY s.feature_id \
         ) ua ON ua.feature_id = f.id \
         WHERE f.project_id = ?{status_filter} \
         ORDER BY datetime(COALESCE(ua.last_user_at, f.created_at)) DESC, f.id DESC"
    );
    let rows = sqlx::query_as::<_, Feature>(AssertSqlSafe(sql))
        .bind(project_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn list_pinned(pool: &SqlitePool) -> Result<Vec<Feature>, AppError> {
    // Every pinned conversation across all projects, for the global sidebar
    // "Pinned" section. Mirrors `list_by_project`'s recency ordering (most
    // recent user message, falling back to creation time) so pinned rows sort
    // the same way as the per-project lists. Pinning is only offered on active
    // features, but the status filter guards against a stale pin on an archived
    // row.
    let sql = format!(
        "SELECT {FEATURE_COLUMNS} \
         FROM features f \
         {LATEST_SESSION_JOIN} \
         LEFT JOIN ( \
             SELECT s.feature_id AS feature_id, MAX(m.created_at) AS last_user_at \
             FROM agent_sessions s \
             JOIN agent_messages m ON m.session_id = s.id AND m.role = 'user' \
             GROUP BY s.feature_id \
         ) ua ON ua.feature_id = f.id \
         WHERE f.is_pinned != 0 AND f.status = 'active' \
         ORDER BY datetime(COALESCE(ua.last_user_at, f.created_at)) DESC, f.id DESC"
    );
    let rows = sqlx::query_as::<_, Feature>(AssertSqlSafe(sql))
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn get_by_id(pool: &SqlitePool, id: i64) -> Result<Option<Feature>, AppError> {
    let sql =
        format!("SELECT {FEATURE_COLUMNS} FROM features f {LATEST_SESSION_JOIN} WHERE f.id = ?");
    let row = sqlx::query_as::<_, Feature>(AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

#[allow(dead_code)]
pub async fn create_feature(
    pool: &SqlitePool,
    project_id: i64,
    title: &str,
    type_: &str,
) -> Result<i64, AppError> {
    let result = sqlx::query(
        "INSERT INTO features (project_id, title, status, type) VALUES (?, ?, 'active', ?)",
    )
    .bind(project_id)
    .bind(title)
    .bind(type_)
    .execute(pool)
    .await?;
    Ok(result.last_insert_rowid())
}

pub async fn get_max_session_num(pool: &SqlitePool, project_id: i64) -> Result<i64, AppError> {
    let row: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT MAX(CAST(REPLACE(title, 'Session ', '') AS INTEGER)) FROM features WHERE project_id = ? AND title LIKE 'Session %'",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|r| r.0).unwrap_or(0))
}

pub async fn update_title_manually(
    pool: &SqlitePool,
    id: i64,
    title: &str,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE features SET title = ? WHERE id = ?")
        .bind(title)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    super::settings_repository::upsert_feature_setting(
        &mut *tx,
        id,
        MANUAL_TITLE_SETTING_KEY,
        "true",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Persist a generated title. Initial automatic naming preserves a manual
/// rename that raced the provider; an explicit user-requested auto-name may
/// intentionally replace it.
pub async fn update_generated_title(
    pool: &SqlitePool,
    id: i64,
    title: &str,
    policy: GeneratedTitlePolicy,
) -> Result<bool, AppError> {
    let result = match policy {
        GeneratedTitlePolicy::PreserveManualTitle => {
            sqlx::query(
                "UPDATE features SET title = ? WHERE id = ?
                 AND NOT EXISTS(
                     SELECT 1 FROM feature_settings fs
                     WHERE fs.feature_id = features.id AND fs.key = ? AND fs.value = 'true'
                 )",
            )
            .bind(title)
            .bind(id)
            .bind(MANUAL_TITLE_SETTING_KEY)
            .execute(pool)
            .await?
        }
        GeneratedTitlePolicy::ReplaceManualTitle => {
            sqlx::query("UPDATE features SET title = ? WHERE id = ?")
                .bind(title)
                .bind(id)
                .execute(pool)
                .await?
        }
    };
    Ok(result.rows_affected() > 0)
}

pub async fn update_status(
    pool: &SqlitePool,
    id: i64,
    status: FeatureStatus,
) -> Result<(), AppError> {
    let result = sqlx::query("UPDATE features SET status = ? WHERE id = ?")
        .bind(status.as_str())
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("feature {id} not found")));
    }
    Ok(())
}

pub async fn set_pinned(pool: &SqlitePool, id: i64, is_pinned: bool) -> Result<(), AppError> {
    let result = sqlx::query("UPDATE features SET is_pinned = ? WHERE id = ?")
        .bind(if is_pinned { 1 } else { 0 })
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("feature {id} not found")));
    }
    Ok(())
}

pub async fn update_label(pool: &SqlitePool, id: i64, label: Option<&str>) -> Result<(), AppError> {
    let result = sqlx::query("UPDATE features SET label = ? WHERE id = ?")
        .bind(label)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("feature {id} not found")));
    }
    Ok(())
}

pub async fn is_empty(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let feature_exists: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM features WHERE id = ? LIMIT 1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    if feature_exists.is_none() {
        return Ok(true);
    }

    let message_exists: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM agent_messages WHERE session_id IN \
         (SELECT id FROM agent_sessions WHERE feature_id = ?) LIMIT 1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(message_exists.is_none())
}

pub async fn resolve_working_dir(
    pool: &SqlitePool,
    feature_id: i64,
    project_id: i64,
) -> Result<Option<String>, AppError> {
    let feature_row: Option<(String,)> =
        sqlx::query_as("SELECT COALESCE(type, 'ws-session') FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_optional(pool)
            .await?;

    if feature_row.is_some() {
        let setting: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_path'",
        )
        .bind(feature_id)
        .fetch_optional(pool)
        .await?;
        if let Some((path,)) = setting {
            return Ok(Some(path));
        }
    }

    let project_path: Option<(String,)> = sqlx::query_as("SELECT path FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await?;
    Ok(project_path.map(|r| r.0))
}

pub async fn delete_feature(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    // Delete session children, then sessions.
    sqlx::query(
        "DELETE FROM session_runtime_ids WHERE session_id IN (SELECT id FROM agent_sessions WHERE feature_id = ?)",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE feature_id = ?)",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM agent_sessions WHERE feature_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM feature_settings WHERE feature_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM diff_comments WHERE feature_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM diff_viewed_files WHERE feature_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM features WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::models::FeatureStatus;
    use super::*;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE features (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                label TEXT,
                type TEXT NOT NULL DEFAULT 'ws-session',
                model_session TEXT,
                agent_runtime_session TEXT,
                created_at TEXT,
                is_pinned INTEGER NOT NULL DEFAULT 0
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_session_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_session_id INTEGER NOT NULL,
                target_session_id INTEGER NOT NULL,
                link_type TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                note TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY,
                feature_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                runtime_provider TEXT,
                model TEXT,
                thinking_effort TEXT,
                permission_mode TEXT,
                codex_permission_mode TEXT,
                profile TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY,
                session_id INTEGER NOT NULL,
                role TEXT,
                created_at TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE feature_settings (
                feature_id INTEGER NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (feature_id, key)
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn update_title_marks_the_title_as_manually_set() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (1, 1, 'Session 1', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();

        update_title_manually(&pool, 1, "Session 42").await.unwrap();

        let row: (String, String) = sqlx::query_as(
            "SELECT f.title, fs.value
             FROM features f
             JOIN feature_settings fs ON fs.feature_id = f.id
             WHERE f.id = 1 AND fs.key = ?",
        )
        .bind(MANUAL_TITLE_SETTING_KEY)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("Session 42".to_string(), "true".to_string()));
    }

    #[tokio::test]
    async fn generated_title_respects_manual_rename_policy() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (1, 1, 'Session 1', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        update_title_manually(&pool, 1, "Manual Name")
            .await
            .unwrap();

        assert!(!update_generated_title(
            &pool,
            1,
            "Implicit Name",
            GeneratedTitlePolicy::PreserveManualTitle,
        )
        .await
        .unwrap());
        let title_after_implicit: (String,) =
            sqlx::query_as("SELECT title FROM features WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title_after_implicit.0, "Manual Name");
        assert!(update_generated_title(
            &pool,
            1,
            "Requested Name",
            GeneratedTitlePolicy::ReplaceManualTitle,
        )
        .await
        .unwrap());
        let title: (String,) = sqlx::query_as("SELECT title FROM features WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(title.0, "Requested Name");
    }

    #[tokio::test]
    async fn get_by_id_returns_feature() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type) VALUES (1, 1, 'f', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let f = get_by_id(&pool, 1).await.unwrap().unwrap();
        assert_eq!(f.title, "f");
        assert_eq!(f.type_, "ws-session");
    }

    #[tokio::test]
    async fn list_by_project_hides_archived_features() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type) VALUES \
             (1, 1, 'active', 'active', 'ws-session'), \
             (2, 1, 'hidden', 'archived', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let features = list_by_project(&pool, 1, false).await.unwrap();
        assert_eq!(features.len(), 1);
        assert_eq!(features[0].id, 1);
        assert_eq!(features[0].status, FeatureStatus::Active);
    }

    #[tokio::test]
    async fn list_by_project_derives_spawn_parent_feature() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status) VALUES
             (1, 1, 'parent', 'active'), (2, 1, 'spawned child', 'active'),
             (3, 1, 'handoff child', 'active')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, status) VALUES
             (10, 1, 'paused'), (20, 2, 'paused'), (30, 3, 'paused')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type)
             VALUES (10, 20, 'spawned'), (10, 30, 'handoff')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let features = list_by_project(&pool, 1, false).await.unwrap();
        let child = features.iter().find(|feature| feature.id == 2).unwrap();
        assert_eq!(child.spawned_by_feature_id, Some(1));
        assert_eq!(child.spawn_link_type.as_deref(), Some("spawned"));
        let handoff = features.iter().find(|feature| feature.id == 3).unwrap();
        assert_eq!(handoff.spawned_by_feature_id, Some(1));
        assert_eq!(handoff.spawn_link_type.as_deref(), Some("handoff"));
    }

    #[tokio::test]
    async fn list_by_project_can_include_archived_features() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type, created_at) VALUES \
             (1, 1, 'active', 'active', 'ws-session', '2026-01-01T00:00:00Z'), \
             (2, 1, 'archived', 'archived', 'ws-session', '2026-01-02T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let features = list_by_project(&pool, 1, true).await.unwrap();
        let statuses: Vec<FeatureStatus> = features.iter().map(|feature| feature.status).collect();
        assert_eq!(features.len(), 2);
        assert_eq!(
            statuses,
            vec![FeatureStatus::Archived, FeatureStatus::Active]
        );
    }

    #[tokio::test]
    async fn list_by_project_orders_by_latest_user_message() {
        let pool = setup_pool().await;
        // Feature 1 is created first but its only user message is older.
        // Feature 2 is created later and has the newest user message, so it
        // must sort first. An assistant message on feature 1 is newer than
        // everything but must be ignored.
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type, created_at) VALUES \
             (1, 1, 'older', 'active', 'ws-session', '2026-01-01T00:00:00Z'), \
             (2, 1, 'newer', 'active', 'ws-session', '2026-01-02T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, status) VALUES (10, 1, 'paused'), (20, 2, 'paused')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, created_at) VALUES \
             (10, 'user', '2026-02-01T00:00:00Z'), \
             (20, 'user', '2026-03-01T00:00:00Z'), \
             (10, 'assistant', '2026-04-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let features = list_by_project(&pool, 1, false).await.unwrap();
        let ids: Vec<i64> = features.iter().map(|f| f.id).collect();
        assert_eq!(ids, vec![2, 1]);
    }

    #[tokio::test]
    async fn list_pinned_returns_only_active_pinned_across_projects() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type, is_pinned, created_at) VALUES \
             (1, 1, 'pinned-a', 'active', 'ws-session', 1, '2026-01-01T00:00:00Z'), \
             (2, 2, 'pinned-b', 'active', 'ws-session', 1, '2026-01-03T00:00:00Z'), \
             (3, 1, 'unpinned', 'active', 'ws-session', 0, '2026-01-02T00:00:00Z'), \
             (4, 2, 'pinned-archived', 'archived', 'ws-session', 1, '2026-01-04T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let pinned = list_pinned(&pool).await.unwrap();
        let ids: Vec<i64> = pinned.iter().map(|f| f.id).collect();
        // Pinned active features from both projects, newest creation first; the
        // unpinned and the archived-but-pinned rows are excluded.
        assert_eq!(ids, vec![2, 1]);
    }

    #[tokio::test]
    async fn set_pinned_persists_and_surfaces_in_get_by_id() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type) VALUES (1, 1, 'f', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(!get_by_id(&pool, 1).await.unwrap().unwrap().is_pinned);

        set_pinned(&pool, 1, true).await.unwrap();
        assert!(get_by_id(&pool, 1).await.unwrap().unwrap().is_pinned);

        set_pinned(&pool, 1, false).await.unwrap();
        assert!(!get_by_id(&pool, 1).await.unwrap().unwrap().is_pinned);
    }

    #[tokio::test]
    async fn set_pinned_missing_feature_errors() {
        let pool = setup_pool().await;
        assert!(set_pinned(&pool, 99, true).await.is_err());
    }

    #[tokio::test]
    async fn get_by_id_missing_returns_none() {
        let pool = setup_pool().await;
        assert!(get_by_id(&pool, 99).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn is_empty_returns_true_when_ws_session_has_no_messages() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type) VALUES \
             (1, 1, 'empty', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (10, 1, 'paused')")
            .execute(&pool)
            .await
            .unwrap();

        assert!(is_empty(&pool, 1).await.unwrap());
    }

    #[tokio::test]
    async fn is_empty_returns_false_when_ws_session_has_messages() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type) VALUES \
             (1, 1, 'non-empty', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (10, 1, 'paused')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_messages (session_id) VALUES (10)")
            .execute(&pool)
            .await
            .unwrap();

        assert!(!is_empty(&pool, 1).await.unwrap());
    }
}
