//! Applies a schedule's runtime pins to the conversation it posts into.
//!
//! A schedule that targets an existing conversation can't change its agent, but
//! it can say "run this one in plan mode, on the cheap model, read-only". The
//! session row is what the spawn path reads to build its runtime config, so
//! pinning means writing those columns before the prompt goes out — the same
//! write picking a model in the composer performs, and just as persistent: the
//! conversation stays on the pinned values until something changes them again.
//!
//! The one case a pin can't reach is a session whose turn is already in flight
//! for a connected client. That prompt is appended to the live query, which was
//! spawned with the old config; the pin applies from the next spawn.

use crate::app_state::AppState;
use crate::domain::agents::providers::{default_provider_id, resolve_effective_provider};
use crate::domain::agents::runtime::runtime_setting_key;
use crate::domain::agents::runtime_overrides::{self, RestoreOptions};
use crate::domain::schedules::models::Schedule;
use crate::domain::schedules::pins::{access_mode_for, model_for, permission_mode_for, trimmed};
use crate::domain::settings;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::error::AppError;

/// Every pin resolved against the provider the conversation already runs.
#[derive(Debug, Default, PartialEq, Eq)]
struct SessionPins {
    model: Option<String>,
    thinking_effort: Option<String>,
    permission_mode: Option<String>,
    access_mode: Option<String>,
    profile: Option<String>,
}

