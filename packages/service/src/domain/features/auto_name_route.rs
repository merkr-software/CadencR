use axum::extract::{Json, Path, State};

use crate::app_state::AppState;
use crate::domain::features::repository::manual_title_revision;
use crate::domain::features::routes::SuccessResponse;
use crate::domain::features::service;
use crate::domain::features::title::lock_title_updates;
use crate::domain::ws_session::auto_name;
use crate::error::AppError;

/// Trigger auto-naming for a feature on demand. Requires at least one user
/// message, then waits for the rename to finish so callers get visible HTTP
/// loading/error state even when no WebSocket client is connected.
///
/// We deliberately allow this on default titles ("Session N", "Untitled
/// Feature") — that's the exact case where the initial implicit auto-naming
/// silently failed and the user wants to retry from the title context menu.
#[utoipa::path(post, path = "/api/features/{id}/auto-name",
    params(("id" = i64, Path,)),
    responses((status = 200, body = SuccessResponse)))]
pub async fn auto_name_feature_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
) -> Result<Json<SuccessResponse>, AppError> {
    let (_permit, revision) = {
        let _title_update = lock_title_updates(feature_id).await;
        let Some(permit) = state.auto_name_runs.try_acquire(feature_id) else {
            return Err(AppError::Conflict(format!(
                "auto-rename is already running for feature {feature_id}"
            )));
        };
        let revision = manual_title_revision(&state.read_pool, feature_id).await?;
        (permit, revision)
    };

    run_auto_rename(&state, feature_id, revision.as_deref()).await
}

async fn run_auto_rename(
    state: &AppState,
    feature_id: i64,
    revision: Option<&str>,
) -> Result<Json<SuccessResponse>, AppError> {
    let cwd = service::get_feature_cwd(&state.read_pool, feature_id).await?;
    let user_input = auto_name::get_last_user_message(&state.read_pool, feature_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("no user message available for auto-rename".into()))?;
    let senders = state.ws_feature_senders.get_senders(feature_id).await;
    auto_name::auto_name_on_request(
        &state.write_pool,
        feature_id,
        &user_input,
        &cwd,
        &senders,
        revision,
    )
    .await?;

    Ok(Json(SuccessResponse { success: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use tokio::sync::mpsc;

    use crate::domain::settings_store;
    use crate::domain::ws_session::protocol::WsEnvelope;
    use crate::shared::test_query_plan::migrated_pool;

    async fn state_with_prompt() -> AppState {
        let pool = migrated_pool().await;
        sqlx::raw_sql(
            "INSERT INTO projects (id, name, path) VALUES (1, 'naming-test', '/tmp');
             INSERT INTO features (id, project_id, title) VALUES (1, 1, 'Session 1');
             INSERT INTO agent_sessions (id, feature_id, agent_type, status)
                VALUES (1, 1, 'session', 'idle');
             INSERT INTO agent_messages (session_id, role, content, message_type)
                VALUES (1, 'user', 'Fix login', 'user_message');",
        )
        .execute(&pool)
        .await
        .unwrap();
        AppState::with_pool(pool)
    }

    #[tokio::test]
    async fn explicit_naming_reports_its_failure_only_over_http_and_releases_the_permit() {
        let state = state_with_prompt().await;
        let path = settings_store::paths::global_file(&settings_store::global_dir());
        settings_store::file::write_atomic(
            &path,
            r#"{"agent_runtime_auto_name":["synthetic-private-value"]}"#,
        )
        .unwrap();

        // The first request is headless, and the retry has a live viewer.
        let (tx, mut rx) = mpsc::unbounded_channel();
        for with_viewer in [false, true] {
            if with_viewer {
                state.ws_feature_senders.register(1, tx.clone()).await;
            }

            let error = match auto_name_feature_handler(State(state.clone()), Path(1)).await {
                Err(error) => error,
                Ok(_) => panic!("invalid settings must fail the request"),
            };
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["code"], "SETTINGS_INVALID");
            assert_eq!(body["details"]["auto_name_reason"], "settings_selection");
            let message = body["error"].as_str().unwrap();
            assert!(message.contains("auto-naming provider"));
            assert!(!message.contains("synthetic-private-value"));

            if with_viewer {
                for in_progress in [true, false] {
                    let frame = rx.try_recv().unwrap().into_text().unwrap();
                    let envelope = WsEnvelope::try_from(frame.to_string()).unwrap();
                    assert_eq!(envelope.action, "feature.autonaming");
                    assert_eq!(envelope.payload["in_progress"], in_progress);
                }
            }
            assert!(
                rx.try_recv().is_err(),
                "HTTP failure must not duplicate a WS notice"
            );
        }
    }
}
