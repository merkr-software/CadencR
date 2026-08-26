use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use cadencr_service::domain::mcp::servers::{mcp_server_name, AgentType};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// Upper bound for MCP child-process I/O: response reads and shutdown wait.
const IO_TIMEOUT: Duration = Duration::from_secs(5);

struct McpTestProcess {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

/// Verify mcp_server_name returns the canonical `cadencr-browser` prefix.
#[test]
fn test_mcp_server_name_browser() {
    assert_eq!(mcp_server_name(AgentType::Browser), "cadencr-browser");
}

#[test]
fn test_mcp_server_names_for_project_and_workspace() {
    assert_eq!(mcp_server_name(AgentType::Project), "cadencr-project");
    assert_eq!(mcp_server_name(AgentType::Workspace), "cadencr-workspace");
    assert!(AgentType::ALL.contains(&AgentType::Project));
    assert!(AgentType::ALL.contains(&AgentType::Workspace));
}

/// Verify the browser MCP stdio server initializes and lists tools end-to-end.
#[tokio::test]
async fn test_mcp_stdio_server_responds_to_tools_list() {
    let (_tmp, db_path) = setup_browser_test_db().await;
    let Some(mut process) = spawn_mcp_process(&db_path, "browser") else {
        return;
    };

    initialize_mcp(&mut process, "cadencr-browser", Some("2024-11-05")).await;
    let tools = list_mcp_tools(&mut process).await;

    assert_browser_tools(&tools);
    shutdown_mcp_process(process).await;
}

/// Regression test for issue #208: a client requesting protocol `2026-07-28`
/// must be negotiated down to the pinned version, and `tools/list` must keep
/// the legacy wire shape (no top-level `resultType`). rmcp 3.1.1 tags
/// `2026-07-28` results with `resultType` but omits the SEP-2549-mandatory
/// `ttlMs`/`cacheScope`, which spec-conformant clients such as Claude Code
/// reject — leaving the session with zero tools.
#[tokio::test]
async fn test_mcp_negotiates_below_2026_07_28_and_keeps_legacy_result_shape() {
    let (_tmp, db_path) = setup_browser_test_db().await;
    let Some(mut process) = spawn_mcp_process(&db_path, "browser") else {
        return;
    };

    let init_req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#;
    write_json_line(&mut process.stdin, init_req).await;
    let mut line = String::new();
    tokio::time::timeout(IO_TIMEOUT, process.reader.read_line(&mut line))
        .await
        .expect("timed out waiting for initialize response")
        .unwrap();
    let init_resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(init_resp["result"]["protocolVersion"], "2025-11-25");

    let initialized = r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#;
    write_json_line(&mut process.stdin, initialized).await;

    let tools_req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
    write_json_line(&mut process.stdin, tools_req).await;
    let mut tools_line = String::new();
    tokio::time::timeout(IO_TIMEOUT, process.reader.read_line(&mut tools_line))
        .await
        .expect("timed out waiting for tools/list response")
        .unwrap();
    let tools_resp: serde_json::Value = serde_json::from_str(&tools_line).unwrap();
    assert!(
        tools_resp["result"].get("resultType").is_none(),
        "tools/list must keep the legacy wire shape, got: {tools_resp}"
    );
    assert!(!tools_resp["result"]["tools"].as_array().unwrap().is_empty());

    shutdown_mcp_process(process).await;
}

async fn setup_browser_test_db() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let pool = create_test_pool(&db_path).await;

    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await
        .unwrap();
    create_browser_test_schema(&pool).await;
    sqlx::query("INSERT INTO features (id, title) VALUES (1, 'Test Feature')")
        .execute(&pool)
        .await
        .unwrap();

    drop(pool);
    (tmp, db_path)
}

async fn setup_project_test_db() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::TempDir::new().unwrap();
    let db_path = tmp.path().join("test.db");
    let pool = create_test_pool(&db_path).await;

    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await
        .unwrap();
    create_project_test_schema(&pool).await;
    insert_project_test_rows(&pool).await;

    drop(pool);
    (tmp, db_path)
}

async fn create_test_pool(db_path: &Path) -> sqlx::SqlitePool {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&db_url)
        .await
        .unwrap()
}

async fn create_browser_test_schema(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS features (
            id INTEGER PRIMARY KEY,
            project_id INTEGER,
            title TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'ws-session',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .unwrap();
    create_shared_session_tables(pool, false).await;
}

async fn create_project_test_schema(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE projects (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE features (
            id INTEGER PRIMARY KEY,
            project_id INTEGER,
            title TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'ws-session',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .unwrap();
    create_shared_session_tables(pool, true).await;
}

async fn create_shared_session_tables(pool: &sqlx::SqlitePool, include_runtime: bool) {
    if include_runtime {
        create_runtime_session_table(pool).await;
    } else {
        create_basic_session_table(pool).await;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_messages (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            role TEXT,
            message_type TEXT,
            content TEXT,
            tool_name TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn create_basic_session_table(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER,
            agent_type TEXT,
            status TEXT DEFAULT 'running',
            started_at TEXT
        )",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn create_runtime_session_table(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER,
            agent_type TEXT,
            status TEXT DEFAULT 'running',
            model TEXT,
            runtime_provider TEXT,
            started_at TEXT
        )",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_project_test_rows(pool: &sqlx::SqlitePool) {
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (7, 'Project', '/tmp/project')")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 7, 'Test Feature')")
        .execute(pool)
        .await
        .unwrap();
}

fn service_binary() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("cadencr-service")
}

fn spawn_mcp_process(db_path: &Path, agent_type: &str) -> Option<McpTestProcess> {
    let binary = service_binary();
    let child = Command::new(&binary)
        .arg("--db-path")
        .arg(db_path.to_str().unwrap())
        .arg("mcp-serve")
        .arg("--agent-type")
        .arg(agent_type)
        .arg("--feature-id")
        .arg("1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            eprintln!("Skipping test: cadencr-service binary not found at {binary:?}");
            return None;
        }
        Err(error) => panic!("failed to spawn cadencr-service: {error}"),
    };

    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);
    Some(McpTestProcess {
        child,
        stdin,
        reader,
    })
}

