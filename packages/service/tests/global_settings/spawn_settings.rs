use axum::{body::to_bytes, http::StatusCode, Router};
use cadencr_service::app_state::AppState;
use cadencr_service::domain::{mcp::control::control_router, settings_store};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

use crate::support::mcp_control::{
    seeded_control_pool, spawn_request_from_body, temp_project_path,
};
use crate::{isolated_settings, SUITE_ROOT};

#[tokio::test]
async fn spawn_refuses_required_global_settings_before_creation_even_with_explicit_controls() {
    let _settings = isolated_settings().await;
    let pool = seeded_control_pool().await;
    let _project = temp_project_path(&pool).await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));
    let baseline = spawn_rows(&pool).await;
    let path = settings_store::paths::global_file(&settings_store::global_dir());

    std::fs::create_dir(&path).unwrap();
    assert_refused(
        &app,
        "new_worktree",
        StatusCode::UNPROCESSABLE_ENTITY,
        "SETTINGS_READ_FAILED",
    )
    .await;
    assert_eq!(spawn_rows(&pool).await, baseline);
    std::fs::remove_dir(&path).unwrap();

    for invalid in ["{ broken", r#"{"workspace_mcp_enabled":[]}"#] {
        std::fs::write(&path, invalid).unwrap();
        assert_refused(
            &app,
            "new_worktree",
            StatusCode::BAD_REQUEST,
            "SETTINGS_INVALID",
        )
        .await;
        assert_eq!(spawn_rows(&pool).await, baseline);
    }
    assert!(!SUITE_ROOT.join("worktrees").exists());
}

#[tokio::test]
async fn spawn_checks_branch_settings_before_creation_and_allows_skip_when_unused() {
    let _settings = isolated_settings().await;
    let pool = seeded_control_pool().await;
    let _project = temp_project_path(&pool).await;
    let app = control_router().with_state(AppState::with_pool(pool.clone()));
    let baseline = spawn_rows(&pool).await;
    let path = settings_store::paths::project_file(&settings_store::global_dir(), &pool, 7)
        .await
        .unwrap();
    for invalid in [
        "{ broken",
        r#"{"branch_prefix":[]}"#,
        r#"{"setup_worktree":[]}"#,
    ] {
        std::fs::write(&path, invalid).unwrap();
        assert_refused(
            &app,
            "new_worktree",
            StatusCode::BAD_REQUEST,
            "SETTINGS_INVALID",
        )
        .await;
        assert_eq!(spawn_rows(&pool).await, baseline);
    }
    assert!(!SUITE_ROOT.join("worktrees").exists());

    std::fs::write(&path, "{ broken").unwrap();
    let (status, response) = spawn(&app, "skip").await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert!(response.get("dispatchError").is_none(), "{response}");
    let feature_id = response["featureId"].as_i64().unwrap();
    let worktree_path_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM feature_settings WHERE feature_id = ? AND key = 'worktree_path')",
    )
    .bind(feature_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!worktree_path_exists);
}

async fn spawn_rows(pool: &SqlitePool) -> (i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM features), (SELECT COUNT(*) FROM feature_settings),
                (SELECT COUNT(*) FROM agent_sessions), (SELECT COUNT(*) FROM agent_messages),
                (SELECT COUNT(*) FROM agent_session_links)",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn assert_refused(app: &Router, mode: &str, expected: StatusCode, code: &str) {
    let (status, response) = spawn(app, mode).await;
    assert_eq!(status, expected, "{response}");
    assert_eq!(response["code"], code, "{response}");
}

async fn spawn(app: &Router, mode: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(spawn_request_from_body(json!({
            "source_feature_id": 42,
            "source_session_id": 777,
            "title": "Spawn settings preflight",
            "initial_message": "Check the preflight.",
            "provider": "codex_cli",
            "profile": "default",
            "model": "qa-model",
            "permission_mode": "default",
            "codex_permission_mode": "default",
            "branch": { "mode": mode }
        })))
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
