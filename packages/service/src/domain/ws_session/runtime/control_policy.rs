use super::state::{QueryState, SdkHandle, SdkSessions};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeConfigOverrides, RuntimePermissionMode};

/// Point a handle at `overrides`: its next spawn, and a respawn of its live
/// runtime on the next prompt, run with them.
pub(crate) fn adopt_runtime_overrides(handle: &mut SdkHandle, overrides: &RuntimeConfigOverrides) {
    handle.config.overrides = overrides.clone();
    handle.config.runtime_overrides_dirty = true;
    handle.desired_model = overrides.model.clone();
    handle.desired_thinking_effort = overrides.thinking_effort.clone();
    if let Some(fast_mode) = overrides.fast_mode {
        handle.config.fast_mode = fast_mode;
    }
    if let QueryState::Pending(options) = &mut handle.state {
        options.overrides = overrides.clone();
        options.model = overrides.model.clone();
        options.thinking_effort = overrides.thinking_effort.clone();
        if let Some(fast_mode) = overrides.fast_mode {
            options.fast_mode = fast_mode;
        }
    }
}

/// Allow bypass on the next spawn when a deferred bypass re-arm is pending
/// (see [`apply_active_permission_mode`]). Called right before every
/// prompt-time respawn.
pub(in crate::domain::ws_session) async fn arm_bypass_for_respawn(
    handle: &mut SdkHandle,
    pool: &sqlx::SqlitePool,
) {
    let Some(mode) = handle.desired_permission_mode.clone() else {
        return;
    };
    if should_rearm_bypass(handle, &mode, pool).await {
        handle.config.allow_bypass_permissions = true;
    }
}

pub(in crate::domain::ws_session) async fn should_rearm_bypass(
    handle: &SdkHandle,
    new_mode: &RuntimePermissionMode,
    pool: &sqlx::SqlitePool,
) -> bool {
    *new_mode == RuntimePermissionMode::BypassPermissions
        && !handle.config.allow_bypass_permissions
        && match crate::domain::agents::runtime_adapter(&handle.runtime_provider) {
            Some(adapter) => {
                adapter
                    .bypass_permission_opt_in(pool, handle.feature_id, None)
                    .await
                    == Some(true)
            }
            None => false,
        }
}

/// Whether the registry-owned session cell holds a live runtime. The lock is
/// released before looking up the active-turn metadata.
pub(in crate::domain::ws_session) async fn session_is_active(
    sessions: &SdkSessions,
    db_session_id: i64,
) -> bool {
    let guard = sessions.lock().await;
    matches!(
        guard.get(&db_session_id).map(|h| &h.state),
        Some(QueryState::Active { .. })
    )
}

/// Resolve the canonical cell containing the live runtime. The caller usually
/// already holds that cell; active-turn metadata supplies the same owner when
/// a legacy Pending candidate is passed by an adapter or test.
pub(in crate::domain::ws_session) async fn resolve_owner_sessions(
    own: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
) -> SdkSessions {
    if session_is_active(own, db_session_id).await {
        own.clone()
    } else {
        app_state
            .active_turns
            .owner_sessions(db_session_id)
            .await
            .unwrap_or_else(|| own.clone())
    }
}
