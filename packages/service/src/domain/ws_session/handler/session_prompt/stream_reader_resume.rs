use tracing::info;

use crate::domain::agents::adapter::{RuntimeSessionWeakHandle, RuntimeSpawnConfig};

use super::super::session_init_resume::persistable_resume_session_id_for_provider;
use super::super::{QueryState, SdkSessions};

pub(super) async fn transition_active_to_pending_on_stream_end(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    ended_runtime: Option<&RuntimeSessionWeakHandle>,
    cleanup_session_on_end: bool,
) {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return;
    };
    let QueryState::Active { ref query, .. } = handle.state else {
        return;
    };
    // A stop can be followed immediately by a new message that spawns a
    // replacement runtime before this older reader finishes. Never transition
    // or clean up that newer runtime from the stale task.
    if ended_runtime.is_some_and(|ended_runtime| {
        !std::sync::Weak::ptr_eq(&std::sync::Arc::downgrade(query), ended_runtime)
    }) {
        info!(
            db_session_id,
            "ended stream belongs to a superseded runtime; keeping current Active handle"
        );
        return;
    }
    if cleanup_session_on_end {
        sessions.remove(&db_session_id);
        return;
    }
    let q = query.read().await;
    let runtime_session_id = q.session_id().await;
    let resume_session_id = persistable_resume_session_id_for_provider(
        &handle.runtime_provider,
        runtime_session_id.as_deref(),
    );
    handle.runtime_control_endpoint = q.runtime_control_endpoint();
    drop(q);

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

    info!(
        db_session_id,
        "stream ended, transitioning Active -> Pending for resume"
    );
    handle.state = QueryState::Pending(options);
}
