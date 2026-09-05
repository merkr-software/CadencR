use super::super::persistence::WsSessionPersistence;
use super::super::protocol::*;
use super::{
    send_error, send_runtime_session_id, thinking_effort, QueryState, SdkHandle, SdkSessions,
    SessionConfig, WsSender,
};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::agents::permission_modes::effective_permission_mode;
use crate::domain::agents::{default_provider_id, resolve_effective_provider, runtime_adapter};
use crate::domain::settings;
use crate::domain::workflow::worktree;
use std::sync::Arc;
use tracing::{debug, info, warn};
#[path = "session_init_effort.rs"]
mod session_init_effort;
#[path = "session_init_fast_mode.rs"]
mod session_init_fast_mode;
#[path = "session_init_feature.rs"]
mod session_init_feature;
#[path = "session_init_restore.rs"]
mod session_init_restore;

/// Handle session.init: DB-driven session creation.
pub(super) async fn handle_init(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionInitPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    // feature_id is required for DB-first sessions
    let feature_id = match payload.feature_id {
        Some(fid) => fid,
        None => {
            send_error(
                sender,
                &envelope.id,
                "MISSING_FEATURE_ID",
                "feature_id is required for session init",
            );
            return;
        }
    };

    // cwd is required
    let cwd = match payload.cwd {
        Some(ref cwd) if !cwd.is_empty() => cwd.clone(),
        _ => {
            send_error(
                sender,
                &envelope.id,
                "MISSING_CWD",
                "cwd is required for session init",
            );
            return;
        }
    };

    // Register the WS sender so HTTP handlers (e.g. auto-rename) can push
    // envelopes to this connection later.
    app_state
        .ws_feature_senders
        .register(feature_id, sender.clone())
        .await;

    let Some(project_id) = session_init_feature::require_feature_project_id(
        app_state,
        sender,
        &envelope.id,
        feature_id,
    )
    .await
    else {
        return;
    };

    let configured_provider = settings::resolve_setting(
        &app_state.read_pool,
        &crate::domain::agents::runtime::runtime_setting_key("session"),
        Some(feature_id),
        Some(project_id),
        Some(default_provider_id()),
    )
    .await
    .unwrap_or_else(|| default_provider_id().to_string());
    let initial_provider = payload
        .provider
        .clone()
        .unwrap_or_else(|| configured_provider.clone());
    let configured_initial_access_mode =
        super::access::configured_access_mode(&initial_provider, &app_state.read_pool).await;
    let configured_initial_access_wire = configured_initial_access_mode
        .as_ref()
        .map(crate::domain::agents::adapter::access_mode_wire);

    // Find or create DB session row
    info!(
        feature_id,
        "handle_init: looking up session in DB for feature_id"
    );
    let mut persistence = WsSessionPersistence::new(app_state.write_pool.clone(), feature_id);
    let pm_str = payload.permission_mode.as_deref();
    let db_session_id = match persistence
        .find_or_create_session_with_access_mode(
            payload.model.as_deref(),
            pm_str,
            configured_initial_access_wire,
        )
        .await
    {
        Some(id) => {
            info!(
                feature_id,
                db_session_id = id,
                "handle_init: found/created session row"
            );
            id
        }
        None => {
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                "Failed to create/find session in database",
            );
            return;
        }
    };

    // Read session row for runtime_session_id (--resume), token usage, and stored model.
    let row = WsSessionPersistence::get_session_row(&app_state.read_pool, db_session_id).await;
    let runtime_provider = row.as_ref().and_then(|r| r.runtime_provider.clone());
    if let Some(ref r) = row {
        debug!(
            db_session_id,
            feature_id,
            runtime_provider = ?r.runtime_provider,
            runtime_session_id = ?r.runtime_session_id,
            status = %r.status,
            model = ?r.model,
            "handle_init: DB row state at init time"
        );
    }

    let stored_model = row.as_ref().and_then(|r| r.model.clone());
    let effective_model = stored_model.clone().or(payload.model.clone());
    let stored_thinking_effort = row.as_ref().and_then(|r| r.thinking_effort.clone());
    let stored_fast_mode = row.as_ref().is_some_and(|r| r.fast_mode);
    let selected_provider = runtime_provider.or(payload.provider.clone());
    let effective_provider = match selected_provider {
        Some(provider) => provider,
        None => {
            resolve_effective_provider(
                &app_state.read_pool,
                Some(std::path::Path::new(&cwd)),
                configured_provider,
                effective_model.as_deref(),
            )
            .await
        }
    };

    let (effective_thinking_effort, cleared_unsupported_effort) = session_init_effort::resolve(
        app_state,
        db_session_id,
        &effective_provider,
        effective_model.as_deref(),
        payload.thinking_effort.clone(),
        stored_thinking_effort,
    )
    .await;
    let resume_session_id = row.as_ref().and_then(|r| {
        super::session_init_resume::resume_session_id_for_provider(
            &effective_provider,
            r.runtime_provider.as_deref(),
            r.runtime_session_id.as_deref(),
        )
    });
    let init_input_tokens = row.as_ref().and_then(|r| r.input_tokens);
    let init_output_tokens = row.as_ref().and_then(|r| r.output_tokens);
    let init_context_window = row.as_ref().and_then(|r| r.context_window);

    let Some(adapter) = runtime_adapter(&effective_provider) else {
        send_error(
            sender,
            &envelope.id,
            "UNSUPPORTED_PROVIDER",
            &format!(
                "Runtime provider '{effective_provider}' is not implemented yet for session agents"
            ),
        );
        return;
    };

    if let Err(error) = WsSessionPersistence::update_runtime_provider_static(
        &app_state.write_pool,
        db_session_id,
        &effective_provider,
        cleared_unsupported_effort,
    )
    .await
    {
        warn!(
            db_session_id,
            runtime_provider = %effective_provider,
            %error,
            "failed to persist session runtime provider"
        );
        if cleared_unsupported_effort {
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                "Failed to clear thinking effort",
            );
            return;
        }
    }

    // Build SDK options — prefer the model stored in the DB (last used) over the frontend settings model
    let mut runtime_config = RuntimeSpawnConfig::default();
    let effective_cwd = match worktree::resolve_feature_cwd(&app_state.read_pool, feature_id).await
    {
        Ok(path) => path,
        Err(error) => {
            send_error(sender, &envelope.id, "WORKTREE_CHECK_FAILED", &error);
            return;
        }
    };
    if effective_cwd != cwd {
        info!(feature_id, runtime_cwd = %effective_cwd, "resolved runtime cwd from feature state");
    }
    runtime_config.cwd = std::path::PathBuf::from(&effective_cwd);
    if let Some(ref model) = effective_model {
        runtime_config.model = Some(model.clone());
    }
    runtime_config.thinking_effort = effective_thinking_effort.clone();
    // Honor the client's choice when supplied; otherwise fall back to the
    // active provider's default. The DB-read and provider-switch paths
    // already apply this default — session.init was the missing site.
    runtime_config.permission_mode =
        effective_permission_mode(&effective_provider, payload.permission_mode.as_deref());
    let configured_access_mode = if effective_provider == initial_provider {
        configured_initial_access_mode
    } else {
        super::access::configured_access_mode(&effective_provider, &app_state.read_pool).await
    };
    runtime_config.access_mode = super::access::runtime_access_mode(
        &effective_provider,
        row.as_ref()
            .and_then(|session| session.codex_permission_mode.as_deref()),
        configured_access_mode,
    );
    let effective_access_mode_wire = runtime_config
        .access_mode
        .as_ref()
        .map(crate::domain::agents::adapter::access_mode_wire)
        .map(ToOwned::to_owned);
    runtime_config.system_prompt = payload.system_prompt.clone();
    let effective_profile = super::session_runtime_config::apply_claude_settings(
        app_state,
        project_id,
        feature_id,
        db_session_id,
        &effective_provider,
        row.as_ref().and_then(|session| session.profile.as_deref()),
        &mut runtime_config,
    )
    .await;
    let effective_fast_mode = match session_init_fast_mode::resolve(
        app_state,
        session_init_fast_mode::RestoreFastModeOptions {
            db_session_id,
            provider: &effective_provider,
            model: effective_model.as_deref(),
            cwd: &runtime_config.cwd,
            profile: effective_profile.as_deref(),
            stored_fast_mode,
        },
    )
    .await
    {
        Ok(enabled) => enabled,
        Err(error) => {
            warn!(db_session_id, %error, "failed to normalize restored fast mode");
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                "Failed to restore fast mode",
            );
            return;
        }
    };
    runtime_config.fast_mode = effective_fast_mode;

    info!(
        db_session_id,
        feature_id, "session initialized (pending first prompt)"
    );

    let desired_model = runtime_config.model.clone();
    let desired_permission_mode = runtime_config.permission_mode.clone();
    let desired_access_mode = runtime_config.access_mode.clone();
    let desired_thinking_effort = runtime_config.thinking_effort.clone();
    let config = SessionConfig::from_runtime(&runtime_config, effective_profile.clone());
    let handle = SdkHandle {
        state: QueryState::Pending(runtime_config),
        feature_id,
        runtime_provider: effective_provider.clone(),
        desired_model,
        spawned_model: None,
        desired_permission_mode,
        spawned_permission_mode: None,
        desired_access_mode,
        spawned_access_mode: None,
        desired_thinking_effort,
        spawned_thinking_effort: None,
        desired_claude_profile: effective_profile.clone(),
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        resume_session_id: resume_session_id.clone(),
        config,
        manual_compact_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        manual_compact_spawn_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };

    sdk_sessions.lock().await.insert(db_session_id, handle);

    // Send initialized response — session_id is now the DB id as a string
    let reply = WsEnvelope::reply(
        &envelope.id,
        "session",
        "initialized",
        serde_json::to_value(SessionInitializedPayload {
            session_id: db_session_id.to_string(),
            provider: Some(effective_provider.clone()),
            model: effective_model,
            thinking_effort: effective_thinking_effort,
            fast_mode: effective_fast_mode,
            profile: effective_profile,
            codex_permission_mode: if effective_provider
                == crate::domain::agents::codex::PROVIDER_ID
            {
                effective_access_mode_wire.clone()
            } else {
                None
            },
            access_mode: effective_access_mode_wire,
            input_tokens: init_input_tokens.map(|v| v as u64),
            output_tokens: init_output_tokens.map(|v| v as u64),
            context_window: init_context_window.map(|v| v as u64),
            supports_prompt_receipts: adapter.supports_prompt_receipts(),
        })
        .unwrap(),
    );
    let _ = sender.send(axum::extract::ws::Message::Text(String::from(reply).into()));

    if let Some(ref cli_sid) = resume_session_id {
        send_runtime_session_id(sender, cli_sid);
    }

    session_init_restore::restore_pending_or_idle(app_state, sender, db_session_id, feature_id)
        .await;

    if let Err(error) =
        super::session_init_worktree::restore_worktree_state(app_state, sender, feature_id).await
    {
        send_error(sender, &envelope.id, "WORKTREE_CHECK_FAILED", &error);
    }
}
