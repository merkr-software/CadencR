use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::*;

// One table owns the server action names and each action's actual wire payload.
macro_rules! session_events {
    ($($variant:ident($payload:ty) => $wire:tt),+ $(,)?) => {
        /// Canonical session-domain server action names. Legacy aliases are separate.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
        pub enum WsSessionAction {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl WsSessionAction {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }

            pub const fn all() -> &'static [Self] {
                &[$(Self::$variant),+]
            }
        }

        /// Session-domain server events, flattened beside the envelope id/domain/ref.
        #[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
        #[serde(tag = "action", content = "payload")]
        pub enum WsSessionEvent {
            $(#[serde(rename = $wire)] $variant($payload)),+
        }

        impl WsSessionEvent {
            pub(super) fn parts(&self) -> serde_json::Result<(WsSessionAction, serde_json::Value)> {
                match self {
                    $(Self::$variant(payload) => Ok((WsSessionAction::$variant, serde_json::to_value(payload)?))),+
                }
            }
        }
    };
}

session_events! {
    Initialized(SessionInitializedPayload) => "initialized",
    Acknowledged(SessionAcknowledgedPayload) => "acknowledged",
    Compacting(SessionCompactingPayload) => "compacting",
    FeatureRenamed(FeatureRenamedPayload) => "feature.renamed",
    FeatureAutonaming(FeatureAutoNamingPayload) => "feature.autonaming",
    BranchNeedsConfirm(BranchNeedsConfirmPayload) => "branch.needs_confirm",
    Message(SessionMessagePayload) => "message",
    UsageUpdate(SessionUsageUpdatePayload) => "usage_update",
    Ended(SessionEndedPayload) => "ended",
    Error(SessionErrorPayload) => "error",
    Warning(SessionWarningPayload) => "warning",
    Deleted(SessionDeletedPayload) => "deleted",
    Cleared(SessionClearedPayload) => "cleared",
    Lifecycle(SessionLifecyclePayload) => "lifecycle",
    RetryWorktreeSetupOk(RetryWorktreeSetupOkPayload) => "retry_worktree_setup.ok",
    GateClosed(GateClosedPayload) => "gate.closed",
    McpServers(SessionMcpServersPayload) => "mcp_servers",
    UserMessage(UserMessagePayload) => "user_message",
    HistoryResult(HistoryResultPayload) => "history.result",
    HistoryAdded(HistoryAddedPayload) => "history.added",
    DraftResult(DraftResultPayload) => "draft.result",
    DraftSaved(DraftSavedPayload) => "draft.saved",
    AccessModeChanged(ModeChangedPayload) => "access_mode.changed",
    ProviderSetOk(ProviderSetOkPayload) => "provider.set.ok",
    CompactStarted(SessionCompactStartedPayload) => "compact.started",
    ModelSetOk(ModelSetOkPayload) => "model.set.ok",
    EffortSetOk(EffortSetOkPayload) => "effort.set.ok",
    ConfigSnapshot(SessionConfigSnapshotPayload) => "config.snapshot",
    FastModeSetOk(FastModeSetOkPayload) => "fast_mode.set.ok",
    ModeChanged(ModeChangedPayload) => "mode.changed",
    ProfileChanged(ProfileChangedPayload) => "profile.changed",
    RuntimeOverridesChanged(RuntimeOverridesChangedPayload) => "runtime_overrides.changed",
    BranchRewound(BranchRewoundPayload) => "branch.rewound",
    BranchForked(BranchForkedPayload) => "branch.forked",
    RuntimeSessionId(RuntimeSessionIdPayload) => "runtime_session_id",
    PermissionRequest(PermissionRequestPayload) => "permission.request",
    PromptReceived(PromptReceivedPayload) => "prompt_received",
    StreamStatus(SessionStreamStatusPayload) => "stream_status",
    PersistenceStatus(SessionPersistenceStatusPayload) => "persistence_status",
    SubagentUpdated(crate::domain::subagents::SubagentRun) => "subagent_updated",
}

