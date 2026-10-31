use super::super::persistence::WsSessionPersistence;
use super::super::protocol::*;
use super::{send_error, thinking_effort, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::agents::runtime_adapter;
use crate::domain::workflow::worktree;
use tracing::{debug, info, warn};
#[path = "session_init_binding.rs"]
mod session_init_binding;
#[path = "session_init_effort.rs"]
mod session_init_effort;
#[path = "session_init_fast_mode.rs"]
mod session_init_fast_mode;
#[path = "session_init_feature.rs"]
mod session_init_feature;
#[path = "session_init_input.rs"]
mod session_init_input;
#[path = "session_init_mode.rs"]
mod session_init_mode;
#[path = "session_init_profile.rs"]
mod session_init_profile;
#[path = "session_init_provider.rs"]
mod session_init_provider;
#[path = "session_init_restore.rs"]
mod session_init_restore;

/// Handle session.init: DB-driven session creation.
pub(super) async fn handle_init(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) -> Option<i64> {
    let Some((payload, feature_id, cwd)) = session_init_input::parse(&envelope, sender) else {
        return None;
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
        return None;
    };

    let (initial_provider, configured_initial_access_mode) =
        session_init_provider::resolve(app_state, feature_id, payload.provider.as_deref()).await;
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
        .find_or_create_session_for_binding(
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
            return None;
        }
    };

    let sdk_sessions = app_state
        .session_runtimes
        .bind_feature(db_session_id, feature_id, sdk_sessions)
        .await;
    let mut sessions = sdk_sessions.lock().await;

    // Read session row for runtime_session_id (--resume), token usage, and stored model.
    let row = WsSessionPersistence::get_session_row(&app_state.read_pool, db_session_id).await;
    let spawning = app_state.session_runtimes.is_spawning(db_session_id).await;
    if let Some(payload) = sessions.get(&db_session_id).and_then(|handle| {
        session_init_binding::live_payload(db_session_id, handle, row.as_ref(), spawning)
    }) {
        drop(sessions);
        session_init_binding::reply_and_restore(
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
    let stored_thinking_effort = row.as_ref().and_then(|r| r.thinking_effort.clone());
    let stored_fast_mode = row.as_ref().is_some_and(|r| r.fast_mode);
    // `payload` has no `profile` field for session.init — the profile lives on
    // the persisted session row, same source `effective_profile` reads below.
    let profile_for_resolver = row.as_ref().and_then(|r| r.profile.clone());

    // A session that already ran keeps the provider it ran with. The resolver
    // only decides for sessions that have not pinned one yet.
    let pinned_provider = runtime_provider.or(payload.provider.clone());
    let (effective_provider, mut effective_model) = match pinned_provider {
        Some(provider) => (provider, stored_model.clone().or(payload.model.clone())),
        None => match crate::domain::agents::resolve_selection(
            &app_state.read_pool,
            Some(std::path::Path::new(&cwd)),
            "session",
            Some(feature_id),
            profile_for_resolver.as_deref(),
        )
        .await
        {
            Ok(selection) => (selection.provider_id, Some(selection.model_id)),
            Err(error) => {
                send_error(
                    sender,
                    &envelope.id,
                    "NO_MODEL_AVAILABLE",
                    &error.to_string(),
                );
                return Some(db_session_id);
            }
        },
    };

    let (mut effective_thinking_effort, cleared_unsupported_effort) = session_init_effort::resolve(
        app_state,
        db_session_id,
        &effective_provider,
        effective_model.as_deref(),
        payload.thinking_effort.clone(),
        stored_thinking_effort.clone(),
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
        return Some(db_session_id);
    };

    if let Err(error) = WsSessionPersistence::update_runtime_selection_static()
        .pool(&app_state.write_pool)
        .session_id(db_session_id)
        .runtime_provider(&effective_provider)
        .maybe_model(effective_model.as_deref())
        .clear_thinking_effort(cleared_unsupported_effort)
        .call()
        .await
    {
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

    // Build SDK options — prefer the model stored in the DB (last used) over the frontend settings model
    let mut runtime_config = RuntimeSpawnConfig::default();
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
    runtime_config.cwd = std::path::PathBuf::from(&effective_cwd);
    if let Some(ref model) = effective_model {
        runtime_config.model = Some(model.clone());
    }
    runtime_config.thinking_effort = effective_thinking_effort.clone();
    // Honor the client's choice when the provider supports it; otherwise fall
    // back to the active provider's default, and report the result.
    let (permission_mode, effective_permission_mode_wire) = session_init_mode::resolve(
        app_state,
        db_session_id,
        &effective_provider,
        payload.permission_mode.as_deref(),
    )
    .await;
    runtime_config.permission_mode = permission_mode;
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
    let profile_config = match session_init_profile::resolve(
        session_init_profile::ResolveOptions::builder()
            .app_state(app_state)
            .project_id(project_id)
            .feature_id(feature_id)
            .db_session_id(db_session_id)
            .provider(&effective_provider)
            .maybe_row(row.as_ref())
            .maybe_stored_model(stored_model.as_deref())
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
    let session_init_profile::ResolvedProfileConfig {
        effective_profile,
        effective_model: resolved_model,
        effective_thinking_effort: resolved_effort,
        profile_effective_fast_mode,
        inherits_profile_config,
    } = profile_config;
    effective_model = resolved_model;
    effective_thinking_effort = resolved_effort;
    let mut effective_fast_mode = match session_init_fast_mode::resolve(
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
            return Some(db_session_id);
        }
    };
    effective_fast_mode = session_init_fast_mode::profile_effective_or_legacy(
        inherits_profile_config,
        profile_effective_fast_mode,
        effective_fast_mode,
    );
    runtime_config.fast_mode = effective_fast_mode;

    info!(
        db_session_id,
        feature_id, "session initialized (pending first prompt)"
    );

    let runtime_overrides = runtime_config.overrides.clone();
    let handle = session_init_binding::pending_handle()
        .runtime_config(runtime_config)
        .feature_id(feature_id)
        .runtime_provider(effective_provider.clone())
        .maybe_profile(effective_profile.clone())
        .maybe_resume_session_id(resume_session_id.clone())
        .call();

    sessions.insert(db_session_id, handle);
    drop(sessions);

    session_init_binding::reply_and_restore(
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
