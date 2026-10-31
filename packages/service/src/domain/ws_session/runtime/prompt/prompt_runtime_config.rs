use crate::domain::ws_session::runtime::helpers::RuntimeCloseContext;
use tracing::info;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;

use super::super::control_policy::arm_bypass_for_respawn;
use super::super::helpers::persist_and_close_query;
use super::super::{QueryState, SdkHandle, WsSender};
use super::runtime_hold_registry::{notify_change_deferred, runtime_is_held};

pub(in crate::domain::ws_session) struct DispatchChanges {
    pub(in crate::domain::ws_session) model_changed: bool,
    pub(in crate::domain::ws_session) mode_changed: bool,
    pub(in crate::domain::ws_session) access_changed: bool,
    pub(in crate::domain::ws_session) effort_changed: bool,
    pub(in crate::domain::ws_session) profile_changed: bool,
    pub(in crate::domain::ws_session) overrides_changed: bool,
    pub(in crate::domain::ws_session) needs_respawn: bool,
    /// A respawn was due but the live runtime still owes the agent a resume
    /// (a background task or a scheduled wake-up), so it was kept: the
    /// prompt steers it and the respawn waits for a later prompt.
    pub(in crate::domain::ws_session) respawn_deferred: bool,
}

pub(in crate::domain::ws_session) async fn apply_respawn_if_needed(
    handle: &mut SdkHandle,
    app_state: &AppState,
    db_session_id: i64,
) -> DispatchChanges {
    let mut changes = dispatch_changes(handle);
    if !changes.needs_respawn {
        return changes;
    }
    if active_runtime_is_held(handle, db_session_id) {
        // Respawning closes the runtime, which kills its background tasks and
        // drops its pending wake-up, so the agent would never resume.
        info!(
            db_session_id,
            "runtime config changed but the runtime owes a resume; deferring respawn"
        );
        changes.needs_respawn = false;
        changes.respawn_deferred = true;
        return changes;
    }
    log_respawn(handle, db_session_id);
    arm_bypass_for_respawn(handle, &app_state.read_pool).await;
    let runtime_session_id = close_active_for_respawn(
        handle,
        &RuntimeCloseContext::builder()
            .pool(&app_state.write_pool)
            .feature_senders(&app_state.ws_feature_senders)
            .build(),
        db_session_id,
    )
    .await;
    reset_handle_to_pending(handle, runtime_session_id);
    changes
}

fn active_runtime_is_held(handle: &SdkHandle, db_session_id: i64) -> bool {
    match &handle.state {
        QueryState::Active { query, .. } => runtime_is_held(db_session_id, query),
        QueryState::Pending(_) => false,
    }
}

/// What a deferred respawn leaves unapplied, as user-facing labels. Model
/// changes are already applied to the live runtime when they are made, so only
/// the respawn-only settings are listed.
fn deferred_changes(changes: &DispatchChanges) -> Vec<&'static str> {
    if !changes.respawn_deferred {
        return Vec::new();
    }
    [
        // Mode changes apply live, except enabling Claude bypass, which needs
        // a respawn (see `session_control::mode`).
        (changes.mode_changed, "permission mode"),
        (changes.effort_changed, "reasoning effort"),
        (changes.profile_changed, "profile"),
        (changes.access_changed, "access mode"),
        (changes.overrides_changed, "runtime settings"),
    ]
    .into_iter()
    .filter_map(|(changed, label)| changed.then_some(label))
    .collect()
}

/// Tell the sender which of its setting changes wait for the runtime's
/// background work: the prompt still goes through, on the current settings.
pub(in crate::domain::ws_session) fn notify_deferred_respawn(
    sender: &WsSender,
    envelope_id: &str,
    changes: &DispatchChanges,
) {
    let pending = deferred_changes(changes);
    if !pending.is_empty() {
        notify_change_deferred(sender, envelope_id, &pending);
    }
}

pub(in crate::domain::ws_session) fn dispatch_changes(handle: &SdkHandle) -> DispatchChanges {
    dispatch_changes_for_active(handle, matches!(&handle.state, QueryState::Active { .. }))
}

