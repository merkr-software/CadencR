//! `project_archive_session`: archive a current-project conversation the way
//! the sidebar's Archive dialog does — optionally with its spawn parent and
//! descendants — then run the dialog's optional cleanup on it. Both go through
//! the same service orchestration (`features::archive_cleanup`), so the
//! cleanup is journaled and resumable whoever asked for it.
//!
//! Guard rails the dialog doesn't need, because here an agent picks the
//! target: it must be in the caller's project, the caller's own conversation is
//! never archived, and nothing about to be archived may have a working agent or
//! a pending gate (`Archiver::Agent`) — that agent would be left running in a
//! hidden conversation, possibly without its worktree.
//!
//! A step never fails the call: the archive is already done, and the agent
//! needs to know which part to retry. Where the dialog would show the user a
//! warning and then force (a dirty worktree, an unmerged branch), the step is
//! reported as blocked instead, and the agent has to ask for force explicitly.

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use super::audit::{audit_outcome, elapsed_ms, record_tool_audit, ToolAudit};
use super::schedule_scope::require_conversation;
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::domain::feature_events::AgentArchivedEvent;
use crate::domain::features::archive::Archiver;
use crate::domain::features::archive_cleanup::runner::archive_with_cleanup;
use crate::domain::features::archive_cleanup::{CleanupReport, StepName, StepStatus};
use crate::domain::features::models::ArchiveRequest;
use crate::error::AppError;

const TOOL_NAME: &str = "project_archive_session";

#[derive(Debug, Deserialize)]
pub(super) struct ArchiveSessionRequest {
    source_feature_id: i64,
    source_session_id: i64,
    session_id: i64,
    #[serde(flatten)]
    archive: ArchiveRequest,
}

#[derive(Debug, Serialize)]
pub(super) struct ArchiveSessionResponse {
    session_id: i64,
    feature_id: i64,
    archived_feature_ids: Vec<i64>,
    cleanup: CleanupReport,
}

pub(super) async fn archive_session_handler(
    State(state): State<AppState>,
    Json(body): Json<ArchiveSessionRequest>,
) -> Result<Json<ArchiveSessionResponse>, AppError> {
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, body.source_session_id).await?;
    let (target, result) = match resolve_target(&state, &source, &body).await {
        Ok(target) => {
            let result = archive_and_clean(&state, &source, &target, body).await;
            (Some(target), result)
        }
        Err(error) => (None, Err(error)),
    };
    audit(&state, &source, target.as_ref(), &result, started_at).await?;
    result.map(Json)
}

async fn resolve_target(
    state: &AppState,
    source: &SessionScope,
    body: &ArchiveSessionRequest,
) -> Result<SessionScope, AppError> {
    require_conversation(source, body.source_feature_id)?;
    let session_id = body.session_id;
    let target = resolve_session_scope(&state.write_pool, session_id).await?;
    if target.project_id != source.project_id {
        return Err(AppError::BadRequest(format!(
            "session {session_id} does not belong to the current project"
        )));
    }
    if target.feature_id == source.feature_id {
        return Err(AppError::BadRequest(format!(
            "{TOOL_NAME} cannot archive the calling conversation"
        )));
    }
    Ok(target)
}

async fn archive_and_clean(
    state: &AppState,
    source: &SessionScope,
    target: &SessionScope,
    body: ArchiveSessionRequest,
) -> Result<ArchiveSessionResponse, AppError> {
    let archiver = Archiver::Agent {
        caller_id: source.feature_id,
    };
    let outcome = archive_with_cleanup(state, target.feature_id, &body.archive, archiver).await?;
    let cleanup = with_force_hints(outcome.cleanup);
    // The Archive dialog's toast, for every open window: the agent's call has
    // no UI of its own to show it.
    state
        .feature_events_tx
        .emit_agent_archived(AgentArchivedEvent {
            project_id: target.project_id,
            feature_id: target.feature_id,
            title: target.feature_title.clone(),
            archived_by: source.feature_title.clone(),
            archived_feature_ids: outcome.archived_ids.clone(),
            cleanup: cleanup.clone(),
        });
    Ok(ArchiveSessionResponse {
        session_id: target.session_id,
        feature_id: target.feature_id,
        archived_feature_ids: outcome.archived_ids,
        cleanup,
    })
}

