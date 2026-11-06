//! The rows that go with a conversation. Conversation and project deletion
//! both run this one list, so a child table cannot be cleaned up by one and
//! forgotten by the other.
//!
//! The schema keeps these foreign keys `NO ACTION` on purpose: a child table
//! missing here makes the delete fail instead of leaving orphans.

use sqlx::types::Json;
use sqlx::{Sqlite, Transaction};

use crate::error::AppError;

/// Children before parents: SQLite checks a non-deferred foreign key at the
/// end of each statement. Each statement binds the conversation ids as a JSON
/// array.
const CASCADE: [&str; 7] = [
    "DELETE FROM session_runtime_ids WHERE session_id IN
       (SELECT id FROM agent_sessions WHERE feature_id IN (SELECT value FROM json_each(?)))",
    "DELETE FROM agent_messages WHERE session_id IN
       (SELECT id FROM agent_sessions WHERE feature_id IN (SELECT value FROM json_each(?)))",
    "DELETE FROM agent_sessions WHERE feature_id IN (SELECT value FROM json_each(?))",
    "DELETE FROM feature_settings WHERE feature_id IN (SELECT value FROM json_each(?))",
    "DELETE FROM diff_comments WHERE feature_id IN (SELECT value FROM json_each(?))",
    "DELETE FROM diff_viewed_files WHERE feature_id IN (SELECT value FROM json_each(?))",
    "DELETE FROM features WHERE id IN (SELECT value FROM json_each(?))",
];

/// Delete conversations and every row that references them, inside the
/// caller's transaction.
pub(crate) async fn delete_features_cascade(
    tx: &mut Transaction<'_, Sqlite>,
    feature_ids: &[i64],
) -> Result<(), AppError> {
    for statement in CASCADE {
        sqlx::query(statement)
            .bind(Json(feature_ids))
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::{AssertSqlSafe, SqlitePool};

    use crate::domain::features::repository::delete_feature;
    use crate::domain::projects::repository::delete_project;
    use crate::shared::test_db::{
        insert_conversation, insert_project, insert_session, migrated_pool,
    };

    /// Every `NO ACTION` foreign key whose parent a conversation or project
    /// deletion removes. A new one fails `no_action_children_are_the_known_ones`
    /// until it is deleted by the cascade (or by `delete_project` for project
    /// rows) and seeded in `seed_every_child`.
    const NO_ACTION_CHILDREN: [&str; 8] = [
        "agent_messages.session_id -> agent_sessions",
        "agent_sessions.feature_id -> features",
        "diff_comments.feature_id -> features",
        "diff_viewed_files.feature_id -> features",
        "feature_settings.feature_id -> features",
        "features.project_id -> projects",
        "project_settings.project_id -> projects",
        "session_runtime_ids.session_id -> agent_sessions",
    ];

    fn seeded_tables() -> Vec<&'static str> {
        let children = NO_ACTION_CHILDREN
            .iter()
            .map(|edge| edge.split('.').next().unwrap());
        children.chain(["projects"]).collect()
    }

    /// One conversation of one project, with a row in every `NO ACTION` child.
    async fn seed_every_child(pool: &SqlitePool) -> (i64, i64) {
        let project_id = insert_project(pool).await;
        let feature_id = insert_conversation(pool, project_id).await;
        let session_id = insert_session(pool, feature_id).await;
        for (sql, id) in [
            ("INSERT INTO agent_messages (session_id, role, content) VALUES (?, 'user', 'hi')", session_id),
            ("INSERT INTO session_runtime_ids (session_id, runtime_session_id) VALUES (?, 'cli')", session_id),
            ("INSERT INTO diff_comments (feature_id, file_path, line_number, side, content) VALUES (?, 'a.rs', 1, 'new', 'c')", feature_id),
            ("INSERT INTO diff_viewed_files (feature_id, file_path, blob_sha) VALUES (?, 'a.rs', 'sha')", feature_id),
            ("INSERT INTO feature_settings (feature_id, key, value) VALUES (?, 'k', 'v')", feature_id),
            ("INSERT INTO project_settings (project_id, key, value) VALUES (?, 'k', 'v')", project_id),
        ] {
            sqlx::query(sql).bind(id).execute(pool).await.unwrap();
        }
        assert_eq!(
            tables_with_rows(pool).await,
            seeded_tables(),
            "seed every NO ACTION child"
        );
        (project_id, feature_id)
    }

    async fn tables_with_rows(pool: &SqlitePool) -> Vec<&'static str> {
        let mut tables = Vec::new();
        for table in seeded_tables() {
            let rows: i64 =
                sqlx::query_scalar(AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
                    .fetch_one(pool)
                    .await
                    .unwrap();
            if rows > 0 {
                tables.push(table);
            }
        }
        tables
    }

    async fn assert_foreign_keys_hold(pool: &SqlitePool) {
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(pool)
            .await
            .unwrap();
        assert!(
            violations.is_empty(),
            "{} foreign key violations",
            violations.len()
        );
    }

    #[tokio::test]
    async fn no_action_children_are_the_known_ones() {
        let pool = migrated_pool().await;
        let edges: Vec<String> = sqlx::query_scalar(
            "SELECT m.name || '.' || fk.\"from\" || ' -> ' || fk.\"table\"
             FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk
             WHERE m.type = 'table' AND fk.on_delete = 'NO ACTION'
               AND fk.\"table\" IN ('projects', 'features', 'agent_sessions', 'agent_messages')
             ORDER BY 1",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(edges, NO_ACTION_CHILDREN);
    }

    #[tokio::test]
    async fn delete_project_removes_every_child_row() {
        let pool = migrated_pool().await;
        let (project_id, feature_id) = seed_every_child(&pool).await;

        let deleted = delete_project(&pool, project_id).await.unwrap();

        assert_eq!(deleted, vec![feature_id]);
        assert_eq!(tables_with_rows(&pool).await, Vec::<&str>::new());
        assert_foreign_keys_hold(&pool).await;
    }

    #[tokio::test]
    async fn delete_feature_removes_every_child_row_and_keeps_the_project() {
        let pool = migrated_pool().await;
        let (_, feature_id) = seed_every_child(&pool).await;

        delete_feature(&pool, feature_id).await.unwrap();

        assert_eq!(
            tables_with_rows(&pool).await,
            ["project_settings", "projects"]
        );
        assert_foreign_keys_hold(&pool).await;
    }
}
