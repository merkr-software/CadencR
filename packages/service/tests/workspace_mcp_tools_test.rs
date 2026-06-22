use std::sync::Arc;

use cadencr_service::domain::mcp::context::McpContext;
use cadencr_service::domain::mcp::tools::workspace::run_workspace_tool;
use cadencr_service::domain::settings_store::global_write_content;
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;

static SETTINGS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn workspace_tools_reject_reads_when_workspace_mcp_is_disabled() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    global_write_content(r#"{"workspace_mcp_enabled":"false"}"#)
        .await
        .unwrap();

    let result =
        run_workspace_tool("workspace_list_projects", json!({}), minimal_ctx().await).await;

    assert!(result.is_error.unwrap_or_default());
    assert!(result_text(result).contains("workspace_mcp_enabled"));
}

#[tokio::test]
async fn workspace_list_projects_returns_project_metadata() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_list_projects",
        json!({}),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");

    assert_eq!(body["projects"].as_array().expect("projects").len(), 2);
    assert_eq!(body["projects"][0]["name"], "Alpha");
    assert_eq!(body["projects"][1]["path"], "/tmp/beta");
}

#[tokio::test]
async fn workspace_read_sessions_searches_fts_and_applies_filters() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_read_sessions",
        json!({"query": "orchestration", "project_ids": [1], "roles": ["assistant"], "limit": 10, "snippet_chars": 24}),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");

    assert_eq!(body["results"].as_array().expect("results").len(), 1);
    assert_eq!(body["results"][0]["session"]["id"], 100);
    assert_eq!(body["results"][0]["project"]["id"], 1);
    assert!(body["results"][0]["snippet"].as_str().unwrap().len() <= 24);
}

#[tokio::test]
async fn workspace_read_sessions_writes_read_audit_row() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let ctx = enabled_workspace_ctx().await;

    let result = run_workspace_tool(
        "workspace_read_sessions",
        json!({"query": "orchestration", "project_ids": [1], "limit": 1}),
        ctx.clone(),
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let audit: (String, String, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT server_name, tool_name, source_session_id, source_feature_id,
                source_project_id, result_size_bytes
         FROM mcp_tool_audit_log
         WHERE tool_name = 'workspace_read_sessions'",
    )
    .fetch_one(&ctx.read_pool)
    .await
    .unwrap();

    assert_eq!(body["results"].as_array().expect("results").len(), 1);
    assert_eq!(audit.0, "cadencr-workspace");
    assert_eq!(audit.1, "workspace_read_sessions");
    assert_eq!((audit.2, audit.3, audit.4), (100, 10, 1));
    assert!(audit.5 > 0);
}

#[tokio::test]
async fn workspace_session_graph_returns_linked_sessions_with_project_metadata() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_session_graph",
        json!({"session_id": 100, "limit": 10}),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");

    assert_eq!(body["links"].as_array().expect("links").len(), 2);
    assert_eq!(body["links"][0]["link_type"], "spawned");
    assert_eq!(body["nodes"]["100"]["project"]["name"], "Alpha");
    assert_eq!(body["nodes"]["200"]["project"]["name"], "Beta");
    assert_eq!(body["nodes"]["300"]["feature"]["title"], "MCP Delta");
}

#[tokio::test]
async fn workspace_read_sessions_filters_by_model_tool_dates_and_cursor() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_read_sessions",
        json!({
            "query": "orchestration",
            "project_ids": [1],
            "roles": ["tool"],
            "message_types": ["tool_result"],
            "providers": ["codex"],
            "models": ["openai/gpt-5.4"],
            "statuses": ["completed"],
            "tool_names": ["shell"],
            "created_after": "2026-06-18T10:02:00Z",
            "created_before": "2026-06-18T10:04:00Z",
            "cursor": { "before_message_id": 1500 },
            "limit": 10
        }),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let results = body["results"].as_array().expect("results");

    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["message"]["id"], 1002);
    assert_eq!(results[0]["session"]["model"], "openai/gpt-5.4");
}

