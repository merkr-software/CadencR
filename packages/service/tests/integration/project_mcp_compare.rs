use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::project::run_project_tool;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

async fn compare_ctx() -> Arc<McpContext> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory db");
    sqlx::raw_sql(
        r#"
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
        CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL);
        CREATE TABLE feature_settings (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL, runtime_provider TEXT, model TEXT, started_at TEXT);
        CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, message_type TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, created_at TEXT NOT NULL);
        CREATE TABLE agent_session_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_session_id INTEGER NOT NULL, target_session_id INTEGER NOT NULL, link_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), note TEXT);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO projects (id, name, path) VALUES (10, 'Current', '/tmp/current'), (20, 'Other', '/tmp/other');
        INSERT INTO features (id, project_id, title) VALUES (100, 10, 'Login investigation'), (101, 10, 'Settings review'), (200, 20, 'Other');
        INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model, started_at) VALUES
            (1000, 100, 'completed', 'codex', 'openai/gpt-5.4', '2026-06-18T10:00:00Z'),
            (1001, 101, 'running', 'claude', 'opus', '2026-06-18T11:00:00Z'),
            (2000, 200, 'paused', 'codex', 'openai/gpt-5.4', '2026-06-18T12:00:00Z');
        INSERT INTO feature_settings (feature_id, key, value) VALUES
            (100, 'worktree_reuse_branch', 'feature/login'),
            (101, 'worktree_reuse_branch', 'feature/settings');
        INSERT INTO agent_messages (id, session_id, role, message_type, content, created_at) VALUES
            (1, 1000, 'user', 'user_message', 'Investigate flaky login test', '2026-06-18T10:01:00Z'),
            (2, 1000, 'assistant', 'text', 'Conclusion: login race in auth setup', '2026-06-18T10:02:00Z'),
            (3, 1001, 'user', 'user_message', 'Check settings migration impact', '2026-06-18T11:01:00Z'),
            (4, 1001, 'assistant', 'text', 'Current finding: settings JSON flow is safe', '2026-06-18T11:02:00Z'),
            (5, 1001, 'tool', 'tool_call', '{}', '2026-06-18T11:03:00Z');
        INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
            VALUES (1000, 1001, 'referenced', 'login findings informed settings review');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed compare test database");
    McpContext::new_with_source_session(pool.clone(), pool, 100, Some(1000))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn project_compare_sessions_returns_metadata_summaries_and_links() {
    let ctx = compare_ctx().await;

    let result = run_project_tool(
        "project_compare_sessions",
        json!({"left_session_id": 1000, "right_session_id": 1001}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("compare json");

    assert_eq!(body["project_id"], 10);
    assert_eq!(body["left"]["session"]["id"], 1000);
    assert_eq!(body["left"]["feature"]["title"], "Login investigation");
    assert_eq!(body["left"]["worktree"]["branch"], "feature/login");
    assert_eq!(
        body["left"]["first_user_message"],
        "Investigate flaky login test"
    );
    assert_eq!(body["right"]["message_counts"]["tool_call"], 1);
    assert_eq!(
        body["right"]["latest_assistant_text"],
        "Current finding: settings JSON flow is safe"
    );
    assert_eq!(body["links"].as_array().unwrap().len(), 1);
    assert_eq!(body["links"][0]["link_type"], "referenced");
}

#[tokio::test]
async fn project_compare_sessions_rejects_cross_project_sessions() {
    let ctx = compare_ctx().await;

    let result = run_project_tool(
        "project_compare_sessions",
        json!({"left_session_id": 1000, "right_session_id": 2000}),
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
