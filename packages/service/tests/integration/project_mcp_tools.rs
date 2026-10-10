use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::project::run_project_tool;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

async fn test_ctx() -> Arc<McpContext> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory db");

    sqlx::raw_sql(
        r#"
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE feature_settings (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, agent_type TEXT, runtime_provider TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'paused', pending_permission TEXT, pending_questions TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, message_type TEXT, content TEXT, tool_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY, origin_kind TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, source_message_id INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_session_message_queue (id INTEGER PRIMARY KEY, target_session_id INTEGER NOT NULL, source_session_id INTEGER, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, error TEXT);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE VIRTUAL TABLE agent_messages_fts USING fts5(content, content='agent_messages', content_rowid='id', tokenize='unicode61');
        INSERT INTO projects (id, name, path) VALUES (10, 'Current', '/tmp/current'), (20, 'Other', '/tmp/other');
        INSERT INTO features (id, project_id, title) VALUES (100, 10, 'Current feature'), (200, 20, 'Other feature');
        INSERT INTO feature_settings (feature_id, key, value) VALUES (100, 'worktree_path', '/tmp/current/wt'), (100, 'worktree_reuse_branch', 'feature/current');
        INSERT INTO agent_sessions (id, feature_id, agent_type, runtime_provider, model, status, started_at) VALUES
            (1000, 100, 'session', 'codex', 'openai/gpt-5.4', 'running', '2026-06-18T10:00:00Z'),
            (2000, 200, 'session', 'claude', 'opus', 'paused', '2026-06-18T11:00:00Z');
        INSERT INTO agent_messages (id, session_id, role, message_type, content, tool_name, created_at) VALUES
            (1, 1000, 'user', 'user_message', 'Investigate project MCP', NULL, '2026-06-18T10:01:00Z'),
            (2, 1000, 'assistant', 'text', 'Project MCP findings', NULL, '2026-06-18T10:02:00Z'),
            (3, 2000, 'assistant', 'text', 'Other project secret', NULL, '2026-06-18T11:02:00Z'),
            (4, 1000, 'tool', 'tool_call', 'Run cargo test for workspace search', 'shell', '2026-06-18T10:03:00Z');
        INSERT INTO agent_message_origins (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, source_message_id, note, created_at)
            VALUES (1, 'session_generated', 777, 42, 7, 9001, 'delegated by project MCP', '2026-06-18T10:01:30Z');
        INSERT INTO agent_session_message_queue (id, target_session_id, source_session_id, content, status, created_at)
            VALUES (500, 1000, 777, 'Queued helper follow-up', 'pending', '2026-06-18T10:04:00Z');
        INSERT INTO agent_messages_fts(agent_messages_fts) VALUES('rebuild');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed project MCP test database");

    McpContext::new_with_source_session(pool.clone(), pool, 100, Some(1000))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"]
        .as_str()
        .expect("text content")
        .to_string()
}

#[tokio::test]
async fn project_list_sessions_returns_only_current_project_sessions_as_json() {
    let ctx = test_ctx().await;

    let result = run_project_tool("project_list_sessions", json!({}), ctx).await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["project"]["id"], 10);
    assert_eq!(body["sessions"].as_array().expect("sessions").len(), 1);
    assert_eq!(body["sessions"][0]["id"], 1000);
    assert_eq!(body["sessions"][0]["feature"]["title"], "Current feature");
    assert_eq!(
        body["sessions"][0]["feature"]["worktree_path"],
        "/tmp/current/wt"
    );
}

