use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeAccessMode;
use crate::domain::agents::{default_provider_id, runtime::runtime_setting_key};
use crate::domain::settings;
use crate::domain::ws_session::persistence::SessionRow;
use crate::error::AppError;

pub(super) async fn resolve(
    app_state: &AppState,
    feature_id: i64,
    requested_provider: Option<&str>,
) -> Result<(String, Option<RuntimeAccessMode>), AppError> {
    // A conversation keeps the provider it already ran with, so its setting is
    // only read (and can only fail init) when nothing pins one yet.
    let pinned = match requested_provider {
        Some(requested) => Some(requested.to_string()),
        None => recorded_provider(app_state, feature_id).await?,
    };
    let provider = match pinned {
        Some(provider) => provider,
        // Match resolve_selection: feature override -> workspace last-used
        // provider. Legacy project settings must not seed permissions for a
        // different provider.
        None => settings::resolve_setting(
            &app_state.read_pool,
            &runtime_setting_key("session"),
            Some(feature_id),
            None,
            Some(default_provider_id()),
        )
        .await?
        .unwrap_or_else(|| default_provider_id().to_string()),
    };
    let access_mode = crate::domain::ws_session::handler::access::configured_access_mode(
        &provider,
        &app_state.read_pool,
    )
    .await?;
    Ok((provider, access_mode))
}

/// The provider the feature's conversation already ran with, if any. Same row
/// `find_or_create_session_for_binding` reuses.
async fn recorded_provider(
    app_state: &AppState,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    let provider: Option<Option<String>> = sqlx::query_scalar(
        "SELECT runtime_provider FROM agent_sessions
         WHERE feature_id = ? AND agent_type = 'session' ORDER BY id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(&app_state.read_pool)
    .await?;
    Ok(provider.flatten())
}

/// The configured access mode for the provider the session finally runs: the
/// one already read for the initial provider, or a fresh read for another.
pub(super) async fn access_mode_for(
    app_state: &AppState,
    (initial_provider, initial_mode): (&str, Option<RuntimeAccessMode>),
    effective_provider: &str,
) -> Result<Option<RuntimeAccessMode>, AppError> {
    if effective_provider == initial_provider {
        return Ok(initial_mode);
    }
    crate::domain::ws_session::handler::access::configured_access_mode(
        effective_provider,
        &app_state.read_pool,
    )
    .await
}

pub(super) struct InitialSelection {
    pub provider: String,
    pub model: Option<String>,
    /// A saved or requested model takes precedence over a fresh session's native profile.
    pub pin_model: bool,
}

/// The provider and model this session runs with. A session that already
/// ran keeps the provider it ran with (and its last model); the resolver only
/// decides for sessions that have not pinned one yet. Errs when no model is
/// available or the selection settings cannot be read.
#[bon::builder]
pub(super) async fn effective_selection(
    app_state: &AppState,
    cwd: &str,
    feature_id: i64,
    row: Option<&SessionRow>,
    requested_provider: Option<String>,
    requested_model: Option<String>,
) -> Result<InitialSelection, crate::domain::agents::SelectionError> {
    let pinned_provider = row
        .and_then(|row| row.runtime_provider.clone())
        .or(requested_provider);
    if let Some(provider) = pinned_provider {
        return Ok(InitialSelection {
            provider,
            pin_model: requested_model.is_some()
                && row.is_none_or(|row| row.runtime_provider.is_none()),
            model: row.and_then(|row| row.model.clone()).or(requested_model),
        });
    }
    // `session.init` carries no profile: it lives on the persisted session
    // row, the same source the profile resolution reads later.
    crate::domain::agents::selection::resolve_configured_selection(
        &app_state.read_pool,
        Some(std::path::Path::new(cwd)),
        "session",
        Some(feature_id),
        row.and_then(|row| row.profile.as_deref()),
    )
    .await
    .map(|selection| InitialSelection {
        provider: selection.provider_id,
        model: Some(selection.model_id),
        pin_model: selection.model_origin
            != crate::domain::agents::SelectionOrigin::ProviderDefault,
    })
}

#[cfg(test)]
mod tests {
    use super::resolve;
    use crate::domain::agents::adapter::{access_mode_wire, RuntimeAccessMode};
    use crate::domain::settings_store;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;
    use crate::domain::ws_session::persistence::WsSessionPersistence;

    #[tokio::test]
    async fn last_used_codex_inherits_auto_review_despite_legacy_project_provider() {
        let state = make_test_app_state().await;
        settings_store::global_set("agent_runtime_session", "codex_cli")
            .await
            .unwrap();
        settings_store::global_set("codex_permission_mode", "autoReview")
            .await
            .unwrap();
        settings_store::project_set(&state.write_pool, 1, "agent_runtime_session", "claude_code")
            .await
            .unwrap();
        let (provider, access_mode) = resolve(&state, 1, None).await.unwrap();
        assert_eq!(provider, "codex_cli");
        assert_eq!(access_mode, Some(RuntimeAccessMode::AutoReview));
        let mut persistence = WsSessionPersistence::new(state.write_pool.clone(), 1);
        persistence
            .find_or_create_session_with_access_mode(
                None,
                None,
                access_mode.as_ref().map(access_mode_wire),
            )
            .await
            .expect("session created");
        let stored: String = sqlx::query_scalar(
            "SELECT codex_permission_mode FROM agent_sessions WHERE feature_id = 1",
        )
        .fetch_one(&state.read_pool)
        .await
        .unwrap();
        assert_eq!(stored, "autoReview");
    }

    /// A conversation-level provider that cannot be read fails session.init;
    /// a provider the client names needs no such read.
    #[tokio::test]
    async fn an_unreadable_provider_setting_fails_unless_the_client_names_one() {
        let state = make_test_app_state().await;
        sqlx::query("ALTER TABLE feature_settings RENAME TO feature_settings_unreadable")
            .execute(&state.write_pool)
            .await
            .unwrap();

        assert!(resolve(&state, 1, None).await.is_err());
        let (provider, _) = resolve(&state, 1, Some("claude_code")).await.unwrap();
        assert_eq!(provider, "claude_code");
    }

    /// Found in QA: a conversation that already ran on Claude could not
    /// reconnect once its own provider setting became unreadable, although
    /// the provider it runs is recorded on its session.
    #[tokio::test]
    async fn a_recorded_provider_needs_no_setting_read() {
        let state = make_test_app_state().await;
        let mut persistence = WsSessionPersistence::new(state.write_pool.clone(), 1);
        let session_id = persistence
            .find_or_create_session_with_access_mode(None, None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE agent_sessions SET runtime_provider = 'claude_code' WHERE id = ?")
            .bind(session_id)
            .execute(&state.write_pool)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE feature_settings RENAME TO feature_settings_unreadable")
            .execute(&state.write_pool)
            .await
            .unwrap();

        let (provider, _) = resolve(&state, 1, None).await.unwrap();
        assert_eq!(provider, "claude_code");
    }
}
