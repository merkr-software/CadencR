//! Agent-initiated permission-mode switches.
//!
//! An ACP agent may change its own mode (`current_mode_update`, or a
//! mode-category `config_option_update`). When the provider maps that mode
//! back to a host mode, the runtime emits `PermissionModeChanged`; this keeps
//! the session handle, the persisted mode, and every viewer's composer chip in
//! step with the agent instead of the last value the user picked.

use axum::extract::ws::Message;
use tracing::debug;

use super::stream_reader_forward::ForwardOutcome;
use super::stream_reader_task::StreamReaderTask;
use crate::domain::agents::adapter::RuntimePermissionMode;
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{ModeChangedPayload, WsEnvelope, WsSessionEvent};
use crate::domain::ws_session::runtime::post_plan_mode::apply_post_plan_mode_to_handle;

pub(super) async fn forward_agent_mode_change(
    task: &StreamReaderTask,
    mode: &RuntimePermissionMode,
) -> ForwardOutcome {
    let changed = {
        let mut sessions = task.sdk_sessions.lock().await;
        match sessions.get_mut(&task.db_session_id) {
            Some(handle) if handle.desired_permission_mode.as_ref() != Some(mode) => {
                apply_post_plan_mode_to_handle(handle, mode.clone());
                true
            }
            _ => false,
        }
    };
    if !changed {
        return ForwardOutcome::Suppressed;
    }
    let wire = permission_mode_wire(mode);
    debug!(task.db_session_id, mode = %wire, "agent switched its permission mode");
    WsSessionPersistence::update_permission_mode_static(
        &task.write_pool,
        task.db_session_id,
        &wire,
    )
    .await;
    let envelope = WsEnvelope::session_event(&WsSessionEvent::ModeChanged(ModeChangedPayload {
        mode: wire,
    }))
    .expect("mode changed payload should serialize");
    if task
        .send_and_mirror(Message::Text(String::from(envelope).into()))
        .await
    {
        return ForwardOutcome::SenderClosed;
    }
    ForwardOutcome::Forwarded
}
