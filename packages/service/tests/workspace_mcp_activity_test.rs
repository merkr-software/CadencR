use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::workspace::run_workspace_tool;
use cadencr_service::domain::settings_store::global_write_content;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

static SETTINGS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn activity_ctx() -> Arc<McpContext> {
    global_write_content(r#"{"workspace_mcp_enabled":"true"}"#)
        .await
        .expect("enable workspace MCP");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory db");
    sqlx::raw_sql(
        r#"
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL, runtime_provider TEXT, model TEXT, started_at TEXT);
        CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, message_type TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, created_at TEXT NOT NULL);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO projects (id, name, path) VALUES (1, 'Alpha', '/tmp/alpha'), (2, 'Beta', '/tmp/beta');
        INSERT INTO features (id, project_id, title) VALUES (10, 1, 'MCP Alpha'), (20, 2, 'Settings Beta');
        INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model, started_at) VALUES
            (100, 10, 'completed', 'codex', 'openai/gpt-5.4', '2026-06-18T10:00:00Z'),
            (200, 20, 'running', 'claude', 'opus', '2026-06-18T11:00:00Z');
        INSERT INTO agent_messages (id, session_id, role, message_type, content, tool_name, created_at) VALUES
            (1000, 100, 'assistant', 'text', 'Older alpha orchestration work', NULL, '2026-06-18T10:01:00Z'),
            (2000, 200, 'user', 'user_message', 'Please review workspace MCP settings', NULL, '2026-06-18T11:01:00Z'),
            (2001, 200, 'assistant', 'text', 'Recent beta settings activity summary', NULL, '2026-06-18T11:02:00Z');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed activity test database");
    McpContext::new_with_source_session(pool.clone(), pool, 10, Some(100))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn workspace_recent_activity_returns_recent_messages_with_project_metadata() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let ctx = activity_ctx().await;

    let result = run_workspace_tool(
        "workspace_recent_activity",
        json!({"limit": 2, "snippet_chars": 36}),
        ctx.clone(),
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let activity = body["activity"].as_array().expect("activity");
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mcp_tool_audit_log WHERE tool_name = 'workspace_recent_activity' AND status = 'ok'",
    )
    .fetch_one(&ctx.read_pool)
    .await
    .unwrap();

    assert_eq!(activity.len(), 2);
    assert_eq!(activity[0]["message"]["id"], 2001);
    assert_eq!(activity[0]["project"]["name"], "Beta");
    assert_eq!(activity[1]["message"]["id"], 2000);
    assert!(activity[0]["snippet"].as_str().unwrap().len() <= 36);
    assert_eq!(audit_count, 1);
}
