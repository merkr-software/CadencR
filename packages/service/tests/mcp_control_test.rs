mod support;

use axum::http::StatusCode;
use cadencr_service::app_state::AppState;
use cadencr_service::domain::mcp::control::control_router;
use cadencr_service::domain::settings_store::global_write_content;
use tower::ServiceExt;

use support::mcp_control::{
    latest_codex_permission_mode, seed_recent_send_audits, seed_send_target_session,
    seed_spawn_chain, seeded_control_pool, send_message_request, send_message_request_with_link,
    spawn_request, spawn_request_from_body, spawn_request_with_link,
};

static SETTINGS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn project_spawn_session_creates_feature_session_provenance_and_link() {
    let pool = seeded_control_pool().await;

    let app = control_router().with_state(AppState::with_pool(pool.clone()));
    let response = app.oneshot(spawn_request()).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let response_body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let feature_id = response_body["featureId"].as_i64().unwrap();
    let session_id = response_body["sessionId"].as_i64().unwrap();
    let message_id = response_body["messageId"].as_i64().unwrap();

    let feature: (i64, String) =
        sqlx::query_as("SELECT project_id, title FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(feature, (7, "Investigate flaky login test".into()));
    let session: (i64, String, String, String, String) = sqlx::query_as(
        "SELECT feature_id, status, runtime_provider, model, codex_permission_mode FROM agent_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        session,
        (
            feature_id,
            "paused".into(),
            "claude_code".into(),
            "opus".into(),
            "default".into()
        )
    );
    let worktree_base: String = sqlx::query_scalar(
        "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'worktree_base_branch'",
    )
    .bind(feature_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(worktree_base, "main");
    let origin: (String, i64, i64, i64, String) = sqlx::query_as(
        "SELECT origin_kind, source_session_id, source_feature_id, source_project_id, note FROM agent_message_origins WHERE message_id = ?",
    )
    .bind(message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        origin,
        (
            "session_generated".into(),
            777,
            42,
            7,
            "delegated by project MCP".into()
        )
    );
    let link: (i64, i64, String) = sqlx::query_as(
        "SELECT source_session_id, target_session_id, link_type FROM agent_session_links WHERE target_session_id = ?",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(link, (777, session_id, "spawned".into()));

    let audit: (String, i64, i64, i64, i64, String) = sqlx::query_as(
        "SELECT tool_name, source_session_id, source_feature_id, source_project_id, target_session_id, status
         FROM mcp_tool_audit_log
         WHERE tool_name = 'project_spawn_session'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        audit,
        (
            "project_spawn_session".into(),
            777,
            42,
            7,
            session_id,
            "ok".into()
        )
    );
}

#[tokio::test]
async fn project_spawn_session_can_skip_session_link() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app.oneshot(spawn_request_with_link(false)).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_session_links")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(link_count, 0);
}

#[tokio::test]
async fn project_spawn_session_inherits_configured_codex_permission_without_override() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let pool = seeded_control_pool().await;
    global_write_content(r#"{"codex_permission_mode":"autoReview"}"#)
        .await
        .unwrap();
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_from_body(serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "title": "Codex child",
            "initial_message": "Please investigate.",
            "branch": { "mode": "none" },
            "provider": "codex_cli",
            "permission_mode": "default",
            "source_note": "delegated by project MCP"
        })))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(latest_codex_permission_mode(&pool).await, "autoReview");
}

#[tokio::test]
async fn project_spawn_session_explicit_codex_permission_override_wins() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let pool = seeded_control_pool().await;
    global_write_content(r#"{"codex_permission_mode":"autoReview"}"#)
        .await
        .unwrap();
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_from_body(serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "title": "Codex child",
            "branch": { "mode": "none" },
            "provider": "codex_cli",
            "permission_mode": "default",
            "codex_permission_mode": "fullAccess",
            "source_note": "delegated by project MCP"
        })))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(latest_codex_permission_mode(&pool).await, "fullAccess");
}

#[tokio::test]
async fn project_spawn_session_ignores_legacy_write_policy_setting() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let pool = seeded_control_pool().await;
    global_write_content(r#"{"project_mcp_allow_spawn":"false"}"#)
        .await
        .unwrap();
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app.oneshot(spawn_request()).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let spawned_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM features WHERE title = 'Investigate flaky login test'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(spawned_count, 1);
}

#[tokio::test]
async fn project_send_message_ignores_legacy_write_policy_setting() {
    let _settings_guard = SETTINGS_TEST_LOCK.lock().await;
    let pool = seeded_control_pool().await;
    global_write_content(r#"{"project_mcp_allow_send_message":"false"}"#)
        .await
        .unwrap();
    seed_send_target_session(&pool, "running").await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(send_message_request("queue_if_busy"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let queued_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_session_message_queue")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(queued_count, 1);
}

#[tokio::test]
async fn project_spawn_session_allows_spawning_beyond_legacy_descendant_cap() {
    let pool = seeded_control_pool().await;
    seed_spawn_chain(&pool, 777, 6).await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app.oneshot(spawn_request()).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let spawned_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM features WHERE title = 'Investigate flaky login test'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(spawned_count, 1);
    let audit_status: String = sqlx::query_scalar(
        "SELECT status FROM mcp_tool_audit_log WHERE tool_name = 'project_spawn_session'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_status, "ok");
}

#[tokio::test]
async fn project_send_message_audits_invalid_delivery_without_persisting() {
    let pool = seeded_control_pool().await;
    seed_send_target_session(&pool, "paused").await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app.oneshot(send_message_request("teleport")).await.unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let message_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(message_count, 0);
    let audit: (String, i64, i64, i64, i64, String, String) = sqlx::query_as(
        "SELECT tool_name, source_session_id, source_feature_id, source_project_id,
                target_session_id, status, error
         FROM mcp_tool_audit_log
         WHERE tool_name = 'project_send_session_message'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit.0, "project_send_session_message");
    assert_eq!(audit.1, 777);
    assert_eq!(audit.2, 42);
    assert_eq!(audit.3, 7);
    assert_eq!(audit.4, 888);
    assert_eq!(audit.5, "error");
    assert!(audit.6.contains("unsupported delivery mode"));
}

#[tokio::test]
async fn project_send_message_queue_if_busy_creates_messaged_link() {
    let pool = seeded_control_pool().await;
    seed_send_target_session(&pool, "running").await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(send_message_request("queue_if_busy"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let message_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(message_count, 0);
    let link: (i64, i64, String, String) = sqlx::query_as(
        "SELECT source_session_id, target_session_id, link_type, note
         FROM agent_session_links
         WHERE source_session_id = 777 AND target_session_id = 888",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        link,
        (
            777,
            888,
            "messaged".into(),
            "delegated by project MCP".into()
        )
    );
}

#[tokio::test]
async fn project_send_message_can_skip_session_link() {
    let pool = seeded_control_pool().await;
    seed_send_target_session(&pool, "running").await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(send_message_request_with_link("queue_if_busy", false))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let link_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_session_links")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(link_count, 0);
}

#[tokio::test]
async fn project_send_message_rejects_when_hourly_source_budget_is_exhausted() {
    let pool = seeded_control_pool().await;
    seed_send_target_session(&pool, "paused").await;
    seed_recent_send_audits(&pool, 20).await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app.oneshot(send_message_request("send_now")).await.unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let message_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 888")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(message_count, 0);
}
