//! `project_link_sessions`: record that the caller's session spawned, messaged,
//! referenced or handed off to another session of its project. A `spawned` or
//! `handoff` link nests the target conversation under the caller's in every
//! sidebar, so that link is broadcast as a feature update; the other types
//! change nothing a client shows.

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::audit::{audit_outcome, elapsed_ms, record_tool_audit, ToolAudit};
use super::schedule_scope::require_conversation;
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::error::AppError;

const TOOL_NAME: &str = "project_link_sessions";
const LINK_TYPES: &[&str] = &["spawned", "messaged", "referenced", "handoff"];
/// The link types the sidebar nests by (`features::repository`'s
/// `spawned_by_feature_id`).
const NESTING_LINK_TYPES: &[&str] = &["spawned", "handoff"];

#[derive(Debug, Deserialize)]
pub(super) struct LinkSessionsRequest {
    source_feature_id: i64,
    source_session_id: i64,
    target_session_id: i64,
    link_type: Option<String>,
    note: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct LinkSessionsResponse {
    link_id: i64,
    source_session_id: i64,
    target_session_id: i64,
    link_type: String,
}

pub(super) async fn link_sessions_handler(
    State(state): State<AppState>,
    Json(body): Json<LinkSessionsRequest>,
) -> Result<Json<LinkSessionsResponse>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    let (target, result) = match resolve_target(&state, &source, &body).await {
        Ok(target) => {
            let result = insert_link(&state, &source, &target, &body).await;
            (Some(target), result)
        }
        Err(error) => (None, Err(error)),
    };
    let (status, error, size) = audit_outcome(&result);
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: TOOL_NAME,
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: Some(body.target_session_id),
            target_feature_id: target.as_ref().map(|target| target.feature_id),
            target_project_id: target.as_ref().map(|target| target.project_id),
            status,
            result_size_bytes: size,
            latency_ms: elapsed_ms(started_at),
            error: error.as_deref(),
        },
    )
    .await?;
    result.map(Json)
}

async fn resolve_target(
    state: &AppState,
    source: &SessionScope,
    body: &LinkSessionsRequest,
) -> Result<SessionScope, AppError> {
    require_conversation(source, body.source_feature_id)?;
    let target = resolve_session_scope(&state.write_pool, body.target_session_id).await?;
    if target.project_id != source.project_id {
        return Err(AppError::BadRequest(
            "target session does not belong to current project".to_string(),
        ));
    }
    Ok(target)
}

async fn insert_link(
    state: &AppState,
    source: &SessionScope,
    target: &SessionScope,
    body: &LinkSessionsRequest,
) -> Result<LinkSessionsResponse, AppError> {
    let link_type = link_type(body.link_type.as_deref())?;
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty());
    let link_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (?, ?, ?, ?)
         RETURNING id",
    )
    .bind(source.session_id)
    .bind(target.session_id)
    .bind(link_type)
    .bind(note)
    .fetch_one(&state.write_pool)
    .await?;
    if NESTING_LINK_TYPES.contains(&link_type) {
        state.feature_events_tx.emit(
            target.feature_id,
            Some(target.project_id),
            FeatureEventAction::Updated,
        );
    }
    Ok(LinkSessionsResponse {
        link_id,
        source_session_id: source.session_id,
        target_session_id: target.session_id,
        link_type: link_type.to_string(),
    })
}

