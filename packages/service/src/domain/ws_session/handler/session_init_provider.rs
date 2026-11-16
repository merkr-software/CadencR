use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeAccessMode;
use crate::domain::agents::{default_provider_id, runtime::runtime_setting_key};
use crate::domain::settings;

pub(super) async fn resolve(
    app_state: &AppState,
    feature_id: i64,
    requested_provider: Option<&str>,
) -> (String, Option<RuntimeAccessMode>) {
    // Match resolve_selection: feature override -> workspace last-used provider.
    // Legacy project settings must not seed permissions for a different provider.
    let configured = settings::resolve_setting(
        &app_state.read_pool,
        &runtime_setting_key("session"),
        Some(feature_id),
        None,
        Some(default_provider_id()),
    )
    .await
    .unwrap_or_else(|| default_provider_id().to_string());
    let provider = requested_provider.map(str::to_string).unwrap_or(configured);
    let access_mode = crate::domain::ws_session::handler::access::configured_access_mode(
        &provider,
        &app_state.read_pool,
    )
    .await;
    (provider, access_mode)
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
        let (provider, access_mode) = resolve(&state, 1, None).await;
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
}
