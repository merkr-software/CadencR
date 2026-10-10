use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimeConfigOverrides, RuntimeEffectiveConfig, RuntimeSpawnConfig,
};
use crate::domain::agents::providers::runtime_adapter;
use crate::domain::agents::runtime_overrides::{self, RestoreOptions};
use crate::domain::settings;
use crate::domain::ws_session::handler::session_runtime_config;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};

pub(super) struct ResolvedProfileConfig {
    pub effective_profile: Option<String>,
    pub effective_model: Option<String>,
    pub effective_thinking_effort: Option<String>,
    pub profile_effective_fast_mode: Option<bool>,
    pub inherits_profile_config: bool,
}

#[derive(bon::Builder)]
pub(super) struct ResolveOptions<'a> {
    app_state: &'a AppState,
    project_id: i64,
    feature_id: i64,
    db_session_id: i64,
    provider: &'a str,
    row: Option<&'a SessionRow>,
    stored_model: Option<&'a str>,
    stored_effort: Option<&'a str>,
    stored_fast_mode: bool,
    effective_model: Option<String>,
    effective_effort: Option<String>,
    runtime_config: &'a mut RuntimeSpawnConfig,
}

pub(super) async fn resolve(
    options: ResolveOptions<'_>,
) -> Result<ResolvedProfileConfig, (&'static str, String)> {
    let ResolveOptions {
        app_state,
        project_id,
        feature_id,
        db_session_id,
        provider,
        row,
        stored_model,
        stored_effort,
        stored_fast_mode,
        mut effective_model,
        mut effective_effort,
        runtime_config,
    } = options;
    runtime_config.overrides = runtime_overrides::restore(
        RestoreOptions::builder()
            .provider(provider)
            .maybe_runtime_session_id(row.and_then(|session| session.runtime_session_id.as_deref()))
            .maybe_stored_json(row.and_then(|session| session.runtime_overrides.as_deref()))
            .maybe_model(stored_model)
            .maybe_thinking_effort(stored_effort)
            .fast_mode(stored_fast_mode)
            .build(),
    )
    .map_err(|error| ("INVALID_RUNTIME_OVERRIDES", error))?;
    let inherits = runtime_adapter(provider)
        .is_some_and(|adapter| adapter.supports_profile_config_inheritance());
    if row.is_some_and(|session| session.runtime_overrides.is_none()) && inherits {
        WsSessionPersistence::update_runtime_overrides_static(
            &app_state.write_pool,
            db_session_id,
            &runtime_config.overrides,
        )
        .await
        .map_err(|error| ("DB_ERROR", error.to_string()))?;
    }
    let selected_profile = session_runtime_config::persisted_profile_selection(
        provider,
        row.and_then(|session| session.profile.as_deref()),
        row.and_then(|session| session.runtime_session_id.as_deref()),
        &runtime_config.cwd,
    )
    .await
    .map_err(|error| ("PROFILE_ERROR", error))?;
    let profile = session_runtime_config::apply_provider_settings(
        app_state,
        project_id,
        feature_id,
        db_session_id,
        provider,
        selected_profile.as_deref(),
        runtime_config,
    )
    .await
    .map_err(|error| ("PROFILE_ERROR", error))?;
    let mut effective_fast_mode = None;
    if let Some(adapter) =
        runtime_adapter(provider).filter(|adapter| adapter.supports_profile_config_inheritance())
    {
        let mut effective = adapter
            .resolve_profile_effective_config(
                profile.as_deref(),
                &runtime_config.cwd,
                &runtime_config.overrides,
            )
            .await
            .map_err(|error| ("PROFILE_CONFIG_ERROR", error.to_string()))?;
        pin_last_used_effort(
            app_state,
            db_session_id,
            provider,
            row,
            &mut runtime_config.overrides,
            &mut effective,
        )
        .await?;
        effective_model = effective.model;
        effective_effort = effective.thinking_effort;
        runtime_config.model = effective_model.clone();
        runtime_config.thinking_effort = effective_effort.clone();
        runtime_config.fast_mode = effective.fast_mode;
        effective_fast_mode = Some(effective.fast_mode);
    }
    Ok(ResolvedProfileConfig {
        effective_profile: profile,
        effective_model,
        effective_thinking_effort: effective_effort,
        profile_effective_fast_mode: effective_fast_mode,
        inherits_profile_config: inherits,
    })
}

