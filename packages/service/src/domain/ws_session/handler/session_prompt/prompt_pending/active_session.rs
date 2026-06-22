use super::super::super::{QueryState, SdkHandle};
use super::super::bridge::PermissionResponse;
use super::PendingPromptContext;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use std::sync::Arc;
use tokio::sync::mpsc;

pub(super) async fn insert_active_session(
    context: &PendingPromptContext,
    query: RuntimeSessionHandle,
    permission_tx: mpsc::Sender<PermissionResponse>,
    runtime_control_endpoint: Option<String>,
) {
    let spawned_permission_mode = context.config.permission_mode.clone();
    let spawned_access_mode = context.config.access_mode.clone();
    let spawned_effort = context.spawned_thinking_effort.clone();
    let spawned_claude_profile = context.config.claude_profile.clone();
    let mut sessions = context.sdk_sessions.lock().await;
    sessions.insert(
        context.db_session_id,
        SdkHandle {
            state: QueryState::Active {
                query,
                permission_tx,
            },
            feature_id: context.feature_id,
            runtime_provider: context.provider_id.clone(),
            desired_model: context.spawned_model.clone(),
            spawned_model: context.spawned_model.clone(),
            desired_permission_mode: spawned_permission_mode.clone(),
            spawned_permission_mode,
            desired_access_mode: spawned_access_mode.clone(),
            spawned_access_mode,
            desired_thinking_effort: spawned_effort.clone(),
            spawned_thinking_effort: spawned_effort,
            desired_claude_profile: spawned_claude_profile.clone(),
            spawned_claude_profile,
            runtime_control_endpoint,
            resume_session_id: None,
            config: context.config.clone(),
            manual_compact_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            manual_compact_spawn_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        },
    );
}