impl From<WsSessionAction> for String {
    fn from(action: WsSessionAction) -> Self {
        action.as_str().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_names_match_serde_and_are_unique() {
        let mut names = std::collections::HashSet::new();
        for action in WsSessionAction::all() {
            assert_eq!(serde_json::to_value(action).unwrap(), action.as_str());
            assert_eq!(
                serde_json::from_value::<WsSessionAction>(serde_json::json!(action.as_str()))
                    .unwrap(),
                *action,
            );
            assert!(names.insert(action.as_str()));
        }
        for legacy in [
            "compact.ok",
            "turn_complete",
            "codex_permission_mode.changed",
        ] {
            assert!(!names.contains(legacy));
        }
    }

    #[test]
    fn subagent_updates_round_trip_through_the_typed_contract() {
        let run = crate::domain::subagents::SubagentRun::launched()
            .session_id(42)
            .tool_use_id("spawn-child")
            .now("2026-10-31T00:00:00Z")
            .call();
        let event = WsSessionEvent::SubagentUpdated(run.clone());
        let envelope = WsEnvelope::session_event(&event).unwrap();
        assert_eq!(envelope.action, WsSessionAction::SubagentUpdated.as_str());
        assert_eq!(envelope.payload["sessionId"], 42);
        assert_eq!(envelope.payload["toolUseId"], "spawn-child");
        assert_eq!(envelope.payload["status"], "running");
        let decoded =
            serde_json::from_value::<WsSessionEvent>(serde_json::to_value(&event).unwrap())
                .unwrap();
        let WsSessionEvent::SubagentUpdated(decoded) = decoded else {
            panic!("sub-agent update must retain its canonical action");
        };
        assert_eq!(decoded, run);
    }

    #[test]
    fn typed_events_preserve_identity_sequence_raw_blocks_and_reply_refs() {
        let block = serde_json::json!({
            "provider_extension": {"new_field": [1, {"nested": true}]},
            "type": "future_provider_block",
        });
        let event = WsSessionEvent::Message(SessionMessagePayload {
            blocks: vec![block.clone()],
            seq: Some(9),
        });
        let reply = WsEnvelope::session_reply("request-42", &event).unwrap();
        assert_eq!(reply.domain, "session");
        assert_eq!(reply.action, "message");
        assert_eq!(reply.r#ref.as_deref(), Some("request-42"));
        assert!(!reply.id.is_empty());
        assert_eq!(
            reply.payload,
            serde_json::json!({"blocks": [block], "seq": 9})
        );
        let serialized = serde_json::to_value(&event).unwrap();
        assert_eq!(serialized["action"], reply.action);
        assert_eq!(serialized["payload"], reply.payload);
        let parsed: WsSessionEvent = serde_json::from_value(serialized).unwrap();
        let broadcast = WsEnvelope::session_event(&parsed).unwrap();
        assert_eq!(broadcast.r#ref, None);
        assert_eq!(broadcast.payload, reply.payload);
        assert_ne!(broadcast.id, reply.id);
    }

    #[test]
    fn typed_events_preserve_null_omission_and_camel_case_fields() {
        let compact = WsEnvelope::session_event(&WsSessionEvent::CompactStarted(
            SessionCompactStartedPayload,
        ))
        .unwrap();
        assert_eq!(compact.action, "compact.started");
        assert_eq!(compact.payload, serde_json::Value::Null);
        let cleared = WsEnvelope::session_event(&WsSessionEvent::Cleared(SessionClearedPayload {
            session_id: "42".into(),
            previous_session_id: None,
        }))
        .unwrap();
        assert_eq!(
            cleared.payload,
            serde_json::json!({"session_id": "42", "previous_session_id": null})
        );
        let draft = WsEnvelope::session_event(&WsSessionEvent::DraftResult(DraftResultPayload {
            draft: None,
        }))
        .unwrap();
        assert_eq!(draft.payload, serde_json::json!({"draft": null}));
        let message = WsEnvelope::session_event(&WsSessionEvent::Message(SessionMessagePayload {
            blocks: vec![],
            seq: None,
        }))
        .unwrap();
        assert_eq!(message.payload, serde_json::json!({"blocks": []}));
        let branch = WsEnvelope::session_event(&WsSessionEvent::BranchNeedsConfirm(
            BranchNeedsConfirmPayload {
                session_id: "42".into(),
                message_id: 7,
                kind: "rewind".into(),
                reason: "confirm".into(),
            },
        ))
        .unwrap();
        assert_eq!(branch.action, "branch.needs_confirm");
        assert_eq!(
            branch.payload,
            serde_json::json!({"sessionId": "42", "messageId": 7, "kind": "rewind", "reason": "confirm"})
        );
    }

    #[test]
    fn production_session_emitters_use_typed_contract_constructors() {
        let raw_session =
            regex_lite::Regex::new(r#"WsEnvelope::(?:new|reply)\(\s*(?:[^,]+,\s*)?"session"\s*,"#)
                .unwrap();
        let mut directories = vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(directory) = directories.pop() {
            for entry in std::fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    if path.file_name().unwrap() != "tests" {
                        directories.push(path);
                    }
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    let source = std::fs::read_to_string(&path).unwrap();
                    let production = source.split("#[cfg(test)]").next().unwrap();
                    assert!(
                        !raw_session.is_match(production),
                        "{} must emit typed session events or commands",
                        path.display()
                    );
                }
            }
        }
    }
}
