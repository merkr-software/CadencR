use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimePermissionMode;
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::ws_session::persistence::WsSessionPersistence;

/// Persist the provider's resolved initial mode for the initialized reply.
pub(super) async fn persist(
    app_state: &AppState,
    db_session_id: i64,
    requested: Option<&str>,
    mode: Option<&RuntimePermissionMode>,
) -> Result<Option<String>, sqlx::Error> {
    let wire = mode.map(permission_mode_wire);
    if let Some(wire) = wire.as_deref().filter(|wire| Some(*wire) != requested) {
        WsSessionPersistence::update_permission_mode_static(
            &app_state.write_pool,
            db_session_id,
            wire,
        )
        .await?;
    }
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::runtime_adapter;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;

    #[tokio::test]
    async fn a_fresh_row_uses_the_provider_mode_even_with_the_legacy_sql_default() {
        let state = make_test_app_state().await;
        sqlx::raw_sql(
            "ALTER TABLE agent_sessions RENAME COLUMN permission_mode TO test_old_permission_mode;
             ALTER TABLE agent_sessions ADD COLUMN permission_mode TEXT DEFAULT 'bypassPermissions';",
        )
        .execute(&state.write_pool)
        .await
        .unwrap();
        for (feature_id, provider, expected_mode) in [
            (1, "claude_code", "auto"),
            (2, "codex_cli", "default"),
            (3, "opencode", "acceptEdits"),
        ] {
            let session_id = WsSessionPersistence::new(state.write_pool.clone(), feature_id)
                .find_or_create_session_for_binding(None, None, None)
                .await
                .unwrap();
            let row = WsSessionPersistence::get_session_row(&state.read_pool, session_id)
                .await
                .unwrap()
                .unwrap();
            assert!(row.permission_mode.is_none(), "{provider}");
            let requested_mode = row.permission_mode.as_deref();
            let adapter = runtime_adapter(provider).unwrap();
            let mode = adapter
                .resolve_initial_permission_mode(&std::env::temp_dir(), requested_mode)
                .await
                .unwrap();
            let wire = persist(&state, session_id, requested_mode, mode.as_ref())
                .await
                .unwrap();
            assert_eq!(wire.as_deref(), Some(expected_mode), "{provider}");
            let stored = WsSessionPersistence::get_session_row(&state.read_pool, session_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(stored.permission_mode.as_deref(), Some(expected_mode));
        }
    }
}