#[tokio::test]
async fn workspace_read_sessions_without_query_defaults_to_recent_window() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let ctx = enabled_workspace_ctx().await;
    let old_created_at = (chrono::Utc::now() - chrono::Duration::days(40)).to_rfc3339();
    let recent_created_at = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, message_type, content, created_at)
         VALUES (4000, 100, 'assistant', 'text', 'old unqueried workspace history', ?),
                (4001, 100, 'assistant', 'text', 'recent unqueried workspace history', ?)",
    )
    .bind(old_created_at)
    .bind(recent_created_at)
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let result = run_workspace_tool(
        "workspace_read_sessions",
        json!({"project_ids": [1], "limit": 50}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let ids: Vec<i64> = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| result["message"]["id"].as_i64().unwrap())
        .collect();

    assert!(ids.contains(&4001));
    assert!(!ids.contains(&4000));
    assert_eq!(body["applied_recent_window_days"], 30);
}

#[tokio::test]
async fn workspace_read_session_returns_project_metadata_and_messages() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_read_session",
        json!({"session_id": 200, "limit": 5}),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");

    assert_eq!(body["project"]["name"], "Beta");
    assert_eq!(body["session"]["status"], "running");
    assert_eq!(
        body["messages"][0]["content"],
        "Settings migration discussion"
    );
}

#[tokio::test]
async fn workspace_read_session_filters_messages_with_pagination_and_query() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_read_session",
        json!({
            "session_id": 100,
            "query": "workspace",
            "roles": ["user"],
            "message_types": ["user_message"],
            "after_message_id": 1000,
            "before_message_id": 1002,
            "limit": 10
        }),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let messages = body["messages"].as_array().expect("messages");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], 1001);
    assert_eq!(
        messages[0]["content"],
        "Please implement workspace MCP search"
    );
    assert_eq!(body["next_cursor"]["after_message_id"], 1001);
}

#[tokio::test]
async fn workspace_read_session_includes_origin_metadata_when_requested() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let result = run_workspace_tool(
        "workspace_read_session",
        json!({"session_id": 200, "limit": 1, "include_metadata": true}),
        enabled_workspace_ctx().await,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let origin = &body["messages"][0]["origin"];

    assert_eq!(origin["origin_kind"], "session_generated");
    assert_eq!(origin["source_session_id"], 777);
    assert_eq!(origin["source_feature_id"], 42);
    assert_eq!(origin["source_project_id"], 7);
    assert_eq!(origin["source_message_id"], 9001);
    assert_eq!(origin["note"], "workspace provenance read");
}

#[tokio::test]
async fn workspace_read_session_caps_total_returned_message_content() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let ctx = enabled_workspace_ctx().await;
    let large_content = "x".repeat(120_000);
    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, message_type, content, created_at)
         VALUES (2001, 200, 'assistant', 'text', ?, '2026-06-18T11:02:00Z')",
    )
    .bind(large_content)
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let result = run_workspace_tool(
        "workspace_read_session",
        json!({"session_id": 200, "limit": 5}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");
    let total_chars: usize = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["content"].as_str().unwrap().chars().count())
        .sum();

    assert_eq!(body["content_truncated"], true);
    assert_eq!(body["message_chars_returned"], 100_000);
    assert_eq!(total_chars, 100_000);
}

#[tokio::test]
async fn workspace_read_session_uses_configured_result_char_cap() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let ctx = enabled_workspace_ctx().await;
    global_write_content(
        r#"{"workspace_mcp_enabled":"true","workspace_mcp_max_result_chars":"10000"}"#,
    )
    .await
    .unwrap();
    let large_content = "x".repeat(12_000);
    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, message_type, content, created_at)
         VALUES (2001, 200, 'assistant', 'text', ?, '2026-06-18T11:02:00Z')",
    )
    .bind(large_content)
    .execute(&ctx.write_pool)
    .await
    .unwrap();

    let result = run_workspace_tool(
        "workspace_read_session",
        json!({"session_id": 200, "limit": 5}),
        ctx,
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&result_text(result)).expect("json");

    assert_eq!(body["content_truncated"], true);
    assert_eq!(body["message_chars_returned"], 10_000);
}

