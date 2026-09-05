use std::sync::Arc;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::agents::permission_modes::effective_permission_mode;
use crate::domain::agents::{default_provider_id, resolve_effective_provider};
use crate::domain::settings;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::persistence::SessionRow;
use crate::error::AppError;

use super::super::{QueryState, SdkHandle, SessionConfig};

pub(super) async fn build_pending_handle(
    app_state: &AppState,
    project_id: i64,
    row: SessionRow,
) -> Result<SdkHandle, AppError> {
    let runtime_cwd = worktree::resolve_feature_cwd(&app_state.read_pool, row.feature_id)
        .await
        .map(std::path::PathBuf::from)
        .map_err(AppError::Internal)?;
    let provider = effective_provider(app_state, project_id, &runtime_cwd, &row).await;
    persist_resolved_provider(app_state, &row, &provider).await?;
    let (options, claude_profile) =
        runtime_options(app_state, project_id, runtime_cwd, &provider, &row).await;
    let config = SessionConfig::from_runtime(&options, claude_profile.clone());
    Ok(SdkHandle {
        state: QueryState::Pending(options),
        feature_id: row.feature_id,
        runtime_provider: provider,
        desired_model: row.model.clone(),
        spawned_model: None,
        desired_permission_mode: config.permission_mode.clone(),
        spawned_permission_mode: None,
        desired_access_mode: config.access_mode.clone(),
        spawned_access_mode: None,
        desired_thinking_effort: row.thinking_effort.clone(),
        spawned_thinking_effort: None,
        desired_claude_profile: claude_profile,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        resume_session_id: row.runtime_session_id.clone(),
        config,
        manual_compact_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        manual_compact_spawn_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
}

async fn persist_resolved_provider(
    app_state: &AppState,
    row: &SessionRow,
    provider: &str,
) -> Result<(), AppError> {
    if row.runtime_provider.is_some() {
        return Ok(());
    }
    crate::domain::ws_session::persistence::WsSessionPersistence::update_runtime_selection_static()
        .pool(&app_state.write_pool)
        .session_id(row.id)
        .runtime_provider(provider)
        .maybe_model(row.model.as_deref())
        .clear_thinking_effort(false)
        .call()
        .await?;
    Ok(())
}

async fn effective_provider(
    app_state: &AppState,
    project_id: i64,
    cwd: &std::path::Path,
    row: &SessionRow,
) -> String {
    if let Some(provider) = row.runtime_provider.as_ref() {
        return provider.clone();
    }
    let configured = settings::resolve_setting(
        &app_state.read_pool,
        &crate::domain::agents::runtime::runtime_setting_key("session"),
        Some(row.feature_id),
        Some(project_id),
        Some(default_provider_id()),
    )
    .await
    .unwrap_or_else(|| default_provider_id().to_string());
    resolve_effective_provider(
        &app_state.read_pool,
        Some(cwd),
        configured,
        row.model.as_deref(),
    )
    .await
}

async fn runtime_options(
    app_state: &AppState,
    project_id: i64,
    cwd: std::path::PathBuf,
    provider: &str,
    row: &SessionRow,
) -> (RuntimeSpawnConfig, Option<String>) {
    let mut options = RuntimeSpawnConfig {
        cwd,
        model: row.model.clone(),
        thinking_effort: row.thinking_effort.clone(),
        fast_mode: row.fast_mode,
        permission_mode: effective_permission_mode(provider, row.permission_mode.as_deref()),
        resume_session_id: row.runtime_session_id.clone(),
        ..Default::default()
    };
    options.access_mode = runtime_access_mode(app_state, provider, row).await;
    let claude_profile = super::super::session_runtime_config::apply_claude_settings(
        app_state,
        project_id,
        row.feature_id,
        row.id,
        provider,
        row.profile.as_deref(),
        &mut options,
    )
    .await;
    (options, claude_profile)
}

async fn runtime_access_mode(
    app_state: &AppState,
    provider: &str,
    row: &SessionRow,
) -> Option<crate::domain::agents::adapter::RuntimeAccessMode> {
    let configured =
        super::super::access::configured_access_mode(provider, &app_state.read_pool).await;
    super::super::access::runtime_access_mode(
        provider,
        row.codex_permission_mode.as_deref(),
        configured,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;

    #[tokio::test]
    async fn reconstructed_handle_drops_an_unsupported_permission_mode() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let app_state = AppState::with_pool(pool);
        let row = SessionRow {
            id: 1,
            feature_id: 1,
            runtime_provider: Some("cursor".to_string()),
            runtime_session_id: None,
            model: None,
            profile: None,
            permission_mode: Some("acceptEdits".to_string()),
            codex_permission_mode: None,
            status: "paused".to_string(),
            pending_permission: None,
            pending_questions: None,
            input_tokens: None,
            output_tokens: None,
            context_window: None,
            thinking_effort: None,
            fast_mode: false,
        };

        let (options, _) =
            runtime_options(&app_state, 1, PathBuf::from("/tmp"), "cursor", &row).await;
        assert!(options.permission_mode.is_none());
    }

    #[tokio::test]
    async fn reconstructed_claude_handle_restores_profile_environment() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
             CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL);
             INSERT INTO projects (id, path) VALUES (1, '/tmp/test');
             INSERT INTO features (id, project_id) VALUES (1, 1);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let app_state = AppState::with_pool(pool);
        let profile_env = HashMap::from([
            (
                "ANTHROPIC_BASE_URL".to_string(),
                "http://localhost:8317".to_string(),
            ),
            ("ANTHROPIC_AUTH_TOKEN".to_string(), "token".to_string()),
        ]);
        crate::domain::agents::claude_code::profiles::upsert_profile(
            "control-routing-proxy",
            &profile_env,
        )
        .await
        .unwrap();
        let row = SessionRow {
            id: 44,
            feature_id: 1,
            runtime_provider: Some("claude_code".to_string()),
            runtime_session_id: None,
            model: Some("gpt-5.6-sol".to_string()),
            profile: Some("control-routing-proxy".to_string()),
            permission_mode: Some("bypassPermissions".to_string()),
            codex_permission_mode: None,
            status: "paused".to_string(),
            pending_permission: None,
            pending_questions: None,
            input_tokens: None,
            output_tokens: None,
            context_window: None,
            thinking_effort: None,
            fast_mode: false,
        };

        let handle = build_pending_handle(&app_state, 1, row).await.unwrap();
        assert_eq!(
            handle.desired_claude_profile.as_deref(),
            Some("control-routing-proxy")
        );
        assert_eq!(
            handle.config.claude_profile.as_deref(),
            Some("control-routing-proxy")
        );
        assert_eq!(handle.config.env.as_ref(), Some(&profile_env));
        assert_eq!(
            handle.config.permission_mode,
            Some(crate::domain::agents::adapter::RuntimePermissionMode::AcceptEdits)
        );
        let QueryState::Pending(options) = handle.state else {
            panic!("expected pending handle");
        };
        assert_eq!(options.env.as_ref(), Some(&profile_env));
        crate::domain::agents::claude_code::profiles::delete_profile("control-routing-proxy")
            .await
            .unwrap();
    }
}
