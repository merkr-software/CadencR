//! "Ask on the side": a question about a conversation that must not land in
//! its thread nor interrupt its agent.
//!
//! The question goes to a new, linked conversation in the same working
//! directory, in Plan (read-only) mode, seeded with an excerpt of the source
//! conversation — through the same spawn pipeline as `project_spawn_session`,
//! so provider, model and profile follow the source session.
//!
//! The side conversation is born archived: it is temporary, read inline under
//! the source conversation, and joins the sidebar only when the user keeps it
//! as a thread (un-archiving it).

use axum::extract::{Json, Path, State};
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};

use super::scope::{resolve_session_scope, SessionScope};
use super::spawn_follow::SpawnFollowOptions;
use super::spawn_resolve::SpawnBranch;
use super::spawn_session::{spawn_session_handler, SpawnSessionRequest};
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::features::models::FeatureStatus;
use crate::domain::features::service::update_status;
use crate::domain::git::repository::get_project_path;
use crate::domain::git::service::resolve_feature_branch;
use crate::domain::workflow::worktree::resolve_live_worktree;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::error::AppError;

mod excerpt;
use excerpt::{clip, conversation_excerpt};

const MAX_QUESTION_CHARS: usize = 8_000;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SideQuestionRequest {
    pub question: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct SideQuestionResponse {
    pub feature_id: i64,
    pub session_id: i64,
    pub project_id: i64,
}

/// Same files as the source: its live worktree, on the branch actually checked
/// out there, else the project folder it already works in.
async fn source_branch(
    pool: &sqlx::SqlitePool,
    source: &SessionScope,
) -> Result<SpawnBranch, AppError> {
    let project_path = get_project_path(pool, source.project_id).await?;
    let Some(worktree) = resolve_live_worktree(pool, source.feature_id, &project_path)
        .await
        .map_err(|error| AppError::internal(error))?
    else {
        return Ok(SpawnBranch::default());
    };
    Ok(
        resolve_feature_branch(pool, source.feature_id, std::path::Path::new(&worktree))
            .await?
            .map(SpawnBranch::reuse_worktree)
            .unwrap_or_default(),
    )
}

fn side_brief(excerpt: &str, question: &str) -> String {
    let context = if excerpt.is_empty() {
        "(The other conversation has no messages yet.)".to_string()
    } else {
        excerpt.to_string()
    };
    format!(
        "You are answering a side question about work another agent is doing in this same \
         working directory. Do not modify anything: read files and inspect state only, then \
         answer concisely.\n\nRecent messages of that conversation (oldest first):\n\n{context}\
         \n\n---\n\nSide question:\n{question}"
    )
}

/// The spawn request of a side conversation: read-only (Plan; Codex access
/// pinned to Default so it never inherits Full Access) on the source's
/// provider, model, effort and profile. It follows neither the source's gates
/// nor its completion: the source agent is never steered by it — a permission
/// the side agent asks for, or its answer, stays in the side conversation,
/// where the user reads it.
fn side_request(
    source: &SessionRow,
    question: &str,
    excerpt: &str,
    branch: SpawnBranch,
) -> SpawnSessionRequest {
    SpawnSessionRequest {
        source_feature_id: source.feature_id,
        source_session_id: source.id,
        title: Some(format!("Side: {}", clip(question, 48))),
        initial_message: Some(side_brief(excerpt, question)),
        branch: Some(branch),
        provider: source.runtime_provider.clone(),
        model: source.model.clone(),
        thinking_level: source.thinking_effort.clone(),
        profile: source.profile.clone(),
        permission_mode: Some("plan".to_string()),
        codex_permission_mode: Some("default".to_string()),
        source_note: Some("cadencr:side-question".to_string()),
        follow: Some(SpawnFollowOptions::detached()),
        link_to_current_session: None,
        await_result: None,
        target_project_id: None,
        target_project_path: None,
        start_archived: true,
    }
}

#[utoipa::path(post, path = "/api/sessions/{session_id}/side-question",
    params(("session_id" = i64, Path,)),
    request_body = SideQuestionRequest,
    responses((status = 200, body = SideQuestionResponse)))]