/// A brand-new session of a profile-inheriting provider (no override document
/// and no runtime thread yet) starts at the user's last level for its effective
/// model, as a spawn or a model switch would; without one, the profile's own
/// level applies. The level is pinned as an explicit override so the session
/// keeps it when it is reopened.
async fn pin_last_used_effort(
    app_state: &AppState,
    db_session_id: i64,
    provider: &str,
    row: Option<&SessionRow>,
    overrides: &mut RuntimeConfigOverrides,
    effective: &mut RuntimeEffectiveConfig,
) -> Result<(), (&'static str, String)> {
    let fresh = row.is_some_and(|session| {
        session.runtime_overrides.is_none() && session.runtime_session_id.is_none()
    });
    if !fresh || overrides.thinking_effort.is_some() {
        return Ok(());
    }
    let Some(model) = effective.model.as_deref() else {
        return Ok(());
    };
    let Some(level) =
        settings::thinking_effort_model_default(&app_state.read_pool, provider, model).await
    else {
        return Ok(());
    };
    overrides.thinking_effort = Some(level.clone());
    WsSessionPersistence::update_runtime_overrides_static(
        &app_state.write_pool,
        db_session_id,
        overrides,
    )
    .await
    .map_err(|error| ("DB_ERROR", error.to_string()))?;
    effective.thinking_effort = Some(level);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::{init_session, make_test_app_state};
    use crate::domain::ws_session::handler::types::SdkSessions;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex};

    #[tokio::test]
    async fn fresh_profile_session_pins_the_last_used_level_of_its_model() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let app_state = make_test_app_state().await;
        let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
        let db_id: i64 = session_id.parse().unwrap();
        crate::domain::settings_store::global_set(
            &crate::domain::settings::thinking_effort_model_key("codex_cli", "pin-test-model"),
            "high",
        )
        .await
        .unwrap();
        let effective_for = || RuntimeEffectiveConfig {
            model: Some("pin-test-model".to_string()),
            ..Default::default()
        };

        // A session without provenance resumes the model's last-used level.
        let fresh_row = WsSessionPersistence::get_session_row(&app_state.read_pool, db_id).await;
        let mut overrides = RuntimeConfigOverrides::default();
        let mut effective = effective_for();
        pin_last_used_effort(
            &app_state,
            db_id,
            "codex_cli",
            fresh_row.as_ref(),
            &mut overrides,
            &mut effective,
        )
        .await
        .unwrap();
        assert_eq!(overrides.thinking_effort.as_deref(), Some("high"));
        assert_eq!(effective.thinking_effort.as_deref(), Some("high"));
        let persisted: Option<String> =
            sqlx::query_scalar("SELECT runtime_overrides FROM agent_sessions WHERE id = ?")
                .bind(db_id)
                .fetch_one(&app_state.read_pool)
                .await
                .unwrap();
        assert!(persisted.unwrap().contains("\"high\""));

        // Once it has an override document, its own provenance wins.
        let known_row = WsSessionPersistence::get_session_row(&app_state.read_pool, db_id).await;
        let mut overrides = RuntimeConfigOverrides::default();
        let mut effective = effective_for();
        pin_last_used_effort(
            &app_state,
            db_id,
            "codex_cli",
            known_row.as_ref(),
            &mut overrides,
            &mut effective,
        )
        .await
        .unwrap();
        assert_eq!(overrides.thinking_effort, None);
        assert_eq!(effective.thinking_effort, None);
    }
}
