use super::super::super::QueryState;
use super::super::bridge::PermissionResponse;
use super::PendingPromptContext;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use tokio::sync::mpsc;

/// Install only the process that owns this Pending launch. Concurrent controls
/// update desired state in place; registration records spawned state separately.
pub(super) async fn insert_active_session(
    context: &PendingPromptContext,
    query: RuntimeSessionHandle,
    permission_tx: mpsc::Sender<PermissionResponse>,
    runtime_control_endpoint: Option<String>,
) -> bool {
    let mut sessions = context.sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&context.db_session_id) else {
        return false;
    };
    if !handle.identity.same_instance(&context.handle_identity)
        || !matches!(handle.state, QueryState::Pending(_))
        || handle.runtime_provider != context.provider_id
    {
        return false;
    }
    let same_config = handle.config.overrides == context.config.overrides
        && handle.config.claude_profile == context.config.claude_profile
        && handle.config.env == context.config.env
        && handle.config.env_unset == context.config.env_unset
        && handle.config.profile_revision == context.config.profile_revision
        && handle.config.profile_state_identity == context.config.profile_state_identity
        && handle.config.fast_mode == context.config.fast_mode
        && handle.config.system_prompt == context.config.system_prompt
        && handle.config.allow_bypass_permissions == context.config.allow_bypass_permissions;
    handle.state = QueryState::Active {
        query,
        permission_tx,
    };
    handle.spawned_model = context.spawned_model.clone();
    handle.spawned_permission_mode = context.config.permission_mode.clone();
    handle.spawned_access_mode = context.config.access_mode.clone();
    handle.spawned_thinking_effort = context.spawned_thinking_effort.clone();
    handle.spawned_claude_profile = context.config.claude_profile.clone();
    handle.runtime_control_endpoint = runtime_control_endpoint;
    handle.resume_session_id = None;
    handle.config.cwd = context.config.cwd.clone();
    handle.config.canonical_cwd = context.config.canonical_cwd.clone();
    handle.config.runtime_overrides_dirty = !same_config;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimePermissionMode,
        RuntimeSpawnConfig,
    };
    use crate::domain::ws_session::handler::tests::support::{
        make_in_place_effort_handle, make_test_app_state,
    };
    use crate::domain::ws_session::runtime::output::SessionOutput;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct ClosingRuntime(Arc<AtomicBool>);
    #[async_trait::async_trait]
    impl AgentRuntimeSession for ClosingRuntime {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            mpsc::channel(1).1
        }
        async fn session_id(&self) -> Option<String> {
            None
        }
        async fn stream_input(&self, _: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn close(&mut self) -> Result<(), RuntimeError> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn set_model(&self, _: &str) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_permission_mode(&self, _: RuntimePermissionMode) -> Result<(), RuntimeError> {
            Ok(())
        }
        fn pid(&self) -> Option<u32> {
            None
        }
    }

    async fn pending_context() -> PendingPromptContext {
        let state = make_test_app_state().await;
        let mut handle = make_in_place_effort_handle(1);
        let options = RuntimeSpawnConfig {
            cwd: "/tmp/test".into(),
            model: Some("launch-model".into()),
            ..Default::default()
        };
        handle.desired_model = options.model.clone();
        handle.state = QueryState::Pending(options.clone());
        let handle_identity = handle.identity.clone();
        let config = handle.config.clone();
        let sessions = super::super::super::super::state::new_sdk_sessions();
        sessions.lock().await.insert(7, handle);
        PendingPromptContext {
            envelope_id: "launch".into(),
            sender: SessionOutput::headless(),
            sdk_sessions: sessions,
            app_state: state,
            db_session_id: 7,
            feature_id: 1,
            provider_id: "opencode".into(),
            spawned_model: options.model.clone(),
            spawned_thinking_effort: None,
            config,
            options,
            payload: serde_json::from_value(
                serde_json::json!({"session_id": "7", "text": "first"}),
            )
            .unwrap(),
            permission_tx: Some(mpsc::channel(1).0),
            internal_replay: true,
            wait_for_delivery: true,
            spawn_claim: None,
            handle_identity,
        }
    }

    #[tokio::test]
    async fn delayed_registration_preserves_desired_controls_and_records_spawned_snapshot() {
        let context = pending_context().await;
        {
            let mut sessions = context.sdk_sessions.lock().await;
            let handle = sessions.get_mut(&7).unwrap();
            handle.desired_model = Some("next-model".into());
            handle.desired_permission_mode = Some(RuntimePermissionMode::BypassPermissions);
            handle.desired_claude_profile = Some("next-profile".into());
            handle.config.profile_revision = Some("next-revision".into());
            handle.config.overrides.model = Some("next-model".into());
            handle.config.runtime_overrides_dirty = true;
        }
        let query: RuntimeSessionHandle = Arc::new(tokio::sync::RwLock::new(Box::new(
            ClosingRuntime(Default::default()),
        )));
        assert!(insert_active_session(&context, query, mpsc::channel(1).0, None).await);
        let sessions = context.sdk_sessions.lock().await;
        let handle = sessions.get(&7).unwrap();
        assert_eq!(handle.desired_model.as_deref(), Some("next-model"));
        assert_eq!(handle.spawned_model.as_deref(), Some("launch-model"));
        assert_eq!(
            handle.desired_permission_mode,
            Some(RuntimePermissionMode::BypassPermissions)
        );
        assert_eq!(
            handle.spawned_permission_mode,
            context.config.permission_mode
        );
        assert_eq!(
            handle.desired_claude_profile.as_deref(),
            Some("next-profile")
        );
        assert_eq!(
            handle.config.profile_revision.as_deref(),
            Some("next-revision")
        );
        assert!(handle.config.runtime_overrides_dirty);
    }

    #[tokio::test]
    async fn delayed_runtime_for_destroyed_or_replaced_handle_is_closed_without_reinsertion() {
        for replace in [false, true] {
            let context = pending_context().await;
            {
                let mut sessions = context.sdk_sessions.lock().await;
                sessions.remove(&7);
                if replace {
                    let mut replacement = make_in_place_effort_handle(1);
                    replacement.state = QueryState::Pending(Default::default());
                    sessions.insert(7, replacement);
                }
            }
            let sessions = context.sdk_sessions.clone();
            let closed = Arc::new(AtomicBool::new(false));
            let result = super::super::runtime_registration::register_runtime(
                context,
                Box::new(ClosingRuntime(closed.clone())),
                true,
            )
            .await;
            assert!(result.is_err());
            assert!(closed.load(Ordering::SeqCst));
            let guard = sessions.lock().await;
            assert_eq!(guard.contains_key(&7), replace);
            assert!(!matches!(
                guard.get(&7).map(|handle| &handle.state),
                Some(QueryState::Active { .. })
            ));
        }
    }
}