pub async fn ask_session_side_question(
    State(state): State<AppState>,
    Path(session_id): Path<i64>,
    Json(body): Json<SideQuestionRequest>,
) -> Result<Json<SideQuestionResponse>, AppError> {
    let question = body.question.trim();
    if question.is_empty() {
        return Err(AppError::BadRequest(
            "Write the side question first.".to_string(),
        ));
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(AppError::BadRequest(
            "This side question is too long.".to_string(),
        ));
    }
    let source = resolve_session_scope(&state.write_pool, session_id).await?;
    let row = WsSessionPersistence::try_get_session_row(&state.read_pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;
    let excerpt = conversation_excerpt(&state.read_pool, session_id).await?;
    let branch = source_branch(&state.read_pool, &source).await?;
    let Json(spawned) = spawn_session_handler(
        State(state.clone()),
        Json(side_request(&row, question, &excerpt, branch)),
    )
    .await?;
    // The conversation exists but the question never reached its agent:
    // saying "sent" would leave the user waiting on nothing. It leaves the
    // archive so the user can find it and retry there.
    if let Some(error) = spawned.dispatch_error {
        update_status(&state.write_pool, spawned.feature_id, FeatureStatus::Active).await?;
        state.feature_events_tx.emit(
            spawned.feature_id,
            Some(source.project_id),
            FeatureEventAction::Updated,
        );
        return Err(AppError::internal(format!(
            "The side conversation was created (listed in the sidebar) but the question \
             was not delivered: {error}"
        )));
    }
    Ok(Json(SideQuestionResponse {
        feature_id: spawned.feature_id,
        session_id: spawned.session_id,
        project_id: source.project_id,
    }))
}

pub fn side_question_router() -> Router<AppState> {
    Router::new().route(
        "/api/sessions/{session_id}/side-question",
        post(ask_session_side_question),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_carries_the_excerpt_and_the_question() {
        let brief = side_brief(
            "User: fix the bug\n\nAgent: on it",
            "Which file holds the bug?",
        );
        assert!(brief.contains("Do not modify anything"));
        assert!(brief.contains("Agent: on it"));
        assert!(brief.ends_with("Which file holds the bug?"));
        assert!(side_brief("", "q").contains("no messages yet"));
    }

    fn source_row() -> SessionRow {
        SessionRow {
            id: 7,
            feature_id: 1,
            runtime_provider: Some("claude_code".to_string()),
            runtime_session_id: None,
            model: Some("claude-opus-4-8".to_string()),
            profile: None,
            permission_mode: Some("acceptEdits".to_string()),
            codex_permission_mode: Some("full_access".to_string()),
            status: "completed".to_string(),
            pending_permission: None,
            pending_questions: None,
            input_tokens: None,
            output_tokens: None,
            context_window: None,
            thinking_effort: Some("high".to_string()),
            fast_mode: false,
            runtime_overrides: None,
        }
    }

    #[test]
    fn side_conversation_never_steers_the_source_agent() {
        let request = side_request(&source_row(), "q", "", SpawnBranch::default());
        assert!(!request.follows_gates());
        assert!(!request.follows_completion());
    }

    #[test]
    fn side_conversation_is_read_only_on_the_source_runtime() {
        let request = side_request(&source_row(), "q", "", SpawnBranch::default());
        assert_eq!(request.permission_mode.as_deref(), Some("plan"));
        // Never the source's Full Access.
        assert_eq!(request.codex_permission_mode.as_deref(), Some("default"));
        assert_eq!(request.provider.as_deref(), Some("claude_code"));
        assert_eq!(request.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(request.thinking_level.as_deref(), Some("high"));
        assert_eq!(request.source_session_id, 7);
    }

    #[test]
    fn side_conversation_is_temporary_until_kept() {
        let request = side_request(&source_row(), "q", "", SpawnBranch::default());
        assert!(request.start_archived);
    }
}
