use sqlx::{AssertSqlSafe, QueryBuilder, Sqlite, SqlitePool};

use super::super::models::ConversationReferenceCandidate;
use crate::error::AppError;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;
const LATEST_READABLE_SESSION_SUBQUERY: &str = r#"(
    SELECT candidate.id
    FROM agent_sessions candidate
    WHERE candidate.feature_id = f.id
      AND candidate.agent_type = 'session'
      AND EXISTS (
          SELECT 1 FROM agent_messages history
          WHERE history.session_id = candidate.id
      )
    ORDER BY candidate.id DESC
    LIMIT 1
)"#;

#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub(crate) struct ResolvedConversationReference {
    pub feature_id: i64,
    pub feature_title: String,
    pub project_id: i64,
    pub project_name: String,
    pub session_id: i64,
}

pub async fn list_conversation_references(
    pool: &SqlitePool,
    current_feature_id: i64,
    query: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<ConversationReferenceCandidate>, AppError> {
    let normalized_query = query.map(str::trim).filter(|value| !value.is_empty());
    let like_query = normalized_query.map(|value| format!("%{value}%"));
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let sql = format!(
        r#"SELECT
               f.id AS feature_id,
               f.title AS feature_title,
               p.id AS project_id,
               p.name AS project_name,
               f.status AS feature_status,
               COALESCE(
                   (
                       SELECT activity.created_at
                       FROM agent_messages activity
                       WHERE activity.session_id = s.id AND activity.role = 'user'
                       ORDER BY activity.created_at DESC
                       LIMIT 1
                   ),
                   (
                       SELECT activity.created_at
                       FROM agent_messages activity
                       WHERE activity.session_id = s.id
                       ORDER BY activity.created_at DESC
                       LIMIT 1
                   ),
                   f.created_at
               ) AS last_message_at
           FROM features f
           JOIN projects p ON p.id = f.project_id
           JOIN agent_sessions s ON s.id = {LATEST_READABLE_SESSION_SUBQUERY}
           WHERE f.id != ?
             AND (? IS NULL OR f.title LIKE ? COLLATE NOCASE OR p.name LIKE ? COLLATE NOCASE)
           ORDER BY
               (f.project_id = (SELECT project_id FROM features WHERE id = ?)) DESC,
               datetime(last_message_at) DESC,
               f.id DESC
           LIMIT ?"#
    );
    let rows = sqlx::query_as::<_, ConversationReferenceCandidate>(AssertSqlSafe(sql))
        .bind(current_feature_id)
        .bind(normalized_query)
        .bind(like_query.as_deref())
        .bind(like_query.as_deref())
        .bind(current_feature_id)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub(crate) async fn resolve_conversation_references(
    pool: &SqlitePool,
    feature_ids: &[i64],
) -> Result<Vec<ResolvedConversationReference>, AppError> {
    let mut query = QueryBuilder::<Sqlite>::new(format!(
        "SELECT f.id AS feature_id, f.title AS feature_title, \
         p.id AS project_id, p.name AS project_name, s.id AS session_id \
         FROM features f JOIN projects p ON p.id = f.project_id \
         JOIN agent_sessions s ON s.id = {LATEST_READABLE_SESSION_SUBQUERY} \
         WHERE f.id IN ("
    ));
    let mut separated = query.separated(", ");
    for feature_id in feature_ids {
        separated.push_bind(feature_id);
    }
    separated.push_unseparated(")");
    Ok(query
        .build_query_as::<ResolvedConversationReference>()
        .fetch_all(pool)
        .await?)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::{list_conversation_references, resolve_conversation_references};

    async fn setup_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT)",
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, agent_type TEXT NOT NULL)",
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, created_at TEXT)",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO projects (id, name) VALUES (1, 'Current'), (2, 'Other')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, created_at) VALUES \
             (1, 1, 'Current conversation', 'active', '2026-01-01'), \
             (2, 1, 'Authentication', 'active', '2026-01-01'), \
             (3, 2, 'Archived API', 'archived', '2026-01-01'), \
             (4, 1, 'Empty', 'active', '2026-01-01')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type) VALUES \
             (20, 2, 'session'), (30, 3, 'session'), (40, 4, 'session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (id, session_id, role, created_at) VALUES \
             (200, 20, 'user', '2026-02-01'), (300, 30, 'user', '2026-03-01')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn lists_readable_conversations_with_current_project_first() {
        let pool = setup_pool().await;
        let rows = list_conversation_references(&pool, 1, None, None)
            .await
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.feature_id).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(rows[1].project_id, 2);
        assert_eq!(
            rows[1].feature_status,
            crate::domain::features::models::FeatureStatus::Archived
        );
    }

    #[tokio::test]
    async fn searches_project_and_conversation_titles() {
        let pool = setup_pool().await;
        let project_match = list_conversation_references(&pool, 1, Some("Other"), None)
            .await
            .unwrap();
        assert_eq!(project_match.len(), 1);
        assert_eq!(project_match[0].feature_id, 3);

        let title_match = list_conversation_references(&pool, 1, Some("auth"), None)
            .await
            .unwrap();
        assert_eq!(title_match.len(), 1);
        assert_eq!(title_match[0].feature_id, 2);
    }

    #[tokio::test]
    async fn resolves_the_same_readable_session_offered_by_the_picker() {
        let pool = setup_pool().await;
        let rows = resolve_conversation_references(&pool, &[3, 2])
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|row| row.feature_id == 2 && row.session_id == 20));
        assert!(rows
            .iter()
            .any(|row| row.feature_id == 3 && row.session_id == 30));
    }
}
