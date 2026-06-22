use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::project::run_project_tool;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

async fn worktree_ctx() -> Arc<McpContext> {
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
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL, runtime_provider TEXT, model TEXT);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO projects (id, name, path) VALUES (10, 'Current', '/tmp/current'), (20, 'Other', '/tmp/other');
        INSERT INTO features (id, project_id, title) VALUES
            (100, 10, 'Current feature'),
            (101, 10, 'Helper feature'),
            (200, 20, 'Other feature');
        INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model) VALUES
            (1000, 100, 'running', 'codex', 'openai/gpt-5.4'),
            (1001, 101, 'paused', 'claude', 'opus'),
            (2000, 200, 'paused', 'codex', 'openai/gpt-5.4');
        INSERT INTO feature_settings (feature_id, key, value) VALUES
            (100, 'worktree_mode', 'new'),
            (100, 'worktree_path', '/tmp/current/wt-main'),
            (100, 'worktree_reuse_branch', 'feature/main'),
            (101, 'worktree_mode', 'reuse'),
            (101, 'worktree_path', '/tmp/current/wt-helper'),
            (101, 'worktree_reuse_branch', 'feature/helper'),
            (200, 'worktree_path', '/tmp/other/secret');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed worktree test database");
    McpContext::new_with_source_session(pool.clone(), pool, 100, Some(1000))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn project_get_worktree_status_lists_current_project_session_worktrees() {
    let ctx = worktree_ctx().await;

    let result = run_project_tool("project_get_worktree_status", json!({}), ctx).await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let sessions = body["sessions"].as_array().expect("sessions");

    assert_eq!(body["project_id"], 10);
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["session"]["id"], 1000);
    assert_eq!(sessions[0]["worktree"]["mode"], "new");
    assert_eq!(sessions[0]["worktree"]["path"], "/tmp/current/wt-main");
    assert_eq!(sessions[1]["session"]["id"], 1001);
    assert_eq!(sessions[1]["worktree"]["branch"], "feature/helper");
}

#[tokio::test]
async fn project_get_worktree_status_rejects_cross_project_session_filter() {
    let ctx = worktree_ctx().await;

    let result = run_project_tool(
        "project_get_worktree_status",
        json!({"session_id": 2000}),
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
