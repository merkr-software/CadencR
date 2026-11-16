use sqlx::sqlite::SqlitePoolOptions;

use super::test_fixtures::seed_applied_migrations_before;
use super::{run_migrations, MigrationContext};

const TARGET_VERSION: i64 = 20261011120000;

#[tokio::test]
async fn migration_counts_existing_prompts_into_the_usage_buckets() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    // Era-accurate shape: token-only buckets, with one already holding tokens
    // for a bucket the backfill also lands in.
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON; \
         CREATE TABLE projects (id INTEGER PRIMARY KEY); \
         CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER \
         REFERENCES projects(id) ON DELETE CASCADE); \
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, \
         feature_id INTEGER NOT NULL REFERENCES features(id), runtime_provider TEXT, \
         model TEXT, thinking_effort TEXT, context_window INTEGER DEFAULT 200000); \
         CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL \
         REFERENCES agent_sessions(id), role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', \
         message_type TEXT NOT NULL DEFAULT 'text', parent_tool_use_id TEXT, \
         message_uuid TEXT, created_at TEXT NOT NULL); \
         CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY \
         REFERENCES agent_messages(id) ON DELETE CASCADE, origin_kind TEXT NOT NULL); \
         CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT); \
         CREATE TABLE provider_usage_stats (day TEXT NOT NULL, provider_id TEXT NOT NULL, \
         model_id TEXT NOT NULL DEFAULT '', thinking_effort TEXT NOT NULL DEFAULT '', \
         input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, \
         updated_at TEXT NOT NULL DEFAULT (datetime('now')), \
         PRIMARY KEY (day, provider_id, model_id, thinking_effort)); \
         INSERT INTO projects (id) VALUES (1); \
         INSERT INTO features (id, project_id) VALUES (10, 1); \
         INSERT INTO agent_sessions (id, feature_id, runtime_provider, model, thinking_effort) \
         VALUES (100, 10, 'claude_code', 'opus', 'high'), \
                (200, 10, 'codex', NULL, NULL), \
                (300, 10, NULL, NULL, NULL), \
                (400, 10, 'claude_code', 'opus', 'high'); \
         INSERT INTO agent_messages \
         (id, session_id, role, content, message_type, parent_tool_use_id, message_uuid, created_at) \
         VALUES \
         (1, 100, 'user', 'a', 'user_message', NULL, 'u1', '2026-10-01 09:00:00'), \
         (2, 100, 'assistant', 'b', 'text', NULL, NULL, '2026-10-01 09:00:05'), \
         (3, 100, 'user', 'c', 'user_message', NULL, 'u3', '2026-10-01 23:59:59'), \
         (4, 100, 'user', 'd', 'user_message', NULL, NULL, '2026-10-02T08:00:00Z'), \
         (5, 100, 'user', 'e', 'user_message', NULL, 'u5', '2026-10-02 08:05:00'), \
         (6, 100, 'user', 'f', 'user_message', NULL, 'u6', '2026-10-02 08:06:00'), \
         (7, 200, 'user', 'g', 'user_message', NULL, 'u7', '2026-10-02 10:00:00'), \
         (8, 300, 'user', 'h', 'user_message', NULL, 'u8', '2026-10-02 11:00:00'), \
         (9, 100, 'user', 'brief', 'user_message', 'toolu_1', NULL, '2026-10-02 12:00:00'), \
         (10, 400, 'user', 'a', 'user_message', NULL, 'u1', '2026-10-01 09:00:00'), \
         (11, 400, 'user', 'd', 'user_message', NULL, NULL, '2026-10-02T08:00:00Z'), \
         (12, 100, 'user', 'i', 'user_message', NULL, 'u12', '2026-10-02 13:00:00'), \
         (13, 100, 'user', '{}', 'tool_result', NULL, NULL, '2026-10-02 14:00:00'); \
         INSERT INTO agent_message_origins (message_id, origin_kind) VALUES \
         (5, 'session_generated'), (6, 'human'), (12, 'imported'); \
         INSERT INTO provider_usage_stats \
         (day, provider_id, model_id, thinking_effort, input_tokens, output_tokens) VALUES \
         ('2026-10-01', 'claude_code', 'opus', 'high', 1000, 200);",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool, TARGET_VERSION).await;
    super::test_fixtures::ensure_custom_action_schedule_prerequisites(&pool).await;
    super::test_fixtures::ensure_project_authoring_marker(&pool).await;

    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    let rows: Vec<(String, String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT day, provider_id, model_id, thinking_effort, input_tokens, output_tokens,
                user_messages
         FROM provider_usage_stats ORDER BY day, provider_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            // Tokens survive; the day's two prompts join them in one bucket,
            // the fork's copy of the first one not counted again.
            (
                "2026-10-01".into(),
                "claude_code".into(),
                "opus".into(),
                "high".into(),
                1000,
                200,
                2
            ),
            // ISO and SQLite timestamps land on the same day. The human and
            // imported prompts count; the agent-generated one, the sub-agent
            // brief, the tool result and the fork's copies do not.
            (
                "2026-10-02".into(),
                "claude_code".into(),
                "opus".into(),
                "high".into(),
                0,
                0,
                3
            ),
            // No model or effort: empty strings, never NULL. The session
            // without a provider has nothing to chart.
            (
                "2026-10-02".into(),
                "codex".into(),
                String::new(),
                String::new(),
                0,
                0,
                1
            ),
        ]
    );

    let foreign_key_violations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(foreign_key_violations, 0);
}
