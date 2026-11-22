use super::super::persistence::WsSessionPersistence;
use super::super::protocol::*;
use super::helpers::{saved_or_report, setting_or_report};
use super::{send_error, thinking_effort, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::agents::runtime_adapter;
use crate::domain::workflow::worktree;
use tracing::{info, warn};
mod binding;
mod effort;
mod fast_mode;
mod feature;
mod input;
mod mode;
mod profile;
mod provider;
mod restore;

/// Handle session.init: DB-driven session creation.
pub(super) async fn handle_init(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) -> Option<i64> {
    let (payload, feature_id, cwd) = input::parse(&envelope, sender)?;

    // Register the WS sender so HTTP handlers (e.g. auto-rename) can push
    // envelopes to this connection later.
    app_state
        .ws_feature_senders
        .register(feature_id, sender.clone())
        .await;

    let project_id =
        feature::require_feature_project_id(app_state, sender, &envelope.id, feature_id).await?;

    let initial_read = provider::resolve(app_state, feature_id, payload.provider.as_deref());
    let (initial_provider, configured_initial_access_mode) =
        setting_or_report(sender, &envelope.id, "agent provider", initial_read.await)?;
    let configured_initial_access_wire = configured_initial_access_mode
        .as_ref()
        .map(crate::domain::agents::adapter::access_mode_wire);

    // Find or create DB session row
    let mut persistence = WsSessionPersistence::new(app_state.write_pool.clone(), feature_id);
    let pm_str = payload.permission_mode.as_deref();
    let db_session_id = match persistence
        .find_or_create_session_for_binding(
            payload.model.as_deref(),
            pm_str,
            configured_initial_access_wire,
        )
        .await
    {
        Ok(id) => id,
        Err(error) => {
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                &format!("Failed to create or find the session in the database: {error}"),
            );
            return None;
        }
    };

    let sdk_sessions = app_state
        .session_runtimes
        .bind_feature(db_session_id, feature_id, sdk_sessions)
        .await;
    let mut sessions = sdk_sessions.lock().await;

    let Ok(mut row) = binding::read_row(app_state, sender, &envelope.id, db_session_id).await
    else {
        return Some(db_session_id);
    };
    let spawning = app_state.session_runtimes.is_spawning(db_session_id).await;
    if let Some(payload) = sessions
        .get(&db_session_id)
        .and_then(|handle| binding::live_payload(db_session_id, handle, row.as_ref(), spawning))
    {
        drop(sessions);
        binding::reply_and_restore(
            app_state,
            sender,
            &envelope.id,
            payload,
            feature_id,
            row.as_ref()
                .and_then(|row| row.runtime_session_id.as_deref()),
        )
        .await;
        return Some(db_session_id);
    }
    if let Err(error) = persistence.reopen_session(db_session_id, pm_str).await {
        send_error(
            sender,
            &envelope.id,
            "DB_ERROR",
            &format!("Failed to reopen session: {error}"),
        );
        return Some(db_session_id);
    }
    let effective_cwd = match worktree::resolve_feature_cwd(&app_state.read_pool, feature_id).await
    {
        Ok(path) => path,
        Err(error) => {
            send_error(sender, &envelope.id, "WORKTREE_CHECK_FAILED", &error);
            return Some(db_session_id);
        }
    };
    if effective_cwd != cwd {
        info!(feature_id, runtime_cwd = %effective_cwd, "resolved runtime cwd from feature state");
    }
    let inherited =
        match binding::prepare_controls(app_state, row.as_mut(), &payload, &effective_cwd).await {
            Ok(true) => row.as_ref(),
            Ok(false) => None,
            Err(error) => {
                let (code, message) = match error {
                    crate::error::AppError::Coded { code, message, .. } => (code, message),
                    error => ("DB_ERROR", error.to_string()),
                };
                send_error(sender, &envelope.id, code, &message);
                return Some(db_session_id);
            }
        };
    let stored_thinking_effort = row.as_ref().and_then(|r| r.thinking_effort.clone());
    let stored_fast_mode = row.as_ref().is_some_and(|r| r.fast_mode);
    let selection = provider::effective_selection()
        .app_state(app_state)
        .cwd(&effective_cwd)
        .feature_id(feature_id)
        .maybe_row(row.as_ref())
        .maybe_requested_provider(payload.provider.clone())
        .maybe_requested_model(payload.model.clone())
        .call()
        .await;
    let provider::InitialSelection {
        provider: effective_provider,
        model: mut effective_model,
        pin_model,
    } = match selection {
        Ok(selection) => selection,
        Err(error) => {
            send_error(sender, &envelope.id, error.code(), &error.to_string());
            return Some(db_session_id);
        }
    };

    let resolved_effort = effort::resolve(
        app_state,
        db_session_id,
        &effective_provider,
        effective_model.as_deref(),
        payload.thinking_effort.clone(),
        row.as_ref(),
    )
    .await;
    let Some((mut effective_thinking_effort, cleared_unsupported_effort)) =
        effort::reported(sender, &envelope.id, resolved_effort)
    else {
        return Some(db_session_id);
    };
    let init_input_tokens = row.as_ref().and_then(|r| r.input_tokens);
    let init_output_tokens = row.as_ref().and_then(|r| r.output_tokens);
    let init_context_window = row.as_ref().and_then(|r| r.context_window);

    let Some(adapter) = runtime_adapter(&effective_provider) else {
        send_error(
            sender,
            &envelope.id,
            "UNSUPPORTED_PROVIDER",
            &format!(
                "Runtime provider '{effective_provider}' is not available; install or enable it to continue this session"
            ),
        );
        return Some(db_session_id);
    };

    let resume_session_id = match super::session_init_resume::checked_resume_session_id()
        .adapter(&*adapter)
        .provider_id(&effective_provider)
        .maybe_row_runtime_provider(row.as_ref().and_then(|r| r.runtime_provider.as_deref()))
        .maybe_runtime_session_id(row.as_ref().and_then(|r| r.runtime_session_id.as_deref()))
        .call()
    {
        Ok(resume) => resume,
        Err(reason) => {
            send_error(
                sender,
                &envelope.id,
                "MANAGED_SESSION_OWNER_CHANGED",
                &reason,
            );
            return Some(db_session_id);
        }
    };
    let mut runtime_config = RuntimeSpawnConfig {
        cwd: effective_cwd.into(),
        model: effective_model.clone(),
        thinking_effort: effective_thinking_effort.clone(),
        ..Default::default()
    };
    let requested_mode = payload.permission_mode.as_deref().or_else(|| {
        row.as_ref()
            .and_then(|session| session.permission_mode.as_deref())
    });
    let permission_mode = match adapter
        .resolve_initial_permission_mode(&runtime_config.cwd, requested_mode)
        .await
    {
        Ok(mode) => mode,
        Err(error) => {
            send_error(
                sender,
                &envelope.id,
                "PROVIDER_MODE_DISCOVERY_FAILED",
                &error.to_string(),
            );
            return Some(db_session_id);
        }
    };
    let persisted_mode = mode::persist(
        app_state,
        db_session_id,
        requested_mode,
        permission_mode.as_ref(),
    )
    .await;
    let Some(effective_permission_mode_wire) =
        saved_or_report(sender, &envelope.id, "permission mode", persisted_mode)
    else {
        return Some(db_session_id);
    };
    runtime_config.permission_mode = permission_mode;
    let initial = (initial_provider.as_str(), configured_initial_access_mode);
    let read = provider::access_mode_for(app_state, initial, &effective_provider);
    let Some(configured_access_mode) =
        setting_or_report(sender, &envelope.id, "access mode", read.await)
    else {
        return Some(db_session_id);
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
    let profile_config = match profile::resolve(
        profile::ResolveOptions::builder()
            .app_state(app_state)
            .project_id(project_id)
            .feature_id(feature_id)
            .db_session_id(db_session_id)
            .provider(&effective_provider)
            .maybe_row(row.as_ref())
            .pin_model(pin_model)
            .maybe_stored_effort(stored_thinking_effort.as_deref())
            .stored_fast_mode(stored_fast_mode)
            .maybe_effective_model(effective_model)
            .maybe_effective_effort(effective_thinking_effort)
            .runtime_config(&mut runtime_config)
            .build(),
    )
    .await
    {
        Ok(config) => config,
        Err((code, message)) => {
            send_error(sender, &envelope.id, code, &message);
            return Some(db_session_id);
        }
    };
    let profile::ResolvedProfileConfig {
        effective_profile,
        effective_model: resolved_model,
        effective_thinking_effort: resolved_effort,
        profile_effective_fast_mode,
        inherits_profile_config,
    } = profile_config;
    effective_model = resolved_model;
    effective_thinking_effort = resolved_effort;
    let mut effective_fast_mode = match fast_mode::resolve(
        app_state,
        fast_mode::RestoreFastModeOptions {
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
            return Some(db_session_id);
        }
    };
    effective_fast_mode = fast_mode::profile_effective_or_legacy(
        inherits_profile_config,
        profile_effective_fast_mode,
        effective_fast_mode,
    );
    runtime_config.fast_mode = effective_fast_mode;

    let persisted = if let Some(row) = inherited {
        row.persist_inherited_controls(&app_state.write_pool).await
    } else {
        WsSessionPersistence::update_runtime_selection_static()
            .pool(&app_state.write_pool)
            .session_id(db_session_id)
            .runtime_provider(&effective_provider)
            .maybe_model(effective_model.as_deref())
            .maybe_initial_overrides(
                (inherits_profile_config
                    && row.as_ref().is_none_or(|r| r.runtime_overrides.is_none()))
                .then_some(&runtime_config.overrides),
            )
            .clear_thinking_effort(cleared_unsupported_effort)
            .call()
            .await
            .map_err(crate::error::AppError::from)
    };
    if let Err(error) = persisted {
        warn!(
            db_session_id,
            runtime_provider = %effective_provider,
            %error,
            "failed to persist session runtime selection"
        );
        send_error(
            sender,
            &envelope.id,
            "DB_ERROR",
            "Failed to persist session runtime selection",
        );
        return Some(db_session_id);
    }

    info!(
        db_session_id,
        feature_id, "session initialized (pending first prompt)"
    );

    let runtime_overrides = runtime_config.overrides.clone();
    let handle = binding::pending_handle()
        .runtime_config(runtime_config)
        .feature_id(feature_id)
        .runtime_provider(effective_provider.clone())
        .maybe_profile(effective_profile.clone())
        .maybe_resume_session_id(resume_session_id.clone())
        .call();

    sessions.insert(db_session_id, handle);
    drop(sessions);

    binding::reply_and_restore(
        app_state,
        sender,
        &envelope.id,
        SessionInitializedPayload {
            session_id: db_session_id.to_string(),
            provider: Some(effective_provider.clone()),
            model: effective_model,
            thinking_effort: effective_thinking_effort,
            fast_mode: effective_fast_mode,
            profile: effective_profile,
            runtime_overrides,
            permission_mode: effective_permission_mode_wire,
            codex_permission_mode: adapter
                .legacy_access_mode_wire(effective_access_mode_wire.as_deref()),
            access_mode: effective_access_mode_wire,
            input_tokens: init_input_tokens.map(|v| v as u64),
            output_tokens: init_output_tokens.map(|v| v as u64),
            context_window: init_context_window.map(|v| v as u64),
            supports_prompt_receipts: adapter.supports_prompt_receipts(),
        },
        feature_id,
        resume_session_id.as_deref(),
    )
    .await;
    Some(db_session_id)
}