async fn initialize_mcp(
    process: &mut McpTestProcess,
    expected_name: &str,
    expected_protocol: Option<&str>,
) {
    let init_req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#;
    write_json_line(&mut process.stdin, init_req).await;

    let mut line = String::new();
    process.reader.read_line(&mut line).await.unwrap();
    let init_resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(init_resp["result"]["serverInfo"]["name"], expected_name);
    if let Some(protocol) = expected_protocol {
        assert_eq!(init_resp["result"]["protocolVersion"], protocol);
    }

    let initialized = r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#;
    write_json_line(&mut process.stdin, initialized).await;
}

async fn list_mcp_tools(process: &mut McpTestProcess) -> Vec<serde_json::Value> {
    let tools_req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
    write_json_line(&mut process.stdin, tools_req).await;

    let mut tools_line = String::new();
    process.reader.read_line(&mut tools_line).await.unwrap();
    assert!(
        !tools_line.is_empty(),
        "tools/list response should not be empty"
    );

    let tools_resp: serde_json::Value = serde_json::from_str(&tools_line).unwrap();
    tools_resp["result"]["tools"].as_array().unwrap().clone()
}

async fn write_json_line(stdin: &mut ChildStdin, line: &str) {
    stdin.write_all(line.as_bytes()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    stdin.flush().await.unwrap();
}

fn assert_browser_tools(tools: &[serde_json::Value]) {
    let tool_names = tool_names(tools);
    assert!(
        tool_names.contains(&"browser_open_url"),
        "missing browser_open_url"
    );
    assert!(
        tool_names.contains(&"browser_screenshot"),
        "missing browser_screenshot"
    );
    assert_absent_tools(
        &tool_names,
        &["mark_agent_done", "list_conversations", "read_conversation"],
    );
    assert_browser_open_url_schema_is_pinned(tools);
}

fn assert_absent_tools(tool_names: &[&str], absent_tools: &[&str]) {
    for absent_tool in absent_tools {
        assert!(
            !tool_names.contains(absent_tool),
            "{absent_tool} must not be exposed by cadencr-browser"
        );
    }
}

fn assert_browser_open_url_schema_is_pinned(tools: &[serde_json::Value]) {
    let open_url_tool = tools
        .iter()
        .find(|tool| tool["name"].as_str() == Some("browser_open_url"))
        .expect("browser_open_url tool");
    let input_schema = &open_url_tool["inputSchema"];
    assert!(
        input_schema["properties"].get("feature_id").is_none(),
        "browser tools are subprocess-pinned and must not ask agents for feature_id"
    );
    assert!(
        !input_schema["required"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .any(|value| value.as_str() == Some("feature_id")),
        "feature_id must not be a required browser tool argument"
    );
}

async fn shutdown_mcp_process(mut process: McpTestProcess) {
    drop(process.stdin);
    let _ = tokio::time::timeout(IO_TIMEOUT, process.child.wait()).await;
}

async fn assert_stdio_tools_list_for_agent_type(
    agent_type: &str,
    expected_name: &str,
    expected_tools: &[&str],
) {
    let (_tmp, db_path) = setup_project_test_db().await;
    let Some(mut process) = spawn_mcp_process(&db_path, agent_type) else {
        return;
    };

    initialize_mcp(&mut process, expected_name, None).await;
    let tools = list_mcp_tools(&mut process).await;
    let tool_names = tool_names(&tools);

    for expected_tool in expected_tools {
        assert!(
            tool_names.contains(expected_tool),
            "missing expected tool {expected_tool} in {tool_names:?}"
        );
    }

    shutdown_mcp_process(process).await;
}

fn tool_names(tools: &[serde_json::Value]) -> Vec<&str> {
    tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn test_project_mcp_stdio_server_advertises_project_tools() {
    assert_stdio_tools_list_for_agent_type(
        "project",
        "cadencr-project",
        &[
            "project_list_sessions",
            "project_read_session",
            "project_read_session_tail",
            "project_get_session_status",
            "project_get_worktree_status",
            "project_find_related_sessions",
            "project_compare_sessions",
            "project_link_sessions",
            "project_list_agent_providers",
            "project_spawn_session",
            "project_send_session_message",
        ],
    )
    .await;
}

#[tokio::test]
async fn test_workspace_mcp_stdio_server_advertises_workspace_tools() {
    assert_stdio_tools_list_for_agent_type(
        "workspace",
        "cadencr-workspace",
        &[
            "workspace_list_projects",
            "workspace_read_session",
            "workspace_read_sessions",
            "workspace_session_graph",
            "workspace_recent_activity",
            "workspace_send_session_message",
        ],
    )
    .await;
}
