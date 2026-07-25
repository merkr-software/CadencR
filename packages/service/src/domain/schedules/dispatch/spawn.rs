//! Creates the conversation a `new_conversation` schedule delivers into.
//!
//! One conversation per run, by design: a nightly review that appended to the
//! same thread forever would drown in its own history. The worktree is not
//! created here — the prompt path does that, exactly as it does for a
//! conversation started from the UI.

use chrono::Utc;

use super::message_uuid;
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::features::service::create_feature_with_worktree;
use crate::domain::schedules::models::Schedule;
use crate::domain::schedules::runtime::{self, ScheduleRuntime};
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt_with_message_uuid;
use crate::error::AppError;

pub(super) async fn run(
    state: &AppState,
    schedule: &Schedule,
    occurrence: &str,
) -> Result<i64, AppError> {
    let project_id = schedule.target.project_id.ok_or_else(|| {
        AppError::Internal(format!(
            "schedule {} creates conversations but has no project_id",
            schedule.id
        ))
    })?;
    let project_path = project_path(state, project_id).await?;
    let runtime = runtime::resolve(state, project_id, &project_path, &schedule.target).await?;

    // No title: the conversation is left on the `Session N` placeholder so the
    // ordinary auto-namer renames it from the prompt on first dispatch, exactly
    // as it does for a conversation started from the New button.
    let created = create_feature_with_worktree(
        &state.write_pool,
        project_id,
        None,
        Some("ws-session".to_string()),
        schedule.target.worktree_mode.clone(),
        schedule.target.reuse_branch.clone(),
        schedule.target.base_branch.clone(),
    )
    .await?;
    let session_id = insert_session(state, created.id, &runtime).await?;

    // Announce before dispatching so the conversation appears in every client's
    // sidebar as the agent starts working in it, not after the first token.
    state
        .feature_events_tx
        .emit(created.id, Some(project_id), FeatureEventAction::Created);

    dispatch_control_prompt_with_message_uuid(
        state,
        created.id,
        session_id,
        &schedule.prompt,
        false,
        Some(message_uuid(schedule.id, occurrence)),
    )
    .await?;
    Ok(created.id)
}

async fn insert_session(
    state: &AppState,
    feature_id: i64,
    runtime: &ScheduleRuntime,
) -> Result<i64, AppError> {
    let now = Utc::now().to_rfc3339();
    // `codex_permission_mode` is NOT NULL: every other provider stores the
    // literal 'default', so the COALESCE is required, not cosmetic.
    // `permission_mode` is nullable and the spawn path falls back to the
    // provider's own default for NULL, so an unpinned schedule leaves it unset.
    Ok(sqlx::query_scalar(
        "INSERT INTO agent_sessions
         (feature_id, agent_type, status, runtime_provider, model, profile, thinking_effort,
          permission_mode, codex_permission_mode, started_at)
         VALUES (?, 'session', 'paused', ?, ?, ?, ?, ?, COALESCE(?, 'default'), ?)
         RETURNING id",
    )
    .bind(feature_id)
    .bind(&runtime.provider)
    .bind(runtime.model.as_deref())
    .bind(runtime.profile.as_deref())
    .bind(runtime.thinking_level.as_deref())
    .bind(runtime.permission_mode.as_deref())
    .bind(runtime.codex_permission_mode.as_deref())
    .bind(now)
    .fetch_one(&state.write_pool)
    .await?)
}

async fn project_path(state: &AppState, project_id: i64) -> Result<String, AppError> {
    sqlx::query_scalar::<_, String>("SELECT path FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(&state.read_pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("project {project_id} not found")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::features::title::is_default_title;
    use crate::domain::schedules::repository::test_support::fixture;

    /// The conversation must land on a placeholder title, not a schedule-derived
    /// one — that is what lets the auto-namer rename it from the prompt.
    #[tokio::test]
    async fn a_created_conversation_starts_on_an_auto_nameable_title() {
        let (pool, project_id, _) = fixture().await;
        let created = create_feature_with_worktree(
            &pool,
            project_id,
            None,
            Some("ws-session".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let title: String = sqlx::query_scalar("SELECT title FROM features WHERE id = ?")
            .bind(created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(is_default_title(&title), "unexpected title {title}");
    }

    // Regression: `agent_sessions.codex_permission_mode` is NOT NULL, so a
    // non-Codex schedule (which resolves no access mode) has to fall back to
    // the literal 'default'. Without it every scheduled run failed at insert.
    #[tokio::test]
    async fn a_non_codex_session_stores_the_default_permission_mode() {
        let (pool, project_id, _) = fixture().await;
        let state = AppState::with_pool(pool.clone());
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'Scheduled') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        let session_id = insert_session(
            &state,
            feature_id,
            &ScheduleRuntime {
                provider: "claude_code".into(),
                model: Some("haiku".into()),
                thinking_level: None,
                profile: None,
                permission_mode: None,
                codex_permission_mode: None,
            },
        )
        .await
        .unwrap();

        let stored: (String, Option<String>, String) = sqlx::query_as(
            "SELECT runtime_provider, model, codex_permission_mode FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            stored,
            ("claude_code".into(), Some("haiku".into()), "default".into())
        );
    }
}
