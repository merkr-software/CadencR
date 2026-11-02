//! Refresh pending ACP permission prompts when the gated tool input arrives
//! after `session/request_permission`.

use serde_json::Value;

use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata};

use super::permission_events::permission_raw_event;
use super::permissions::derive_preview;
use super::permissions_dispatch::{read_pending, write_pending, PendingPermissions};

pub async fn has_pending_permission_for_tool_call(
    pending: &PendingPermissions,
    tool_call_id: &str,
) -> bool {
    read_pending(pending)
        .values()
        .any(|entry| entry.request.tool_use_id.as_deref() == Some(tool_call_id))
}

pub async fn refreshed_permission_event_for_tool_input(
    pending: &PendingPermissions,
    session_id: Option<String>,
    tool_call_id: &str,
    tool_input: Value,
) -> Option<RuntimeEvent> {
    let (request, params) = {
        let mut pending = write_pending(pending);
        let Some(entry) = pending
            .values_mut()
            .find(|entry| entry.request.tool_use_id.as_deref() == Some(tool_call_id))
        else {
            return None;
        };
        if entry.request.tool_input == tool_input {
            return None;
        }
        entry.request.tool_input = tool_input;
        entry.request.preview = derive_preview(&entry.request.tool_input);
        (entry.request.clone(), entry.params.clone())
    };
    Some(RuntimeEvent::new(
        RuntimeEventMetadata {
            session_id,
            usage: None,
            context_window: None,
            raw: permission_raw_event(&request, &params),
        },
        RuntimeEventKind::Other,
    ))
}