/// Tell the agent which flag forces a blocked step — the dialog asks the user
/// instead.
fn with_force_hints(mut report: CleanupReport) -> CleanupReport {
    for step in [StepName::Worktree, StepName::Branch] {
        let Some(outcome) = report.slot(step).as_mut() else {
            continue;
        };
        if outcome.status != StepStatus::Blocked {
            continue;
        }
        let hint = match outcome.reason.as_deref() {
            Some("dirty_worktree") => "Retry with force_remove_worktree=true to discard those changes, after checking they are not needed",
            Some("unmerged_branch") => "Retry with force_remove_branch=true to delete it anyway, after checking its commits are not needed",
            _ => continue,
        };
        let message = outcome.message.take().unwrap_or_default();
        outcome.message = Some(format!("{message}. {hint}"));
    }
    report
}

async fn audit(
    state: &AppState,
    source: &SessionScope,
    target: Option<&SessionScope>,
    result: &Result<ArchiveSessionResponse, AppError>,
    started_at: std::time::Instant,
) -> Result<(), AppError> {
    let (status, error, size) = audit_outcome(result);
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: "cadencr-project",
            tool_name: TOOL_NAME,
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: target.map(|target| target.session_id),
            target_feature_id: target.map(|target| target.feature_id),
            target_project_id: target.map(|target| target.project_id),
            status,
            result_size_bytes: size,
            latency_ms: elapsed_ms(started_at),
            error: error.as_deref(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};
    use sqlx::SqlitePool;

    use crate::app_state::AppState;
    use crate::domain::mcp::control::schedule_scope::test_support::{post, session};
    use crate::domain::schedules::repository::test_support::fixture;

    const PATH: &str = "/internal/mcp/project/archive-session";

    async fn conversation(pool: &SqlitePool, project_id: i64, title: &str) -> i64 {
        sqlx::query_scalar("INSERT INTO features (project_id, title) VALUES (?, ?) RETURNING id")
            .bind(project_id)
            .bind(title)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn idle_session(pool: &SqlitePool, feature_id: i64) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) \
             VALUES (?, 'session', 'paused') RETURNING id",
        )
        .bind(feature_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn status(pool: &SqlitePool, feature_id: i64) -> String {
        sqlx::query_scalar("SELECT status FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn link(pool: &SqlitePool, source: i64, target: i64) {
        sqlx::query(
            "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type) \
             VALUES (?, ?, 'spawned')",
        )
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .unwrap();
    }

    /// A caller conversation with a running session, plus an idle child.
    async fn caller_and_child() -> (SqlitePool, i64, i64, i64, i64, i64) {
        let (pool, project_id, caller_feature) = fixture().await;
        let caller_session = session(&pool, caller_feature).await;
        let child_feature = conversation(&pool, project_id, "Child").await;
        let child_session = idle_session(&pool, child_feature).await;
        (
            pool,
            project_id,
            caller_feature,
            caller_session,
            child_feature,
            child_session,
        )
    }

    fn request(caller_feature: i64, caller_session: i64, target: i64, extra: Value) -> Value {
        let mut body = json!({
            "source_feature_id": caller_feature,
            "source_session_id": caller_session,
            "session_id": target,
        });
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    }

    #[tokio::test]
    async fn archives_the_target_and_reports_each_requested_cleanup_step() {
        let (pool, _, caller_feature, caller_session, child_feature, child_session) =
            caller_and_child().await;
        let state = AppState::with_pool(pool.clone());
        let mut events = state.feature_events_tx.subscribe();
        let mut notices = state.feature_events_tx.subscribe_agent_archived();

        let (code, body) = post(
            state,
            PATH,
            request(
                caller_feature,
                caller_session,
                child_session,
                json!({ "kill_terminals": true, "close_browser_tabs": true, "remove_branch": true }),
            ),
        )
        .await;

        assert_eq!(code, StatusCode::OK, "{body}");
        assert_eq!(body["archived_feature_ids"], json!([child_feature]));
        assert_eq!(body["cleanup"]["terminals"]["status"], "done");
        // No desktop app here: the tabs close once one connects.
        assert_eq!(body["cleanup"]["browser_tabs"]["status"], "pending");
        assert_eq!(
            body["cleanup"]["browser_tabs"]["reason"],
            "waiting for the desktop app"
        );
        assert_eq!(body["cleanup"]["branch"]["status"], "skipped");
        assert!(body["cleanup"].get("worktree").is_none());
        assert_eq!(status(&pool, child_feature).await, "archived");
        assert_eq!(status(&pool, caller_feature).await, "active");
        let journaled: Vec<(String, String)> = sqlx::query_as(
            "SELECT step, status FROM feature_archive_cleanup_steps \
             WHERE feature_id = ? ORDER BY position",
        )
        .bind(child_feature)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            journaled,
            [
                ("terminals".to_string(), "done".to_string()),
                ("browser_tabs".to_string(), "pending".to_string()),
                ("worktree".to_string(), "skipped".to_string()),
                ("branch".to_string(), "skipped".to_string()),
            ]
        );
        assert_eq!(events.try_recv().unwrap().feature_id, child_feature);
        let notice = notices.try_recv().unwrap();
        assert_eq!(notice.feature_id, child_feature);
        assert_eq!(notice.title, "Child");
        assert_eq!(notice.archived_by, "Conversation");
        assert_eq!(
            serde_json::to_value(&notice.cleanup).unwrap(),
            body["cleanup"]
        );
    }

    #[test]
    fn a_blocked_step_names_the_flag_that_forces_it() {
        use crate::domain::features::archive_cleanup::{CleanupReport, StepOutcome};
        let report = super::with_force_hints(CleanupReport {
            worktree: Some(StepOutcome::blocked(
                "dirty_worktree".into(),
                "Worktree has uncommitted or untracked changes".into(),
            )),
            branch: Some(StepOutcome::failed("boom")),
            ..Default::default()
        });
        let message = report.worktree.unwrap().message.unwrap();
        assert!(message.starts_with("Worktree has uncommitted or untracked changes. "));
        assert!(message.contains("force_remove_worktree=true"));
        assert_eq!(report.branch.unwrap().message.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn refuses_the_calling_conversation_and_other_projects() {
        let (pool, _, caller_feature, caller_session, _, _) = caller_and_child().await;
        let state = AppState::with_pool(pool.clone());
        let own = request(caller_feature, caller_session, caller_session, json!({}));
        let (code, body) = post(state.clone(), PATH, own).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");

        let other_project: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('O', '/tmp/o') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let foreign_feature = conversation(&pool, other_project, "Foreign").await;
        let foreign_session = idle_session(&pool, foreign_feature).await;
        let foreign = request(caller_feature, caller_session, foreign_session, json!({}));
        let (code, body) = post(state, PATH, foreign).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(status(&pool, caller_feature).await, "active");
        assert_eq!(status(&pool, foreign_feature).await, "active");
        let audited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mcp_tool_audit_log \
             WHERE tool_name = 'project_archive_session' AND status = 'error'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audited, 2);
    }

    #[tokio::test]
    async fn refuses_a_busy_conversation_or_one_whose_parent_is_the_caller() {
        let (pool, project_id, caller_feature, caller_session, child_feature, child_session) =
            caller_and_child().await;
        let state = AppState::with_pool(pool.clone());
        link(&pool, caller_session, child_session).await;
        let with_parent = request(
            caller_feature,
            caller_session,
            child_session,
            json!({ "include_parent": true }),
        );
        let (code, body) = post(state.clone(), PATH, with_parent).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");

        let busy_feature = conversation(&pool, project_id, "Busy").await;
        let busy_session = session(&pool, busy_feature).await;
        let busy = request(caller_feature, caller_session, busy_session, json!({}));
        let (code, body) = post(state, PATH, busy).await;
        assert_eq!(code, StatusCode::CONFLICT, "{body}");
        assert_eq!(status(&pool, child_feature).await, "active");
        assert_eq!(status(&pool, busy_feature).await, "active");
    }

    #[tokio::test]
    async fn closes_the_target_tabs_through_the_desktop_bridge() {
        use axum::{routing::post as route_post, Router};
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let captured: Arc<Mutex<Option<Value>>> = Arc::default();
        let sink = captured.clone();
        let app = Router::new().route(
            "/browser-bridge",
            route_post(move |axum::Json(body): axum::Json<Value>| {
                let sink = sink.clone();
                async move {
                    *sink.lock().await = Some(body);
                    axum::Json(json!({ "text": "{\"closed_tabs\":2}" }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/browser-bridge", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (pool, _, caller_feature, caller_session, child_feature, child_session) =
            caller_and_child().await;
        let state = AppState::with_pool(pool);
        state
            .set_browser_bridge(crate::app_state::BrowserBridgeConfig::from_raw(&url, "t").unwrap())
            .unwrap();
        let body = request(
            caller_feature,
            caller_session,
            child_session,
            json!({ "close_browser_tabs": true }),
        );
        let (code, body) = post(state, PATH, body).await;

        assert_eq!(code, StatusCode::OK, "{body}");
        assert_eq!(body["cleanup"]["browser_tabs"]["detail"], "closed 2 tab(s)");
        let sent = captured.lock().await.take().unwrap();
        assert_eq!(sent["tool_name"], "browser_close_scope_tabs");
        assert_eq!(sent["feature_id"], child_feature);
    }
}
