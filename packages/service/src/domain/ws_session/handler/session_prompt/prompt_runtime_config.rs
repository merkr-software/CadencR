use tracing::info;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::super::{QueryState, SdkHandle};

pub(super) struct DispatchChanges {
    pub(super) model_changed: bool,
    pub(super) mode_changed: bool,
    pub(super) access_changed: bool,
    pub(super) effort_changed: bool,
    pub(super) profile_changed: bool,
    pub(super) needs_respawn: bool,
}

pub(super) async fn apply_respawn_if_needed(
    handle: &mut SdkHandle,
    app_state: &AppState,
    db_session_id: i64,
) -> DispatchChanges {
    let changes = dispatch_changes(handle);
    if !changes.needs_respawn {
        return changes;
    }
    log_respawn(handle, db_session_id);
    let runtime_session_id = close_active_for_respawn(handle, app_state, db_session_id).await;
    reset_handle_to_pending(handle, runtime_session_id);
    changes
}

pub(super) fn dispatch_changes(handle: &SdkHandle) -> DispatchChanges {
    dispatch_changes_for_active(handle, matches!(&handle.state, QueryState::Active { .. }))
}

fn dispatch_changes_for_active(handle: &SdkHandle, is_active: bool) -> DispatchChanges {
    let model_changed = handle.desired_model != handle.spawned_model;
    let mode_changed = handle.desired_permission_mode != handle.spawned_permission_mode;
    let access_changed = handle.desired_access_mode != handle.spawned_access_mode;
    let effort_changed = handle.desired_thinking_effort != handle.spawned_thinking_effort;
    let profile_changed = handle.desired_claude_profile != handle.spawned_claude_profile;
    DispatchChanges {
        model_changed,
        mode_changed,
        access_changed,
        effort_changed,
        profile_changed,
        needs_respawn: is_active
            && (model_changed
                || mode_changed
                || access_changed
                || effort_changed
                || profile_changed),
    }
}

fn log_respawn(handle: &SdkHandle, db_session_id: i64) {
    info!(
        db_session_id,
        old_model = ?handle.spawned_model,
        new_model = ?handle.desired_model,
        old_mode = ?handle.spawned_permission_mode,
        new_mode = ?handle.desired_permission_mode,
        old_access_mode = ?handle.spawned_access_mode,
        new_access_mode = ?handle.desired_access_mode,
        old_effort = ?handle.spawned_thinking_effort,
        new_effort = ?handle.desired_thinking_effort,
        old_claude_profile = ?handle.spawned_claude_profile,
        new_claude_profile = ?handle.desired_claude_profile,
        "runtime config changed, respawning runtime with --resume"
    );
}

async fn close_active_for_respawn(
    handle: &mut SdkHandle,
    app_state: &AppState,
    db_session_id: i64,
) -> Option<String> {
    let QueryState::Active { query, .. } = &handle.state else {
        return None;
    };
    let session_id = query.read().await.session_id().await;
    if let Some(ref runtime_session_id) = session_id {
        WsSessionPersistence::persist_runtime_session_id_static(
            &app_state.write_pool,
            db_session_id,
            &handle.runtime_provider,
            runtime_session_id,
        )
        .await;
    }
    query.write().await.close().await;
    session_id
}

fn reset_handle_to_pending(handle: &mut SdkHandle, resume_session_id: Option<String>) {
    let options = RuntimeSpawnConfig {
        cwd: handle.config.cwd.clone(),
        permission_mode: handle.desired_permission_mode.clone(),
        access_mode: handle.desired_access_mode.clone(),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        system_prompt: handle.config.system_prompt.clone(),
        resume_session_id,
        allow_bypass_permissions: handle.config.allow_bypass_permissions,
        env: handle.config.env.clone(),
        ..RuntimeSpawnConfig::default()
    };
    handle.spawned_model = handle.desired_model.clone();
    handle.spawned_permission_mode = handle.desired_permission_mode.clone();
    handle.spawned_access_mode = handle.desired_access_mode.clone();
    handle.spawned_thinking_effort = handle.desired_thinking_effort.clone();
    handle.spawned_claude_profile = handle.desired_claude_profile.clone();
    handle.config.permission_mode = handle.desired_permission_mode.clone();
    handle.config.access_mode = handle.desired_access_mode.clone();
    handle.config.thinking_effort = handle.desired_thinking_effort.clone();
    handle.config.claude_profile = handle.desired_claude_profile.clone();
    handle.state = QueryState::Pending(options);
}

pub(super) fn log_dispatch_decision(
    handle: &SdkHandle,
    db_session_id: i64,
    changes: &DispatchChanges,
) {
    info!(
        db_session_id,
        desired_model = ?handle.desired_model,
        spawned_model = ?handle.spawned_model,
        desired_mode = ?handle.desired_permission_mode,
        spawned_mode = ?handle.spawned_permission_mode,
        desired_effort = ?handle.desired_thinking_effort,
        spawned_effort = ?handle.spawned_thinking_effort,
        desired_claude_profile = ?handle.desired_claude_profile,
        spawned_claude_profile = ?handle.spawned_claude_profile,
        model_changed = changes.model_changed,
        mode_changed = changes.mode_changed,
        access_changed = changes.access_changed,
        effort_changed = changes.effort_changed,
        profile_changed = changes.profile_changed,
        needs_respawn = changes.needs_respawn,
        state = match &handle.state {
            QueryState::Pending(_) => "pending",
            QueryState::Active { .. } => "active",
        },
        "prompt_send dispatch decision"
    );
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use crate::domain::agents::adapter::RuntimeSpawnConfig;

    use super::super::super::types::SessionConfig;
    use super::*;

    fn pending_handle() -> SdkHandle {
        SdkHandle {
            state: QueryState::Pending(RuntimeSpawnConfig::default()),
            feature_id: 1,
            runtime_provider: crate::domain::agents::claude_code::PROVIDER_ID.to_string(),
            desired_model: Some("sonnet".to_string()),
            spawned_model: Some("sonnet".to_string()),
            desired_permission_mode: None,
            spawned_permission_mode: None,
            desired_access_mode: None,
            spawned_access_mode: None,
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            desired_claude_profile: Some("bedrock".to_string()),
            spawned_claude_profile: Some("default".to_string()),
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: None,
                access_mode: None,
                thinking_effort: None,
                system_prompt: None,
                allow_bypass_permissions: false,
                claude_profile: Some("bedrock".to_string()),
                env: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
            manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn claude_profile_change_marks_active_runtime_for_respawn() {
        let handle = pending_handle();

        let changes = dispatch_changes_for_active(&handle, true);

        assert!(changes.profile_changed);
        assert!(changes.needs_respawn);
    }

    #[test]
    fn claude_profile_change_does_not_respawn_pending_runtime() {
        let handle = pending_handle();

        let changes = dispatch_changes_for_active(&handle, false);

        assert!(changes.profile_changed);
        assert!(!changes.needs_respawn);
    }

    #[test]
    fn codex_access_change_marks_active_runtime_for_respawn() {
        let mut handle = pending_handle();
        handle.runtime_provider = crate::domain::agents::codex::PROVIDER_ID.to_string();
        handle.desired_access_mode =
            Some(crate::domain::agents::adapter::RuntimeAccessMode::AutoReview);
        handle.spawned_access_mode =
            Some(crate::domain::agents::adapter::RuntimeAccessMode::Default);
        handle.desired_claude_profile = None;
        handle.spawned_claude_profile = None;

        let changes = dispatch_changes_for_active(&handle, true);

        assert!(changes.access_changed);
        assert!(changes.needs_respawn);
    }
}
