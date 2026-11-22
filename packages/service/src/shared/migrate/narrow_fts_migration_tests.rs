//! Regression tests for `20260803122000_narrow_agent_messages_fts.sql`, which
//! drops and recreates the `agent_messages_fts` virtual table and all three of
//! its triggers.
//!
//! The migration is destructive on the index, so the properties under test are
//! about what survives it: every non-`tool_result` message is still findable
//! once the backfill has run, the triggers keep working in all three
//! directions, and nothing outside the index is touched.

use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

/// The fixture models a database from just before the storage-optimization
/// work, so all three of its migrations run — including the one that creates
/// `maintenance_state`, which a later migration writes to.
const SEED_BEFORE_VERSION: i64 = 20260803120000;

/// A database carrying the pre-migration FTS table, its triggers, and a mix of
/// message types — the shape every existing installation has.
async fn legacy_schema(pool: &SqlitePool) {
    sqlx::raw_sql(
        r#"PRAGMA foreign_keys = ON;
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
        CREATE TABLE features (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT
        );
        CREATE TABLE agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER NOT NULL REFERENCES features(id)
        );
        CREATE TABLE agent_messages (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
            role TEXT NOT NULL DEFAULT 'assistant',
            content TEXT NOT NULL,
            message_type TEXT NOT NULL DEFAULT 'text',
            tool_name TEXT,
            tool_use_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE VIRTUAL TABLE agent_messages_fts USING fts5(
            content, content='agent_messages', content_rowid='id', tokenize='unicode61');
        CREATE TRIGGER agent_messages_ai AFTER INSERT ON agent_messages BEGIN
            INSERT INTO agent_messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER agent_messages_ad AFTER DELETE ON agent_messages BEGIN
            INSERT INTO agent_messages_fts(agent_messages_fts, rowid, content)
            VALUES('delete', old.id, COALESCE(old.content, ''));
        END;
        CREATE TRIGGER agent_messages_au AFTER UPDATE OF content ON agent_messages BEGIN
            INSERT INTO agent_messages_fts(agent_messages_fts, rowid, content)
            VALUES('delete', old.id, COALESCE(old.content, ''));
            INSERT INTO agent_messages_fts(rowid, content) VALUES (new.id, COALESCE(new.content, ''));
        END;
        INSERT INTO projects (id, name, path) VALUES (1, 'One', '/tmp/one');
        INSERT INTO features (id, project_id, title) VALUES (10, 1, 'Parent');
        INSERT INTO agent_sessions (id, feature_id) VALUES (100, 10);
        INSERT INTO agent_messages (id, session_id, role, content, message_type) VALUES
            (1, 100, 'user',      'zebrafish in a user prompt',     'user_message'),
            (2, 100, 'assistant', 'zebrafish in an assistant turn', 'text'),
            (3, 100, 'assistant', 'zebrafish in thinking',          'thinking'),
            (4, 100, 'assistant', 'zebrafish in tool arguments',    'tool_call'),
            (5, 100, 'tool',      'zebrafish in a tool result',     'tool_result'),
            (6, 100, 'tool',      'zebrafish in a tool error',      'tool_error');"#,
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn hits(pool: &SqlitePool, term: &str) -> Vec<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT rowid FROM agent_messages_fts WHERE agent_messages_fts MATCH ? ORDER BY rowid",
    )
    .bind(term)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn migrated_pool(tmp: &tempfile::NamedTempFile) -> SqlitePool {
    let pool = test_pool(tmp.path().to_str().unwrap()).await;
    legacy_schema(&pool).await;
    super::test_fixtures::seed_applied_migrations_before(&pool, SEED_BEFORE_VERSION).await;
    super::test_fixtures::create_schedules_migration_prerequisites(&pool).await;
    super::test_fixtures::ensure_session_queue_prerequisites(&pool, SEED_BEFORE_VERSION).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();
    pool
}

#[tokio::test]
async fn every_message_type_but_tool_result_stays_searchable() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    // Message 5 is the tool_result — the one deliberate omission. Everything
    // else is searchable the moment the migration returns.
    assert_eq!(hits(&pool, "zebrafish").await, vec![1, 2, 3, 4, 6]);
}

