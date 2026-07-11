#![allow(dead_code)]

use axum::{body::Body, http::Request};
use cadencr_service::shared::migrate::{run_migrations, MigrationContext};
use serde_json::{json, Value};

pub async fn seeded_control_pool() -> sqlx::SqlitePool {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    run_migrations(&MigrationContext {
        pool: &pool,
        db_path: None,
        app_version: None,
    })
    .await
    .unwrap();
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (id, project_id, title, status, type) VALUES (42, 7, 'Source', 'active', 'ws-session')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES (777, 42, 'session', 'running')")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

pub async fn seed_recent_send_audits(pool: &sqlx::SqlitePool, count: i64) {
    for _ in 0..count {
        sqlx::query(
            "INSERT INTO mcp_tool_audit_log
             (server_name, tool_name, source_session_id, source_feature_id, source_project_id,
              target_session_id, target_feature_id, target_project_id, status, created_at)
             VALUES ('cadencr-project', 'project_send_session_message', 777, 42, 7,
                     888, 43, 7, 'ok', datetime('now'))",
        )
        .execute(pool)
        .await
        .unwrap();
    }
}

pub async fn seed_send_target_session(pool: &sqlx::SqlitePool, status: &str) {
    seed_target_session(pool, 888, 43, status, None).await;
}

pub async fn seed_target_session(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    feature_id: i64,
    status: &str,
    runtime_provider: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO features (id, project_id, title, status, type)
         VALUES (?, 7, 'Target', 'active', 'ws-session')",
    )
    .bind(feature_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider)
         VALUES (?, ?, 'session', ?, ?)",
    )
    .bind(session_id)
    .bind(feature_id)
    .bind(status)
    .bind(runtime_provider)
    .execute(pool)
    .await
    .unwrap();
}

pub async fn seed_spawn_chain(pool: &sqlx::SqlitePool, root_session_id: i64, chain_length: i64) {
    let mut previous_session_id = root_session_id;
    for offset in 1..=chain_length {
        let feature_id = 1000 + offset;
        let session_id = 2000 + offset;
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (?, 7, ?, 'active', 'ws-session')",
        )
        .bind(feature_id)
        .bind(format!("Spawned {offset}"))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status)
             VALUES (?, ?, 'session', 'paused')",
        )
        .bind(session_id)
        .bind(feature_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type)
             VALUES (?, ?, 'spawned')",
        )
        .bind(previous_session_id)
        .bind(session_id)
        .execute(pool)
        .await
        .unwrap();
        previous_session_id = session_id;
    }
}

pub fn send_message_request(delivery: &str) -> Request<Body> {
    send_message_request_with_link(delivery, true)
}

pub fn send_message_request_with_link(
    delivery: &str,
    link_to_current_session: bool,
) -> Request<Body> {
    let body = json!({
        "source_feature_id": 42,
        "source_session_id": 777,
        "target_session_id": 888,
        "message": "Please validate delivery.",
        "delivery": delivery,
        "source_note": "delegated by project MCP",
        "link_to_current_session": link_to_current_session
    });
    Request::builder()
        .method("POST")
        .uri("/internal/mcp/project/send-message")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub fn spawn_request() -> Request<Body> {
    spawn_request_with_link(true)
}

pub fn spawn_request_with_link(link_to_current_session: bool) -> Request<Body> {
    spawn_request_with_branch(
        json!({ "mode": "new_worktree", "base": "main" }),
        link_to_current_session,
    )
}

pub fn spawn_request_with_branch(branch: Value, link_to_current_session: bool) -> Request<Body> {
    spawn_request_with_provider_model(branch, link_to_current_session, "claude_code", "opus")
}

pub fn spawn_request_with_provider_model(
    branch: Value,
    link_to_current_session: bool,
    provider: &str,
    model: &str,
) -> Request<Body> {
    spawn_request_with_optional_provider_model(
        branch,
        link_to_current_session,
        Some(provider),
        model,
    )
}

pub fn spawn_request_with_optional_provider_model(
    branch: Value,
    link_to_current_session: bool,
    provider: Option<&str>,
    model: &str,
) -> Request<Body> {
    spawn_request_with_optional_provider_optional_model(
        branch,
        link_to_current_session,
        provider,
        Some(model),
    )
}

pub fn spawn_request_with_optional_provider_optional_model(
    branch: Value,
    link_to_current_session: bool,
    provider: Option<&str>,
    model: Option<&str>,
) -> Request<Body> {
    let body = json!({
        "source_feature_id": 42,
        "source_session_id": 777,
        // Target the caller's own seeded project (id 7) — a spawn now requires an
        // explicit target, and "spawn locally" means passing the caller's project id.
        "target_project_id": 7,
        "title": "Investigate flaky login test",
        "initial_message": "Please investigate and report findings.",
        "branch": branch,
        "provider": provider,
        "model": model,
        "permission_mode": "default",
        "codex_permission_mode": "autoReview",
        "source_note": "delegated by project MCP",
        "link_to_current_session": link_to_current_session
    });
    spawn_request_from_body(body)
}

pub fn spawn_request_from_body(body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/internal/mcp/project/spawn-session")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub async fn latest_codex_permission_mode(pool: &sqlx::SqlitePool) -> String {
    sqlx::query_scalar(
        "SELECT codex_permission_mode FROM agent_sessions
         WHERE runtime_provider = 'codex_cli'
         ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}
