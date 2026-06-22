use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::project::run_project_tool;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

async fn link_ctx() -> Arc<McpContext> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory db");
    sqlx::raw_sql(
        r#"
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
        CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL);
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL);
        CREATE TABLE agent_session_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_session_id INTEGER NOT NULL, target_session_id INTEGER NOT NULL, link_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), note TEXT);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO projects (id, name, path) VALUES (10, 'Current', '/tmp/current'), (20, 'Other', '/tmp/other');
        INSERT INTO features (id, project_id, title) VALUES (100, 10, 'Source'), (101, 10, 'Target'), (200, 20, 'Other');
        INSERT INTO agent_sessions (id, feature_id, status) VALUES (1000, 100, 'running'), (1001, 101, 'paused'), (2000, 200, 'paused');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed link test database");
    McpContext::new_with_source_session(pool.clone(), pool, 100, Some(1000))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn project_link_sessions_creates_current_project_link_from_source_session() {
    let ctx = link_ctx().await;

    let result = run_project_tool(
        "project_link_sessions",
        json!({"target_session_id": 1001, "link_type": "referenced", "note": "used as context"}),
        ctx.clone(),
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("link json");
    let link: (i64, i64, String, String) = sqlx::query_as(
        "SELECT source_session_id, target_session_id, link_type, note FROM agent_session_links",
    )
    .fetch_one(&ctx.read_pool)
    .await
    .unwrap();
    let audit: (String, String, i64, i64) = sqlx::query_as(
        "SELECT tool_name, status, source_session_id, target_session_id FROM mcp_tool_audit_log
         WHERE tool_name = 'project_link_sessions'",
    )
    .fetch_one(&ctx.read_pool)
    .await
    .unwrap();

    assert_eq!(body["link_id"], 1);
    assert_eq!(body["source_session_id"], 1000);
    assert_eq!(body["target_session_id"], 1001);
    assert_eq!(
        link,
        (
            1000,
            1001,
            "referenced".to_string(),
            "used as context".to_string()
        )
    );
    assert_eq!(
        audit,
        (
            "project_link_sessions".to_string(),
            "ok".to_string(),
            1000,
            1001
        )
    );
}

#[tokio::test]
async fn project_link_sessions_rejects_cross_project_targets() {
    let ctx = link_ctx().await;

    let result = run_project_tool(
        "project_link_sessions",
        json!({"target_session_id": 2000, "link_type": "referenced"}),
        ctx.clone(),
    )
    .await;
    let value = serde_json::to_value(result).expect("serialize result");
    let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_session_links")
        .fetch_one(&ctx.read_pool)
        .await
        .unwrap();

    assert_eq!(value["isError"], true);
    assert!(value["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("target session does not belong to current project"));
    assert_eq!(link_count, 0);
}
