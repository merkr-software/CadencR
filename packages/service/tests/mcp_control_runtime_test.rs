mod support;

use axum::{extract::ws::Message, http::StatusCode};
use cadencr_service::app_state::AppState;
use cadencr_service::domain::mcp::control::control_router;
use serde_json::json;
use tower::ServiceExt;

use support::mcp_control::{
    seed_target_session, seeded_control_pool, send_message_request, spawn_request_with_branch,
};

#[tokio::test]
async fn send_now_routes_generated_message_through_runtime_pipeline() {
    let pool = seeded_control_pool().await;
    seed_target_session(&pool, 888, 43, "paused", Some("missing_provider")).await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app.oneshot(send_message_request("send_now")).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let generated_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages
         WHERE session_id = 888 AND role = 'user' AND message_type = 'user_message'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        generated_count, 1,
        "replay dispatch must not duplicate user rows"
    );
    let error_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages
         WHERE session_id = 888 AND message_type = 'error' AND content LIKE '%missing_provider%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        error_count, 1,
        "runtime pipeline should surface adapter errors"
    );
}

#[tokio::test]
async fn send_now_broadcasts_generated_user_message_to_target_viewers() {
    let pool = seeded_control_pool().await;
    seed_target_session(&pool, 888, 43, "paused", Some("missing_provider")).await;
    let state = AppState::with_pool(pool.clone());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    state.ws_feature_senders.register(43, tx).await;
    let app = control_router().with_state(state);

    let response = app.oneshot(send_message_request("send_now")).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let payload = recv_user_message_payload(&mut rx).await;
    assert_eq!(payload["text"], "Please validate delivery.");
    assert_eq!(payload["origin"]["originKind"], "session_generated");
    assert_eq!(payload["origin"]["sourceSessionId"], 777);
}

#[tokio::test]
async fn spawn_with_initial_message_persists_single_generated_prompt() {
    let pool = seeded_control_pool().await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));

    let response = app
        .oneshot(spawn_request_with_branch(json!({ "mode": "none" }), true))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let response_body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let session_id = response_body["sessionId"].as_i64().unwrap();
    let generated_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages
         WHERE session_id = ? AND role = 'user' AND message_type = 'user_message'",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        generated_count, 1,
        "initial replay must not duplicate user rows"
    );
}

async fn recv_user_message_payload(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Message>,
) -> serde_json::Value {
    for _ in 0..5 {
        let Some(Message::Text(text)) = rx.recv().await else {
            continue;
        };
        let env: serde_json::Value = serde_json::from_str(&text).unwrap();
        if env["domain"] == "session" && env["action"] == "user_message" {
            return env["payload"].clone();
        }
    }
    panic!("expected generated user_message broadcast");
}
