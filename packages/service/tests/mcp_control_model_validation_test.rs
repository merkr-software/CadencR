mod support;

use axum::http::StatusCode;
use cadencr_service::app_state::AppState;
use cadencr_service::domain::mcp::control::control_router;
use tower::ServiceExt;

use support::mcp_control::{
    fake_codex_project, seeded_control_pool, spawn_request_from_body,
    spawn_request_with_optional_provider_model, spawn_request_with_provider_model,
};

async fn response_text(response: axum::response::Response) -> String {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8(body.to_vec()).unwrap()
}

#[tokio::test]
async fn project_spawn_session_rejects_unknown_model_for_selected_provider() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_with_provider_model(
            serde_json::json!({ "mode": "skip" }),
            true,
            "claude_code",
            "not-a-claude-model",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unknown model 'not-a-claude-model' for provider 'claude_code'"));
    assert!(body_text.contains("Available models:"));
    assert!(body_text.contains("opus"));
    let spawned_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM features WHERE title = 'Investigate flaky login test'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(spawned_count, 0);
    let audit_error: String = sqlx::query_scalar(
        "SELECT error FROM mcp_tool_audit_log WHERE tool_name = 'project_spawn_session'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit_error.contains("unknown model 'not-a-claude-model' for provider 'claude_code'"));
    assert!(audit_error.contains("Available models:"));
}

#[tokio::test]
async fn project_spawn_session_rejects_unknown_model_for_inherited_provider() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_with_optional_provider_model(
            serde_json::json!({ "mode": "skip" }),
            true,
            None,
            "not-a-claude-model",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unknown model 'not-a-claude-model' for provider 'claude_code'"));
    assert!(body_text.contains("Available models:"));
}

#[tokio::test]
async fn project_spawn_session_normalizes_common_provider_aliases() {
    let pool = seeded_control_pool().await;
    let _codex = fake_codex_project(&pool).await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_from_body(serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "target_project_id": 7,
            "title": "Investigate flaky login test",
            "initial_message": "Please investigate and report findings.",
            "branch": { "mode": "skip" },
            "provider": "codex",
            "profile": "default",
            "permission_mode": "default",
            "codex_permission_mode": "autoReview",
            "source_note": "delegated by project MCP",
            "link_to_current_session": true
        })))
        .await
        .unwrap();
    let status = response.status();
    let body_text = response_text(response).await;
    assert_eq!(status, StatusCode::OK, "{body_text}");
    let provider: String = sqlx::query_scalar(
        "SELECT runtime_provider FROM agent_sessions WHERE id != 777 ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(provider, "codex_cli");
}

#[tokio::test]
async fn project_spawn_session_normalizes_common_claude_model_aliases() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_with_provider_model(
            serde_json::json!({ "mode": "skip" }),
            true,
            "claude-code",
            "Opus",
        ))
        .await
        .unwrap();

    let status = response.status();
    assert_eq!(status, StatusCode::OK, "{}", response_text(response).await);
    let session: (String, String) = sqlx::query_as(
        "SELECT runtime_provider, model FROM agent_sessions WHERE id != 777 ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(session.0, "claude_code");
    assert_ne!(session.1, "Opus");
    assert!(session.1.to_ascii_lowercase().contains("opus"));
}

#[tokio::test]
async fn project_spawn_session_pins_selected_claude_profile() {
    let pool = seeded_control_pool().await;
    cadencr_service::domain::agents::claude_code::profiles::upsert_profile(
        "bedrock",
        &std::collections::HashMap::new(),
    )
    .await
    .unwrap();
    cadencr_service::domain::agents::claude_code::profiles::set_active_profile("bedrock")
        .await
        .unwrap();
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_from_body(serde_json::json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "target_project_id": 7,
            "title": "Profile-aware child",
            "branch": { "mode": "skip" },
            "provider": "claude_code",
            "model": "opus"
        })))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let stored_profile: Option<String> = sqlx::query_scalar(
        "SELECT profile FROM agent_sessions WHERE id != 777 ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored_profile.as_deref(), Some("bedrock"));

    cadencr_service::domain::agents::claude_code::profiles::delete_profile("bedrock")
        .await
        .unwrap();
}

#[tokio::test]
async fn project_spawn_session_unknown_provider_error_lists_valid_ids() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool));

    let response = app
        .oneshot(spawn_request_with_provider_model(
            serde_json::json!({ "mode": "skip" }),
            true,
            "claudeish",
            "opus",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unknown provider 'claudeish'"));
    assert!(body_text.contains("Valid providers: claude_code, codex_cli, cursor, opencode"));
}

#[tokio::test]
async fn project_spawn_session_accepts_canonical_catalog_model_for_selected_provider() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_with_provider_model(
            serde_json::json!({ "mode": "skip" }),
            true,
            "opencode",
            "default/default",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let session: (String, String) = sqlx::query_as(
        "SELECT runtime_provider, model FROM agent_sessions WHERE id != 777 ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(session, ("opencode".into(), "default/default".into()));
}

#[tokio::test]
async fn project_spawn_session_rejects_cross_provider_model_for_selected_provider() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_with_provider_model(
            serde_json::json!({ "mode": "skip" }),
            true,
            "claude_code",
            "openai/gpt-5.4",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unknown model 'openai/gpt-5.4' for provider 'claude_code'"));
    assert!(body_text.contains("Available models:"));
    assert!(body_text.contains("opus"));
}

#[tokio::test]
async fn project_spawn_session_rejects_unadvertised_thinking_level() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(support::mcp_control::spawn_request_from_body(
            serde_json::json!({
                "source_feature_id": 42,
                "source_session_id": 777,
                "target_project_id": 7,
                "title": "Unsupported thinking child",
                "branch": { "mode": "none" },
                "provider": "opencode",
                "model": "default/default",
                "thinking_level": "impossible"
            }),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unsupported thinking level 'impossible'"));
    assert!(body_text.contains("project_list_agent_providers"));
    let spawned_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM features WHERE title = 'Unsupported thinking child'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(spawned_count, 0);
}
