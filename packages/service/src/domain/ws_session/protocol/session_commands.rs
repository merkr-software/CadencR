use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::*;

// Keep the generated command schema and the runtime routing names in one table.
// Handlers retain payload parsing so their established error codes and defaults
// (including retry_worktree_setup's MISSING_FEATURE_ID) remain unchanged.
macro_rules! session_commands {
    ($($variant:ident($payload:ty) => $wire:tt),+ $(,)?) => {
        /// Session-domain client commands, flattened beside the envelope id/domain.
        #[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
        #[serde(tag = "action", content = "payload")]
        pub enum WsSessionCommand {
            $(#[serde(rename = $wire)] $variant($payload)),+
        }

        impl WsSessionCommand {
            pub(super) fn parts(&self) -> serde_json::Result<(&'static str, serde_json::Value)> {
                match self {
                    $(Self::$variant(payload) => Ok(($wire, serde_json::to_value(payload)?))),+
                }
            }
        }

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum WsSessionCommandAction {
            $($variant),+
        }

        impl WsSessionCommandAction {
            pub fn from_wire_name(action: &str) -> Option<Self> {
                match action {
                    $($wire => Some(Self::$variant)),+,
                    _ => None,
                }
            }
        }
    };
}

session_commands! {
    Init(SessionInitPayload) => "init",
    PromptSend(PromptSendPayload) => "prompt.send",
    PermissionRespond(PermissionRespondPayload) => "permission.respond",
    GateClose(GateClosePayload) => "gate.close",
    ProviderSet(ProviderSetPayload) => "provider.set",
    ModelSet(ModelSetPayload) => "model.set",
    ModeSet(ModeSetPayload) => "mode.set",
    AccessModeSet(AccessModeSetPayload) => "access_mode.set",
    EffortSet(EffortSetPayload) => "effort.set",
    ConfigGet(SessionActionPayload) => "config.get",
    ConfigSet(SessionConfigSetPayload) => "config.set",
    FastModeSet(FastModeSetPayload) => "fast_mode.set",
    ProfileSet(ProfileSetPayload) => "profile.set",
    RuntimeOverridesSet(RuntimeOverridesSetPayload) => "runtime_overrides.set",
    Interrupt(SessionActionPayload) => "interrupt",
    BranchRewind(BranchPayload) => "branch.rewind",
    BranchFork(BranchPayload) => "branch.fork",
    Suspend(SessionActionPayload) => "suspend",
    Resume(SessionActionPayload) => "resume",
    Destroy(SessionActionPayload) => "destroy",
    Compact(SessionActionPayload) => "compact",
    Delete(SessionActionPayload) => "delete",
    Clear(SessionActionPayload) => "clear",
    HistoryGet(HistoryGetPayload) => "history.get",
    HistoryAdd(HistoryAddPayload) => "history.add",
    DraftGet(DraftGetPayload) => "draft.get",
    DraftSave(DraftSavePayload) => "draft.save",
    RetryWorktreeSetup(RetryWorktreeSetupPayload) => "retry_worktree_setup",
}

/// Older clients used this provider-specific name for the shared access command.
/// It remains accepted without becoming part of the canonical generated contract.
pub fn canonical_session_command_action(action: &str) -> Option<WsSessionCommandAction> {
    match action {
        "codex_permission_mode.set" => Some(WsSessionCommandAction::AccessModeSet),
        other => WsSessionCommandAction::from_wire_name(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagged_commands_reuse_existing_payload_defaults() {
        let wire = serde_json::json!({
            "action": "prompt.send",
            "payload": {"session_id": "42", "text": "hello"},
        });
        let command: WsSessionCommand = serde_json::from_value(wire).unwrap();
        let WsSessionCommand::PromptSend(payload) = &command else {
            panic!("prompt.send must select PromptSendPayload");
        };
        assert!(payload.images.is_empty());
        assert!(payload.attachments.is_empty());
        assert_eq!(payload.message_uuid, None);
        assert!(!payload.track_prompt_receipt);
        let serialized = serde_json::to_value(command).unwrap();
        assert_eq!(serialized["action"], "prompt.send");
        assert_eq!(serialized["payload"]["text"], "hello");
        assert!(serde_json::from_value::<WsSessionCommand>(serialized).is_ok());

        let branch: WsSessionCommand = serde_json::from_value(serde_json::json!({
            "action": "branch.rewind",
            "payload": {"session_id": "42", "message_id": 7},
        }))
        .unwrap();
        let WsSessionCommand::BranchRewind(payload) = branch else {
            panic!("branch.rewind must select BranchPayload");
        };
        assert!(!payload.confirm_discard);
    }

    #[test]
    fn tagged_commands_reject_unknown_actions_and_malformed_payloads() {
        for wire in [
            serde_json::json!({"action": "future.command", "payload": {}}),
            serde_json::json!({"action": "prompt.send", "payload": {"session_id": "42"}}),
            serde_json::json!({"action": "draft.get", "payload": {"session_id": "42"}}),
            serde_json::json!({"action": "model.set", "payload": null}),
        ] {
            assert!(serde_json::from_value::<WsSessionCommand>(wire).is_err());
        }
    }

    #[test]
    fn legacy_access_mode_action_routes_without_entering_canonical_schema() {
        assert_eq!(
            canonical_session_command_action("codex_permission_mode.set"),
            Some(WsSessionCommandAction::AccessModeSet),
        );
        assert_eq!(canonical_session_command_action("unknown"), None);
        assert!(
            serde_json::from_value::<WsSessionCommand>(serde_json::json!({
                "action": "codex_permission_mode.set",
                "payload": {"session_id": "42", "mode": "default"},
            }))
            .is_err()
        );
    }
}
