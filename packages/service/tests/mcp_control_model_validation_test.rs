mod support;

use axum::http::StatusCode;
use cadencr_service::app_state::AppState;
use cadencr_service::domain::mcp::control::control_router;
use tower::ServiceExt;

use support::mcp_control::{
    seeded_control_pool, spawn_request_with_optional_provider_model,
    spawn_request_with_provider_model,
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
            "opus 4.8",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unknown model 'opus 4.8' for provider 'claude_code'"));
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
    assert!(audit_error.contains("unknown model 'opus 4.8' for provider 'claude_code'"));
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
            "opus 4.8",
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body_text = response_text(response).await;
    assert!(body_text.contains("unknown model 'opus 4.8' for provider 'claude_code'"));
    assert!(body_text.contains("Available models:"));
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