fn dispatch_changes_for_active(handle: &SdkHandle, is_active: bool) -> DispatchChanges {
    let model_changed = handle.desired_model != handle.spawned_model;
    let mode_changed = handle.desired_permission_mode != handle.spawned_permission_mode;
    let access_changed = handle.desired_access_mode != handle.spawned_access_mode;
    let effort_changed = handle.desired_thinking_effort != handle.spawned_thinking_effort;
    let profile_changed = handle.desired_claude_profile != handle.spawned_claude_profile;
    let overrides_changed = handle.config.runtime_overrides_dirty;
    DispatchChanges {
        model_changed,
        mode_changed,
        access_changed,
        effort_changed,
        profile_changed,
        overrides_changed,
        respawn_deferred: false,
        needs_respawn: is_active
            && (model_changed
                || mode_changed
                || access_changed
                || effort_changed
                || profile_changed
                || overrides_changed),
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
    context: &RuntimeCloseContext<'_>,
    db_session_id: i64,
) -> Option<String> {
    let QueryState::Active { query, .. } = &handle.state else {
        return None;
    };
    persist_and_close_query(
        query,
        context,
        db_session_id,
        &handle.runtime_provider,
        handle.feature_id,
    )
    .await
}

fn reset_handle_to_pending(handle: &mut SdkHandle, resume_session_id: Option<String>) {
    let options = RuntimeSpawnConfig {
        cwd: handle.config.cwd.clone(),
        permission_mode: handle.desired_permission_mode.clone(),
        access_mode: handle.desired_access_mode.clone(),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        fast_mode: handle.config.fast_mode,
        system_prompt: handle.config.system_prompt.clone(),
        resume_session_id,
        allow_bypass_permissions: handle.config.allow_bypass_permissions,
        env: handle.config.env.clone(),
        env_unset: handle.config.env_unset.clone(),
        profile: handle.config.claude_profile.clone(),
        overrides: handle.config.overrides.clone(),
        profile_revision: handle.config.profile_revision.clone(),
        profile_state_identity: handle.config.profile_state_identity.clone(),
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
    handle.config.runtime_overrides_dirty = false;
    handle.state = QueryState::Pending(options);
}

pub(in crate::domain::ws_session) fn log_dispatch_decision(
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
        respawn_deferred = changes.respawn_deferred,
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

    use super::super::super::state::SessionConfig;
    use super::*;

    fn pending_handle() -> SdkHandle {
        SdkHandle {
            identity: crate::domain::ws_session::runtime::state::RuntimeHandleIdentity::default(),
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
                fast_mode: false,
                system_prompt: None,
                allow_bypass_permissions: false,
                claude_profile: Some("bedrock".to_string()),
                env: None,
                env_unset: Vec::new(),
                overrides: Default::default(),
                runtime_overrides_dirty: false,
                profile_revision: None,
                profile_state_identity: None,
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
    fn provider_access_change_marks_active_runtime_for_respawn() {
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

    mod deferral {
        use std::sync::Arc;

        use super::super::super::runtime_hold_registry::{
            register, HoldRegistration, SharedRuntimeHold,
        };
        use super::*;
        use crate::domain::agents::adapter::{
            RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimePermissionMode,
        };
        use crate::domain::ws_session::handler::tests::support::{
            make_active_handle, make_test_app_state,
        };

        /// An active handle whose effort changed since spawn, with its runtime
        /// registered as running `live` background tasks.
        fn effort_changed_handle(db_session_id: i64, live: usize) -> (SdkHandle, HoldRegistration) {
            let mut handle = make_active_handle(1, Some("runtime-1".to_string()));
            handle.desired_thinking_effort = Some("high".to_string());
            let QueryState::Active { query, .. } = &handle.state else {
                unreachable!("make_active_handle is active");
            };
            let hold = SharedRuntimeHold::default();
            hold.observe(
                &RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                    .with_background_task_count(Some(live)),
            );
            let registration = register(db_session_id, &Arc::downgrade(query), &hold);
            (handle, registration)
        }

        #[tokio::test]
        async fn respawn_waits_while_the_runtime_owes_a_resume() {
            let app_state = make_test_app_state().await;
            let (mut handle, _registration) = effort_changed_handle(9201, 1);

            let changes = apply_respawn_if_needed(&mut handle, &app_state, 9201).await;

            assert!(
                matches!(handle.state, QueryState::Active { .. }),
                "closing the runtime would kill its background task"
            );
            assert!(changes.respawn_deferred && !changes.needs_respawn);
            assert_eq!(deferred_changes(&changes), ["reasoning effort"]);
        }

        #[tokio::test]
        async fn respawn_proceeds_once_the_runtime_is_free() {
            let app_state = make_test_app_state().await;
            let (mut handle, _registration) = effort_changed_handle(9202, 0);

            let changes = apply_respawn_if_needed(&mut handle, &app_state, 9202).await;

            assert!(matches!(handle.state, QueryState::Pending(_)));
            assert!(changes.needs_respawn && !changes.respawn_deferred);
            assert!(deferred_changes(&changes).is_empty());
        }

        #[tokio::test]
        async fn a_deferred_bypass_is_armed_by_the_respawn_once_the_runtime_is_free() {
            let app_state = make_test_app_state().await;
            crate::domain::workspace::repository::set_setting(
                &app_state.write_pool,
                "claude_bypass_permissions_enabled",
                "true",
            )
            .await
            .unwrap();
            let (mut handle, _registration) = effort_changed_handle(9203, 0);
            handle.desired_thinking_effort = None;
            handle.desired_permission_mode = Some(RuntimePermissionMode::BypassPermissions);

            let changes = apply_respawn_if_needed(&mut handle, &app_state, 9203).await;

            assert!(changes.mode_changed && changes.needs_respawn);
            let QueryState::Pending(options) = &handle.state else {
                panic!("the runtime is respawned into bypass");
            };
            assert!(options.allow_bypass_permissions);
            assert_eq!(
                options.permission_mode,
                Some(RuntimePermissionMode::BypassPermissions)
            );
        }

        #[test]
        fn a_deferred_model_change_needs_no_notice() {
            // model.set already switched the live runtime's model.
            let mut handle = pending_handle();
            handle.desired_claude_profile = None;
            handle.spawned_claude_profile = None;
            handle.desired_model = Some("opus".to_string());
            let mut changes = dispatch_changes_for_active(&handle, true);
            changes.needs_respawn = false;
            changes.respawn_deferred = true;

            assert!(deferred_changes(&changes).is_empty());
        }
    }
}
