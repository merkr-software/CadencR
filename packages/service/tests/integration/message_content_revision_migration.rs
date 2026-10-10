use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::Row;
use std::str::FromStr;

#[tokio::test]
async fn content_revision_migration_preserves_rows_and_tracks_real_edits() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
         CREATE TABLE agent_messages (
           id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
           content TEXT NOT NULL, message_type TEXT NOT NULL
         );
         INSERT INTO agent_sessions VALUES (1, 'completed');
         INSERT INTO agent_messages VALUES
           (10, 1, '{\"path\":\"before\"}', 'tool_call'),
           (11, 1, 'before', 'assistant_message');",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(include_str!(
        "../../migrations/20260906120000_agent_message_content_revisions.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("UPDATE agent_messages SET content = content WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();
    let unchanged = sqlx::query("SELECT message_revision FROM agent_sessions WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<i64, _>(0);
    assert_eq!(unchanged, 0, "no-op writes must not consume revisions");

    sqlx::query("UPDATE agent_messages SET content = 'after' WHERE id = 11")
        .execute(&pool)
        .await
        .unwrap();
    let non_tool_revision: i64 =
        sqlx::query_scalar("SELECT message_revision FROM agent_sessions WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(non_tool_revision, 0, "non-tool edits are not replayed");

    sqlx::query("UPDATE agent_messages SET content = '{\"path\":\"after\"}' WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();
    let row = sqlx::query(
        "SELECT s.message_revision, m.content_revision, m.content
         FROM agent_sessions s JOIN agent_messages m ON m.session_id = s.id WHERE m.id = 10",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>(0), 1);
    assert_eq!(row.get::<i64, _>(1), 1);
    assert_eq!(row.get::<String, _>(2), r#"{"path":"after"}"#);

    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(violations.is_empty());
}