impl SessionPins {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

pub(super) async fn apply(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    schedule: &Schedule,
) -> Result<(), AppError> {
    let pins = resolve(state, feature_id, session_id, schedule).await?;
    if pins.is_empty() {
        return Ok(());
    }
    validate_profile_state_transition(state, session_id, &pins).await?;
    let runtime_overrides = merge_runtime_overrides(state, session_id, &pins).await?;
    // COALESCE, not a blind write: an unpinned option must leave the
    // conversation exactly as the user left it.
    sqlx::query(
        "UPDATE agent_sessions SET
            model = COALESCE(?, model),
            thinking_effort = COALESCE(?, thinking_effort),
            permission_mode = COALESCE(?, permission_mode),
            codex_permission_mode = COALESCE(?, codex_permission_mode),
            profile = COALESCE(?, profile),
            runtime_overrides = COALESCE(?, runtime_overrides)
         WHERE id = ?",
    )
    .bind(pins.model.as_deref())
    .bind(pins.thinking_effort.as_deref())
    .bind(pins.permission_mode.as_deref())
    .bind(pins.access_mode.as_deref())
    .bind(pins.profile.as_deref())
    .bind(runtime_overrides)
    .bind(session_id)
    .execute(&state.write_pool)
    .await?;
    Ok(())
}

async fn validate_profile_state_transition(
    state: &AppState,
    session_id: i64,
    pins: &SessionPins,
) -> Result<(), AppError> {
    let Some(next_profile) = pins.profile.as_deref() else {
        return Ok(());
    };
    let row: (Option<String>, Option<String>, Option<String>, String) = sqlx::query_as(
        "SELECT s.runtime_provider, s.profile, s.runtime_session_id, p.path
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         JOIN projects p ON p.id = f.project_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_one(&state.read_pool)
    .await?;
    if row.2.is_none() {
        return Ok(());
    }
    let provider = row
        .0
        .ok_or_else(|| AppError::BadRequest("profile pin requires a resolved provider".into()))?;
    let adapter = crate::domain::agents::providers::runtime_adapter(&provider)
        .ok_or_else(|| AppError::BadRequest(format!("provider '{provider}' is unavailable")))?;
    let cwd = std::path::Path::new(&row.3);
    let previous_selection = match row.1 {
        Some(profile) => Some(profile),
        None => adapter
            .profile_catalog(Some(cwd))
            .await
            .map_err(|error| AppError::BadRequest(error.to_string()))?
            .map(|catalog| catalog.default_profile),
    };
    let previous = adapter
        .resolve_profile(previous_selection.as_deref(), cwd)
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let next = adapter
        .resolve_profile(Some(next_profile), cwd)
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let previous_state = previous.and_then(|profile| profile.state_identity);
    let next_state = next.and_then(|profile| profile.state_identity);
    if previous_state.is_some() && previous_state != next_state {
        return Err(AppError::BadRequest(
            "scheduled profile cannot change provider state for a resumable session".into(),
        ));
    }
    Ok(())
}

async fn merge_runtime_overrides(
    state: &AppState,
    session_id: i64,
    pins: &SessionPins,
) -> Result<Option<String>, AppError> {
    if pins.model.is_none() && pins.thinking_effort.is_none() {
        return Ok(None);
    }
    let stored = WsSessionPersistence::try_get_session_row(&state.read_pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{session_id}' not found")))?;
    let mut overrides = runtime_overrides::restore(
        RestoreOptions::builder()
            .provider(stored.runtime_provider.as_deref().unwrap_or_default())
            .maybe_runtime_session_id(stored.runtime_session_id.as_deref())
            .maybe_stored_json(stored.runtime_overrides.as_deref())
            .maybe_model(stored.model.as_deref())
            .maybe_thinking_effort(stored.thinking_effort.as_deref())
            .fast_mode(stored.fast_mode)
            .build(),
    )
    .map_err(AppError::Internal)?;
    if let Some(model) = &pins.model {
        overrides.model = Some(model.clone());
    }
    if let Some(effort) = &pins.thinking_effort {
        overrides.thinking_effort = Some(effort.clone());
    }
    serde_json::to_string(&overrides)
        .map(Some)
        .map_err(|error| AppError::Internal(format!("serialize runtime overrides: {error}")))
}

async fn resolve(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    schedule: &Schedule,
) -> Result<SessionPins, AppError> {
    let target = &schedule.target;
    let profile = trimmed(target.profile.as_deref());
    let mut pins = SessionPins {
        model: trimmed(target.model.as_deref()),
        thinking_effort: trimmed(target.thinking_level.as_deref()),
        profile: profile.clone(),
        ..Default::default()
    };
    // `pins` already carries the profile, so the mode pins are all that is left
    // to look for before concluding there is nothing to write.
    if pins.is_empty()
        && trimmed(target.permission_mode.as_deref()).is_none()
        && trimmed(target.access_mode.as_deref()).is_none()
    {
        return Ok(pins);
    }
    // Which agent this conversation runs decides what its pins may say — a
    // typo'd mode or model fails the run with a readable error instead of
    // leaving the session configured for a CLI that will reject it.
    let project = project_of(state, feature_id).await?;
    let Some(provider) = conversation_provider(
        state,
        feature_id,
        session_id,
        project.as_ref(),
        pins.model.as_deref(),
    )
    .await
    else {
        // Nothing to validate against and nothing to infer one from. Store the
        // pins as written rather than dropping them silently; the spawn path
        // rejects what it can't run.
        pins.permission_mode = trimmed(target.permission_mode.as_deref());
        pins.access_mode = trimmed(target.access_mode.as_deref());
        return Ok(pins);
    };
    if profile.is_some() {
        let cwd = project
            .as_ref()
            .map(|project| std::path::Path::new(&project.path))
            .ok_or_else(|| {
                AppError::BadRequest("scheduled profile requires a project path".into())
            })?;
        let adapter = crate::domain::agents::providers::runtime_adapter(&provider)
            .ok_or_else(|| AppError::BadRequest(format!("provider '{provider}' is unavailable")))?;
        pins.profile = adapter
            .resolve_profile(profile.as_deref(), cwd)
            .await
            .map_err(|error| AppError::BadRequest(error.to_string()))?
            .map(|resolved| resolved.identity);
    }
    pins.model = model_for(
        &state.read_pool,
        project.as_ref().map(|project| project.path.as_str()),
        &provider,
        pins.model.as_deref(),
        pins.profile.as_deref(),
    )
    .await?;
    pins.permission_mode = permission_mode_for(&provider, target.permission_mode.as_deref())?;
    pins.access_mode = access_mode_for(&provider, target.access_mode.as_deref())?;
    Ok(pins)
}

/// The agent the run will use.
///
/// Scheduling exists partly so the *first* message of a conversation can be
/// scheduled, and such a conversation has no agent on its session row yet. It
/// gets one at spawn from the same settings cascade resolved here — so
/// resolving it now is what lets a mode pin survive on a conversation that has
/// never run, instead of being dropped for want of something to validate it
/// against.
async fn conversation_provider(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    project: Option<&Project>,
    model: Option<&str>,
) -> Option<String> {
    if let Ok(Some(provider)) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT runtime_provider FROM agent_sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(&state.read_pool)
    .await
    .map(Option::flatten)
    {
        return Some(provider);
    }
    let project = project?;
    let configured = settings::resolve_setting(
        &state.read_pool,
        &runtime_setting_key("session"),
        Some(feature_id),
        Some(project.id),
        Some(default_provider_id()),
    )
    .await
    .unwrap_or_else(|| default_provider_id().to_string());
    Some(
        resolve_effective_provider(
            &state.read_pool,
            Some(std::path::Path::new(&project.path)),
            configured,
            model,
        )
        .await,
    )
}

struct Project {
    id: i64,
    path: String,
}

async fn project_of(state: &AppState, feature_id: i64) -> Result<Option<Project>, AppError> {
    Ok(sqlx::query_as::<_, (i64, String)>(
        "SELECT p.id, p.path FROM features f JOIN projects p ON p.id = f.project_id WHERE f.id = ?",
    )
    .bind(feature_id)
    .fetch_optional(&state.read_pool)
    .await?
    .map(|(id, path)| Project { id, path }))
}

#[cfg(test)]
mod tests {
    use super::super::resolve_or_create_session;
    use super::*;
    use crate::domain::schedules::repository::insert;
    use crate::domain::schedules::repository::test_support::{fixture, once_into_conversation};

    /// Pins are only meaningful once the conversation has an agent, so every
    /// test here pins the provider on the session row first.
    async fn session_on(provider: &str) -> (sqlx::SqlitePool, AppState, i64, i64) {
        let (pool, _, feature_id) = fixture().await;
        let state = AppState::with_pool(pool.clone());
        let session_id = resolve_or_create_session(&state, feature_id).await.unwrap();
        sqlx::query("UPDATE agent_sessions SET runtime_provider = ? WHERE id = ?")
            .bind(provider)
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();
        (pool, state, feature_id, session_id)
    }

    async fn legacy_codex_session() -> (AppState, i64) {
        let (pool, state, _, session_id) = session_on("codex_cli").await;
        sqlx::query(
            "UPDATE agent_sessions SET runtime_session_id = 'legacy-thread',
             model = 'gpt-5.4', thinking_effort = 'high', fast_mode = 1,
             runtime_overrides = NULL WHERE id = ?",
        )
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
        (state, session_id)
    }

    #[tokio::test]
    async fn model_pin_preserves_unpinned_legacy_effort_and_fast_mode() {
        let (state, session_id) = legacy_codex_session().await;
        let pins = SessionPins {
            model: Some("new-model".into()),
            ..Default::default()
        };
        let json = merge_runtime_overrides(&state, session_id, &pins)
            .await
            .unwrap()
            .unwrap();
        let overrides: crate::domain::agents::adapter::RuntimeConfigOverrides =
            serde_json::from_str(&json).unwrap();
        assert_eq!(overrides.model.as_deref(), Some("new-model"));
        assert_eq!(overrides.thinking_effort.as_deref(), Some("high"));
        assert_eq!(overrides.fast_mode, Some(true));
    }

    #[tokio::test]
    async fn effort_pin_preserves_unpinned_legacy_model_and_fast_mode() {
        let (state, session_id) = legacy_codex_session().await;
        let pins = SessionPins {
            thinking_effort: Some("low".into()),
            ..Default::default()
        };
        let json = merge_runtime_overrides(&state, session_id, &pins)
            .await
            .unwrap()
            .unwrap();
        let overrides: crate::domain::agents::adapter::RuntimeConfigOverrides =
            serde_json::from_str(&json).unwrap();
        assert_eq!(overrides.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(overrides.thinking_effort.as_deref(), Some("low"));
        assert_eq!(overrides.fast_mode, Some(true));
    }

    /// A runtime override switch (Codex model/effort picker) mirrors the
    /// effective effort into the column, so a schedule posting into the
    /// conversation sees the level the user picked, not the first init's.
    #[tokio::test]
    async fn schedule_sees_the_effort_of_the_last_runtime_override_switch() {
        let (state, session_id) = legacy_codex_session().await;
        let switched = crate::domain::agents::adapter::RuntimeConfigOverrides {
            model: Some("gpt-5.6-luna".into()),
            thinking_effort: Some("max".into()),
            ..Default::default()
        };
        WsSessionPersistence::update_runtime_config_static()
            .pool(&state.write_pool)
            .session_id(session_id)
            .overrides(&switched)
            .model("gpt-5.6-luna")
            .thinking_effort("max")
            .call()
            .await
            .unwrap();
        let pins = SessionPins {
            model: Some("new-model".into()),
            ..Default::default()
        };
        let json = merge_runtime_overrides(&state, session_id, &pins)
            .await
            .unwrap()
            .unwrap();
        let overrides: crate::domain::agents::adapter::RuntimeConfigOverrides =
            serde_json::from_str(&json).unwrap();
        assert_eq!(overrides.thinking_effort.as_deref(), Some("max"));
        let stored = WsSessionPersistence::try_get_session_row(&state.read_pool, session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.thinking_effort.as_deref(), Some("max"));
    }

    #[tokio::test]
    async fn malformed_override_provenance_rejects_schedule_pin() {
        let (state, session_id) = legacy_codex_session().await;
        sqlx::query("UPDATE agent_sessions SET runtime_overrides = '{' WHERE id = ?")
            .bind(session_id)
            .execute(&state.write_pool)
            .await
            .unwrap();
        let pins = SessionPins {
            model: Some("new-model".into()),
            ..Default::default()
        };
        let error = merge_runtime_overrides(&state, session_id, &pins)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("invalid persisted runtime overrides"));
        let stored = WsSessionPersistence::try_get_session_row(&state.read_pool, session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(stored.runtime_overrides.as_deref(), Some("{"));
    }

    #[tokio::test]
    async fn every_pin_lands_on_the_conversations_session() {
        let (pool, state, feature_id, session_id) = session_on("claude_code").await;
        let mut schedule = insert(
            &pool,
            once_into_conversation(feature_id, "2030-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        schedule.target.model = Some("haiku".into());
        schedule.target.thinking_level = Some("medium".into());
        schedule.target.permission_mode = Some("plan".into());
        schedule.target.profile = Some("default".into());

        apply(&state, feature_id, session_id, &schedule)
            .await
            .unwrap();

        let stored: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        ) = sqlx::query_as(
            "SELECT model, thinking_effort, permission_mode, profile, runtime_overrides
                 FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored.0.as_deref(), Some("haiku"));
        assert_eq!(stored.1.as_deref(), Some("medium"));
        assert_eq!(stored.2.as_deref(), Some("plan"));
        assert_eq!(stored.3.as_deref(), Some("default"));
        let overrides: crate::domain::agents::adapter::RuntimeConfigOverrides =
            serde_json::from_str(&stored.4).unwrap();
        assert_eq!(overrides.model.as_deref(), Some("haiku"));
        assert_eq!(overrides.thinking_effort.as_deref(), Some("medium"));
    }

    /// An unpinned schedule must leave the conversation exactly as the user left
    /// it — the COALESCE, not a blind overwrite with NULL.
    #[tokio::test]
    async fn an_unpinned_schedule_leaves_the_session_alone() {
        let (pool, state, feature_id, session_id) = session_on("claude_code").await;
        sqlx::query(
            "UPDATE agent_sessions SET model = 'opus', permission_mode = 'plan' WHERE id = ?",
        )
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();
        let schedule = insert(
            &pool,
            once_into_conversation(feature_id, "2030-01-01T09:00:00Z"),
        )
        .await
        .unwrap();

        apply(&state, feature_id, session_id, &schedule)
            .await
            .unwrap();

        let stored: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT model, permission_mode FROM agent_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, (Some("opus".into()), Some("plan".into())));
    }

    /// Regression: a conversation that has never spawned has no agent on its
    /// session row, and the pins used to be dropped wholesale for want of
    /// something to validate them against — so a schedule pinned to Plan ran the
    /// very first message of that conversation in the column default,
    /// `bypassPermissions`. Scheduling the first message is a supported case, so
    /// the provider is resolved the way the spawn path will resolve it.
    #[tokio::test]
    async fn a_conversation_that_has_never_run_still_gets_its_mode_pinned() {
        let (pool, _, feature_id) = fixture().await;
        let state = AppState::with_pool(pool.clone());
        let session_id = resolve_or_create_session(&state, feature_id).await.unwrap();
        let mut schedule = insert(
            &pool,
            once_into_conversation(feature_id, "2030-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        schedule.target.permission_mode = Some("plan".into());

        apply(&state, feature_id, session_id, &schedule)
            .await
            .unwrap();

        let stored: Option<String> =
            sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored.as_deref(), Some("plan"));
    }

    /// The point of validating against the conversation's own provider: a mode
    /// its CLI can't run has to fail the run, not be written and then silently
    /// downgraded at spawn.
    #[tokio::test]
    async fn a_mode_the_conversations_agent_cannot_run_fails_the_dispatch() {
        let (pool, state, feature_id, session_id) = session_on("claude_code").await;
        let mut schedule = insert(
            &pool,
            once_into_conversation(feature_id, "2030-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        schedule.target.permission_mode = Some("opencodeAgent:documentor".into());

        let error = apply(&state, feature_id, session_id, &schedule)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    /// Claude has no access axis, so an access-mode pin left over from a Codex
    /// conversation is inert rather than fatal — and must not overwrite the
    /// session's stored value with something the provider never uses.
    #[tokio::test]
    async fn an_access_pin_the_agent_ignores_does_not_touch_the_session() {
        let (pool, state, feature_id, session_id) = session_on("claude_code").await;
        let mut schedule = insert(
            &pool,
            once_into_conversation(feature_id, "2030-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        schedule.target.access_mode = Some("fullAccess".into());

        apply(&state, feature_id, session_id, &schedule)
            .await
            .unwrap();

        let stored: String =
            sqlx::query_scalar("SELECT codex_permission_mode FROM agent_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, "default");
    }
}