#[tokio::test]
async fn project_list_agent_providers_returns_spawn_guidance() {
    let ctx = test_ctx().await;

    let result = run_project_tool("project_list_agent_providers", json!({}), ctx).await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert!(body.get("project").is_none());
    assert!(body["valid_provider_ids"]
        .as_array()
        .unwrap()
        .contains(&json!("claude_code")));
    assert!(body["valid_provider_ids"]
        .as_array()
        .unwrap()
        .contains(&json!("cursor")));
    let codex = body["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["id"] == "codex_cli")
        .expect("codex provider");
    assert!(codex["models"].is_array());
    assert!(body["spawn_tip"].as_str().unwrap().contains("canonical"));
    assert!(body["spawn_tip"]
        .as_str()
        .unwrap()
        .contains("thinking_level"));
}

#[tokio::test]
async fn project_list_sessions_supports_stable_cursor_pagination() {
    let ctx = test_ctx().await;
    sqlx::raw_sql(
        r#"
        INSERT INTO features (id, project_id, title) VALUES
            (101, 10, 'Newer feature'),
            (102, 10, 'Middle feature');
        INSERT INTO agent_sessions (id, feature_id, agent_type, runtime_provider, model, status, started_at) VALUES
            (1001, 101, 'session', 'codex', 'openai/gpt-5.4', 'paused', '2026-06-18T12:00:00Z'),
            (1002, 102, 'session', 'codex', 'openai/gpt-5.4', 'completed', '2026-06-18T11:00:00Z');
        "#,
    )
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let page_one =
        run_project_tool("project_list_sessions", json!({"limit": 1}), ctx.clone()).await;
    let page_one_body: serde_json::Value =
        serde_json::from_str(&result_text(page_one)).expect("page one JSON");
    let page_two = run_project_tool(
        "project_list_sessions",
        json!({"limit": 1, "cursor": page_one_body["next_cursor"]}),
        ctx,
    )
    .await;
    let page_two_body: serde_json::Value =
        serde_json::from_str(&result_text(page_two)).expect("page two JSON");

    assert_eq!(page_one_body["sessions"][0]["id"], 1001);
    assert_eq!(page_one_body["next_cursor"]["before_session_id"], 1001);
    assert_eq!(
        page_one_body["next_cursor"]["before_started_at"],
        "2026-06-18T12:00:00Z"
    );
    assert_eq!(page_two_body["sessions"][0]["id"], 1002);
}

#[tokio::test]
async fn project_read_session_rejects_sessions_outside_current_project() {
    let ctx = test_ctx().await;

    let result = run_project_tool("project_read_session", json!({"session_id": 2000}), ctx).await;
    let value = serde_json::to_value(result).expect("serialize result");

    assert_eq!(value["isError"], true);
    assert!(value["content"][0]["text"]
        .as_str()
        .expect("error text")
        .contains("does not belong to current project"));
}

#[tokio::test]
async fn project_find_related_sessions_searches_only_current_project_history() {
    let ctx = test_ctx().await;
    sqlx::raw_sql(
        r#"
        INSERT INTO features (id, project_id, title) VALUES (101, 10, 'Related feature');
        INSERT INTO agent_sessions (id, feature_id, agent_type, runtime_provider, model, status, started_at)
            VALUES (1001, 101, 'session', 'codex', 'openai/gpt-5.4', 'completed', '2026-06-18T10:30:00Z');
        INSERT INTO agent_messages (id, session_id, role, message_type, content, tool_name, created_at) VALUES
            (6, 1001, 'assistant', 'text', 'Similar flaky login investigation in project MCP', NULL, '2026-06-18T10:31:00Z'),
            (7, 2000, 'assistant', 'text', 'Similar flaky login investigation outside scope', NULL, '2026-06-18T11:03:00Z');
        INSERT INTO agent_messages_fts(agent_messages_fts) VALUES('rebuild');
        "#,
    )
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let result = run_project_tool(
        "project_find_related_sessions",
        json!({"query": "flaky login", "limit": 10, "snippet_chars": 80}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");
    let results = body["results"].as_array().expect("results");

    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["session"]["id"], 1001);
    assert_eq!(results[0]["feature"]["title"], "Related feature");
    assert_eq!(results[0]["message"]["id"], 6);
    assert!(results[0]["snippet"]
        .as_str()
        .unwrap()
        .contains("flaky login"));
}

#[tokio::test]
async fn project_read_session_returns_paginated_messages_and_metadata() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_read_session",
        json!({"session_id": 1000, "limit": 1, "include_metadata": true}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["session"]["id"], 1000);
    assert_eq!(body["metadata_included"], true);
    assert_eq!(body["messages"].as_array().expect("messages").len(), 1);
    assert_eq!(body["messages"][0]["content"], "Investigate project MCP");
    assert_eq!(body["next_cursor"]["after_message_id"], 1);
}

#[tokio::test]
async fn project_read_session_writes_read_audit_row() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_read_session",
        json!({"session_id": 1000, "limit": 1}),
        ctx.clone(),
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");
    let audit: (String, String, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT server_name, tool_name, source_session_id, source_feature_id,
                target_session_id, target_project_id
         FROM mcp_tool_audit_log
         WHERE tool_name = 'project_read_session'",
    )
    .fetch_one(&ctx.read_pool)
    .await
    .unwrap();

    assert_eq!(body["session"]["id"], 1000);
    assert_eq!(
        audit,
        (
            "cadencr-project".to_string(),
            "project_read_session".to_string(),
            1000,
            100,
            1000,
            10
        )
    );
}