#[tokio::test]
async fn phrase_queries_still_work() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    // Every MCP search is a phrase query (`fts_literal_query` quotes the whole
    // string), so `detail` must stay `full`. This is the assertion that fails
    // if someone "optimizes" the index with detail=none.
    assert_eq!(hits(&pool, "\"zebrafish in thinking\"").await, vec![3]);
    assert!(hits(&pool, "\"thinking in zebrafish\"").await.is_empty());
}

#[tokio::test]
async fn triggers_track_inserts_updates_and_deletes() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, content, message_type)
         VALUES (7, 100, 'user', 'axolotl arrives', 'user_message')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(hits(&pool, "axolotl").await, vec![7]);

    sqlx::query("UPDATE agent_messages SET content = 'axolotl departs' WHERE id = 7")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(hits(&pool, "departs").await, vec![7]);
    assert!(hits(&pool, "arrives").await.is_empty());

    sqlx::query("DELETE FROM agent_messages WHERE id = 7")
        .execute(&pool)
        .await
        .unwrap();
    assert!(hits(&pool, "axolotl").await.is_empty());
}

/// The insert trigger must skip `tool_result` exactly as the backfill does. If
/// it didn't, the delete trigger's matching skip would strand the entry.
#[tokio::test]
async fn new_tool_results_are_not_indexed_and_delete_cleanly() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, content, message_type)
         VALUES (8, 100, 'tool', 'quagga output', 'tool_result')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(hits(&pool, "quagga").await.is_empty());

    sqlx::query("DELETE FROM agent_messages WHERE id = 8")
        .execute(&pool)
        .await
        .unwrap();
    // The index is still coherent for everything else after that delete.
    assert_eq!(hits(&pool, "zebrafish").await, vec![1, 2, 3, 4, 6]);
}

/// Whether a row belongs in the index depends on `message_type`, so changing it
/// alone has to resync the index. Before the trigger watched that column, a row
/// promoted out of `tool_result` stayed unindexed and its later delete issued a
/// phantom `'delete'`; a row demoted into `tool_result` stayed indexed forever as
/// a ghost pointing at a deleted rowid.
#[tokio::test]
async fn reclassifying_a_message_resyncs_the_index() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    // tool_result → text: the row must become searchable.
    sqlx::query("UPDATE agent_messages SET message_type = 'text' WHERE id = 5")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(hits(&pool, "zebrafish").await, vec![1, 2, 3, 4, 5, 6]);

    // text → tool_result: the row must drop out, leaving no ghost behind.
    sqlx::query("UPDATE agent_messages SET message_type = 'tool_result' WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(hits(&pool, "zebrafish").await, vec![1, 3, 4, 5, 6]);

    sqlx::query("DELETE FROM agent_messages WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(hits(&pool, "zebrafish").await, vec![1, 3, 4, 5, 6]);
}

#[tokio::test]
async fn message_rows_and_foreign_keys_survive_the_rebuild() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    // The migration only ever touched the index — the source table is intact.
    let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(messages, 6);

    assert!(support::table_exists(&pool, "agent_messages_fts")
        .await
        .unwrap());

    let fk_violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk_violations, 0);
}

/// The index must be fully populated by the time the migration returns.
///
/// An earlier version of this migration recreated the index empty and refilled
/// it from a background pass. That is not safe: deleting a row that was never
/// indexed makes FTS5 write a negative entry into an external-content index,
/// and the next query fails with "database disk image is malformed". A rewind
/// or a feature deletion during the backfill window would trip it, so the
/// rebuild has to finish inside the migration.
#[tokio::test]
async fn deleting_a_historical_message_leaves_the_index_usable() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = migrated_pool(&tmp).await;

    // Row 2 predates the migration — the case an empty index would corrupt.
    sqlx::query("DELETE FROM agent_messages WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(hits(&pool, "zebrafish").await, vec![1, 3, 4, 6]);
}

async fn test_pool(path: &str) -> SqlitePool {
    let options = SqliteConnectOptions::from_str(&format!("sqlite:{path}"))
        .unwrap()
        .create_if_missing(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}
