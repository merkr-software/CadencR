//! Agent-initiated permission-mode changes, kept beside `event.rs` so that
//! file stays under the size ceiling.

use serde_json::json;

use super::config::RuntimePermissionMode;
use super::event_types::{RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata};

impl RuntimeEvent {
    /// The agent switched itself into `mode` (already mapped to the host id).
    pub fn permission_mode_changed_event(
        session_id: Option<String>,
        mode: RuntimePermissionMode,
    ) -> Self {
        Self::new(
            RuntimeEventMetadata {
                session_id,
                raw: json!({ "type": "permission_mode_changed" }),
                ..RuntimeEventMetadata::default()
            },
            RuntimeEventKind::PermissionModeChanged { mode },
        )
    }

    pub fn permission_mode_changed(&self) -> Option<&RuntimePermissionMode> {
        match &self.kind {
            RuntimeEventKind::PermissionModeChanged { mode } => Some(mode),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::config::RuntimePermissionMode;
    use super::super::event_types::RuntimeEvent;

    #[test]
    fn mode_change_events_round_trip_their_mode() {
        let event = RuntimeEvent::permission_mode_changed_event(
            Some("s-1".into()),
            RuntimePermissionMode::Plan,
        );
        assert_eq!(
            event.permission_mode_changed(),
            Some(&RuntimePermissionMode::Plan)
        );
        assert_eq!(event.session_id(), Some("s-1"));
        assert!(!event.is_result());
    }
}