fn link_type(link_type: Option<&str>) -> Result<&str, AppError> {
    let link_type = link_type.unwrap_or("referenced");
    if LINK_TYPES.contains(&link_type) {
        Ok(link_type)
    } else {
        Err(AppError::BadRequest(format!(
            "unsupported link_type '{link_type}'"
        )))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    use super::super::schedule_scope::test_support::{post, session};
    use crate::app_state::AppState;
    use crate::domain::schedules::repository::test_support::fixture;

    const ROUTE: &str = "/internal/mcp/project/link-sessions";

    /// The caller's session, a target in its project, one in another project.
    struct Sessions {
        feature: i64,
        source: i64,
        target: i64,
        target_feature: i64,
        elsewhere: i64,
    }

    async fn sessions(pool: &sqlx::SqlitePool, project: i64, feature: i64) -> Sessions {
        let insert_feature = |project: i64| {
            sqlx::query_scalar::<_, i64>(
                "INSERT INTO features (project_id, title) VALUES (?, 'Other') RETURNING id",
            )
            .bind(project)
            .fetch_one(pool)
        };
        let other_project: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('Other', '/tmp/other') RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        let target_feature = insert_feature(project).await.unwrap();
        let elsewhere_feature = insert_feature(other_project).await.unwrap();
        Sessions {
            feature,
            source: session(pool, feature).await,
            target: session(pool, target_feature).await,
            target_feature,
            elsewhere: session(pool, elsewhere_feature).await,
        }
    }

    fn request(sessions: &Sessions, target: i64, link_type: &str) -> Value {
        json!({
            "source_feature_id": sessions.feature, "source_session_id": sessions.source,
            "target_session_id": target, "link_type": link_type, "note": "  "
        })
    }

    #[tokio::test]
    async fn a_nesting_link_is_recorded_audited_and_broadcast() {
        let (pool, project, feature) = fixture().await;
        let s = sessions(&pool, project, feature).await;
        let state = AppState::with_pool(pool.clone());
        let mut events = state.feature_events_tx.subscribe();

        let (status, body) = post(state.clone(), ROUTE, request(&s, s.target, "handoff")).await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["link_type"], "handoff");
        let row: (i64, i64, String, Option<String>) = sqlx::query_as(
            "SELECT source_session_id, target_session_id, link_type, note FROM agent_session_links",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (s.source, s.target, "handoff".into(), None));
        let event = events.try_recv().unwrap();
        assert_eq!(
            (event.feature_id, event.project_id),
            (s.target_feature, Some(project))
        );
        let audit: (String, i64, i64) = sqlx::query_as(
            "SELECT status, target_feature_id, target_project_id FROM mcp_tool_audit_log",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audit, ("ok".into(), s.target_feature, project));
    }

    /// Only `spawned` and `handoff` change what a sidebar shows.
    #[tokio::test]
    async fn other_link_types_are_recorded_without_a_broadcast() {
        let (pool, project, feature) = fixture().await;
        let s = sessions(&pool, project, feature).await;
        let state = AppState::with_pool(pool.clone());
        let mut events = state.feature_events_tx.subscribe();

        for link_type in ["messaged", "referenced"] {
            let (status, _) = post(state.clone(), ROUTE, request(&s, s.target, link_type)).await;
            assert_eq!(status, StatusCode::OK);
        }

        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn refused_links_write_nothing_but_their_audit() {
        let (pool, project, feature) = fixture().await;
        let s = sessions(&pool, project, feature).await;
        let state = AppState::with_pool(pool.clone());
        let mut events = state.feature_events_tx.subscribe();
        let mut wrong_feature = request(&s, s.target, "spawned");
        wrong_feature["source_feature_id"] = json!(s.target_feature);

        for (body, expected) in [
            (
                request(&s, s.elsewhere, "spawned"),
                "target session does not belong to current project",
            ),
            (
                request(&s, s.target, "adopted"),
                "unsupported link_type 'adopted'",
            ),
            (
                wrong_feature,
                "source_session_id does not belong to source_feature_id",
            ),
        ] {
            let (status, response) = post(state.clone(), ROUTE, body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(
                response["error"].as_str().unwrap().contains(expected),
                "{response}"
            );
        }

        let links: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_session_links")
            .fetch_one(&pool)
            .await
            .unwrap();
        let errors: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM mcp_tool_audit_log WHERE status = 'error'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((links, errors), (0, 3));
        assert!(events.try_recv().is_err());
    }
}
