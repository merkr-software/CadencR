use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::project::run_project_tool;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

async fn tail_ctx() -> Arc<McpContext> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory db");
    sqlx::raw_sql(
        r#"
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
        CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL);
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL, runtime_provider TEXT, model TEXT);
        CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, message_type TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, created_at TEXT NOT NULL);
        CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY, origin_kind TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, source_message_id INTEGER, note TEXT, created_at TEXT NOT NULL);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO projects (id, name, path) VALUES (10, 'Current', '/tmp/current'), (20, 'Other', '/tmp/other');
        INSERT INTO features (id, project_id, title) VALUES (100, 10, 'Current feature'), (200, 20, 'Other feature');
        INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model) VALUES
            (1000, 100, 'running', 'codex', 'openai/gpt-5.4'),
            (2000, 200, 'running', 'codex', 'openai/gpt-5.4');
        INSERT INTO agent_messages (id, session_id, role, message_type, content, tool_name, created_at) VALUES
            (1, 1000, 'assistant', 'text', 'already seen', NULL, '2026-06-18T10:00:00Z'),
            (2, 1000, 'assistant', 'text', 'new progress', NULL, '2026-06-18T10:01:00Z'),
            (3, 1000, 'tool', 'tool_call', 'secret command details', 'Bash', '2026-06-18T10:02:00Z'),
            (4, 2000, 'assistant', 'text', 'other project progress', NULL, '2026-06-18T10:03:00Z');
        INSERT INTO agent_message_origins (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, source_message_id, note, created_at)
            VALUES (2, 'session_generated', 777, 42, 7, 9001, 'delegated tail read', '2026-06-18T10:01:30Z');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed tail test database");
    McpContext::new_with_source_session(pool.clone(), pool, 100, Some(1000))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn project_read_session_tail_returns_new_messages_after_cursor() {
    let ctx = tail_ctx().await;

    let result = run_project_tool(
        "project_read_session_tail",
        json!({"session_id": 1000, "after_message_id": 1, "limit": 5, "include_metadata": true}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tail json");

    assert_eq!(body["session_id"], 1000);
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(body["messages"][0]["content"], "new progress");
    assert_eq!(body["messages"][0]["origin"]["source_session_id"], 777);
    assert_eq!(body["messages"][1]["content"], serde_json::Value::Null);
    assert_eq!(body["messages"][1]["content_omitted"], true);
    assert_eq!(body["next_cursor"]["after_message_id"], 3);
}

#[tokio::test]
async fn project_read_session_tail_rejects_cross_project_sessions() {
    let ctx = tail_ctx().await;

    let result = run_project_tool(
        "project_read_session_tail",
        json!({"session_id": 2000, "after_message_id": 0}),
        ctx,
    )
    .await;
    let value = serde_json::to_value(result).expect("serialize result");

    assert_eq!(value["isError"], true);
    assert!(value["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("does not belong to current project"));
}