#[tokio::test]
async fn project_read_session_includes_origin_metadata_when_requested() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_read_session",
        json!({"session_id": 1000, "limit": 1, "include_metadata": true}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");
    let origin = &body["messages"][0]["origin"];

    assert_eq!(origin["origin_kind"], "session_generated");
    assert_eq!(origin["source_session_id"], 777);
    assert_eq!(origin["source_feature_id"], 42);
    assert_eq!(origin["source_project_id"], 7);
    assert_eq!(origin["source_message_id"], 9001);
    assert_eq!(origin["note"], "delegated by project MCP");
}

#[tokio::test]
async fn project_read_session_caps_total_returned_message_content() {
    let ctx = test_ctx().await;
    let large_content = "x".repeat(120_000);
    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, message_type, content, created_at)
         VALUES (5, 1000, 'assistant', 'text', ?, '2026-06-18T10:04:00Z')",
    )
    .bind(large_content)
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let result = run_project_tool(
        "project_read_session",
        json!({"session_id": 1000, "after_message_id": 4, "limit": 1}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["content_truncated"], true);
    assert_eq!(body["message_chars_returned"], 100_000);
    assert_eq!(
        body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        100_000
    );
}

#[tokio::test]
async fn project_read_session_filters_by_query_roles_types_and_before_cursor() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_read_session",
        json!({
            "session_id": 1000,
            "query": "workspace",
            "roles": ["tool", "assistant"],
            "message_types": ["tool_call"],
            "before_message_id": 5,
            "limit": 10
        }),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], 4);
    assert_eq!(messages[0]["role"], "tool");
    assert_eq!(messages[0]["message_type"], "tool_call");
}

#[tokio::test]
async fn project_read_session_omits_tool_details_by_default() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_read_session",
        json!({"session_id": 1000, "after_message_id": 3, "limit": 1}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["messages"][0]["message_type"], "tool_call");
    assert_eq!(body["messages"][0]["content"], serde_json::Value::Null);
    assert_eq!(body["messages"][0]["content_omitted"], true);
    assert_eq!(body["messages"][0]["tool_name"], "shell");
}

#[tokio::test]
async fn project_read_session_includes_tool_details_when_requested() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_read_session",
        json!({"session_id": 1000, "after_message_id": 3, "limit": 1, "include_tool_details": true}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["messages"][0]["message_type"], "tool_call");
    assert_eq!(
        body["messages"][0]["content"],
        "Run cargo test for workspace search"
    );
    assert_eq!(body["messages"][0]["content_omitted"], false);
}

#[tokio::test]
async fn project_get_session_status_returns_status_for_current_project_session() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_get_session_status",
        json!({"session_id": 1000}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["session_id"], 1000);
    assert_eq!(body["status"], "running");
    assert_eq!(body["project_id"], 10);
    assert_eq!(body["lifecycle"], "open");
    assert_eq!(body["turn_state"], "working");
    assert_eq!(body["delivery_mode"], "reactive_push");
}

#[tokio::test]
async fn project_get_session_status_includes_pending_queue_count() {
    let ctx = test_ctx().await;

    let result = run_project_tool(
        "project_get_session_status",
        json!({"session_id": 1000}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["status"], "running");
    assert_eq!(body["pending_queue_count"], 1);
    assert_eq!(body["has_pending_queue"], true);
}

#[tokio::test]
async fn project_get_session_status_reports_pending_gate_as_turn_state() {
    let ctx = test_ctx().await;
    sqlx::query(
        "UPDATE agent_sessions
         SET status = 'paused', pending_permission = '{\"request_id\":\"gate-1\"}'
         WHERE id = 1000",
    )
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let result = run_project_tool(
        "project_get_session_status",
        json!({"session_id": 1000}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("tool JSON");

    assert_eq!(body["status"], "paused");
    assert_eq!(body["lifecycle"], "open");
    assert_eq!(body["turn_state"], "awaiting_permission");
}