async fn minimal_ctx() -> Arc<McpContext> {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE projects (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             path TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .execute(&pool)
    .await
    .unwrap();
    McpContext::new(pool.clone(), pool, 10)
}

async fn enabled_workspace_ctx() -> Arc<McpContext> {
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
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, agent_type TEXT, runtime_provider TEXT, model TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, message_type TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY, origin_kind TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, source_message_id INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE agent_session_links (id INTEGER PRIMARY KEY AUTOINCREMENT, source_session_id INTEGER NOT NULL, target_session_id INTEGER NOT NULL, link_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), note TEXT);
        CREATE TABLE mcp_tool_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, server_name TEXT NOT NULL, tool_name TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, target_session_id INTEGER, target_feature_id INTEGER, target_project_id INTEGER, status TEXT NOT NULL, result_size_bytes INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE VIRTUAL TABLE agent_messages_fts USING fts5(content, content='agent_messages', content_rowid='id', tokenize='unicode61');
        INSERT INTO projects (id, name, path) VALUES (1, 'Alpha', '/tmp/alpha'), (2, 'Beta', '/tmp/beta');
        INSERT INTO features (id, project_id, title) VALUES (10, 1, 'MCP Alpha'), (20, 2, 'Settings Beta'), (30, 1, 'MCP Delta');
        INSERT INTO agent_sessions (id, feature_id, agent_type, runtime_provider, model, status, started_at) VALUES
            (100, 10, 'session', 'codex', 'openai/gpt-5.4', 'completed', '2026-06-18T10:00:00Z'),
            (200, 20, 'session', 'claude', 'opus', 'running', '2026-06-18T11:00:00Z'),
            (300, 30, 'session', 'codex', 'openai/gpt-5.4', 'completed', '2026-06-18T12:00:00Z');
        INSERT INTO agent_messages (id, session_id, role, message_type, content, tool_name, created_at) VALUES
            (1000, 100, 'assistant', 'text', 'MCP orchestration spawned helper sessions', NULL, '2026-06-18T10:01:00Z'),
            (1001, 100, 'user', 'user_message', 'Please implement workspace MCP search', NULL, '2026-06-18T10:02:00Z'),
            (1002, 100, 'tool', 'tool_result', 'orchestration shell result', 'shell', '2026-06-18T10:03:00Z'),
            (1003, 100, 'tool', 'tool_result', 'orchestration shell result after window', 'shell', '2026-06-18T10:05:00Z'),
            (1004, 100, 'tool', 'tool_result', 'orchestration git result', 'git', '2026-06-18T10:03:30Z'),
            (2000, 200, 'assistant', 'text', 'Settings migration discussion', NULL, '2026-06-18T11:01:00Z'),
            (3000, 300, 'tool', 'tool_result', 'orchestration shell result over cursor', 'shell', '2026-06-18T12:01:00Z');
        INSERT INTO agent_message_origins (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, source_message_id, note, created_at)
            VALUES (2000, 'session_generated', 777, 42, 7, 9001, 'workspace provenance read', '2026-06-18T11:01:30Z');
        INSERT INTO agent_session_links (id, source_session_id, target_session_id, link_type, created_at, note) VALUES
            (1, 100, 200, 'spawned', '2026-06-18T11:02:00Z', 'delegated settings review'),
            (2, 300, 100, 'referenced', '2026-06-18T12:02:00Z', 'used alpha context');
        INSERT INTO agent_messages_fts(agent_messages_fts) VALUES('rebuild');
        "#,
    )
    .execute(&pool)
    .await
    .expect("seed workspace test database");
    McpContext::new_with_source_session(pool.clone(), pool, 10, Some(100))
}

fn result_text(result: rmcp::model::CallToolResult) -> String {
    let value = serde_json::to_value(result).expect("serialize result");
    value["content"][0]["text"].as_str().unwrap().to_string()
}
