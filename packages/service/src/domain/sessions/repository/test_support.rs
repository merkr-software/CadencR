//! Shared test helpers for the `repository` submodules.
//!
//! Per the `inline-rust-tests.md` rule, every module's unit tests live inline
//! behind `#[cfg(test)]` in the source file they cover. This module only
//! exposes shared fixtures (DB setup, row builders) so that those inline
//! tests don't each re-define the same boilerplate.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use super::super::models::*;

pub(super) async fn setup_test_db() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .connect("sqlite::memory:")
        .await
        .expect("Failed to create in-memory SQLite pool");

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL DEFAULT ''
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS features (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL DEFAULT 1,
            title TEXT NOT NULL DEFAULT 'test feature'
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS agent_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feature_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL DEFAULT 'main',
            runtime_provider TEXT,
            runtime_session_id TEXT,
            status TEXT NOT NULL DEFAULT 'running',
            started_at TEXT,
            ended_at TEXT,
            subprocess_id TEXT,
            model TEXT,
            pending_questions TEXT,
            has_file_changes INTEGER NOT NULL DEFAULT 0,
            permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default',
            pending_permission TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            context_window INTEGER,
            was_compacted INTEGER NOT NULL DEFAULT 0,
            draft_prompt TEXT
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT 'text',
            tool_name TEXT,
            tool_use_id TEXT,
            parent_tool_use_id TEXT,
            created_at TEXT,
            model TEXT
        )"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

pub(super) async fn insert_session(pool: &SqlitePool, feature_id: i64, status: &str) -> i64 {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (?, 'main', ?) RETURNING id",
    )
    .bind(feature_id)
    .bind(status)
    .fetch_one(pool)
    .await
    .unwrap();
    row.0
}

pub(super) async fn insert_message(
    pool: &SqlitePool,
    session_id: i64,
    message_type: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_use_id: Option<&str>,
    parent_tool_use_id: Option<&str>,
) -> i64 {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO agent_messages (session_id, message_type, content, tool_name, tool_use_id, parent_tool_use_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(session_id)
    .bind(message_type)
    .bind(content)
    .bind(tool_name)
    .bind(tool_use_id)
    .bind(parent_tool_use_id)
    .fetch_one(pool)
    .await
    .unwrap();
    row.0
}

pub(super) fn make_message(
    id: i64,
    session_id: i64,
    message_type: &str,
    content: &str,
) -> AgentMessageRow {
    AgentMessageRow {
        id,
        session_id,
        message_type: message_type.to_string(),
        content: content.to_string(),
        tool_name: None,
        tool_use_id: None,
        parent_tool_use_id: None,
        created_at: None,
        model: None,
        origin: None,
    }
}

pub(super) fn make_message_full(
    id: i64,
    session_id: i64,
    message_type: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_use_id: Option<&str>,
    parent_tool_use_id: Option<&str>,
) -> AgentMessageRow {
    AgentMessageRow {
        id,
        session_id,
        message_type: message_type.to_string(),
        content: content.to_string(),
        tool_name: tool_name.map(|s| s.to_string()),
        tool_use_id: tool_use_id.map(|s| s.to_string()),
        parent_tool_use_id: parent_tool_use_id.map(|s| s.to_string()),
        created_at: None,
        model: None,
        origin: None,
    }
}

pub(super) fn make_root_block(id_num: i64) -> AgentBlock {
    AgentBlock {
        id: format!("msg-{id_num}"),
        type_: "text".to_string(),
        content: String::new(),
        tool_name: None,
        tool_args: None,
        is_error: None,
        tool_use_id: None,
        parent_tool_use_id: None,
        child_blocks: None,
        source_tool_name: None,
        created_at: None,
        model: None,
        truncated_content: None,
        origin: None,
    }
}
