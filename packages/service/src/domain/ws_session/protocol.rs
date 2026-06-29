use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::agents::adapter::RuntimePermissionDecision;

/// Permission decision from the client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowFuture,
    Deny,
}

impl PermissionDecision {
    pub fn to_runtime_decision(&self, option_id: Option<&str>) -> RuntimePermissionDecision {
        match self {
            Self::AllowOnce => RuntimePermissionDecision::AllowOnce,
            Self::AllowFuture if is_allow_for_session_option(option_id) => {
                RuntimePermissionDecision::AllowForSession
            }
            Self::AllowFuture => RuntimePermissionDecision::AllowFuture,
            Self::Deny => RuntimePermissionDecision::Deny,
        }
    }
}

fn is_allow_for_session_option(option_id: Option<&str>) -> bool {
    matches!(option_id, Some("allow_for_session" | "session"))
}

/// Envelope — every message in both directions uses this shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsEnvelope {
    pub id: String,
    pub domain: String,
    pub action: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    pub payload: serde_json::Value,
}

impl WsEnvelope {
    pub fn new(
        domain: impl Into<String>,
        action: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            domain: domain.into(),
            action: action.into(),
            r#ref: None,
            payload,
        }
    }

    pub fn reply(
        original_id: &str,
        domain: impl Into<String>,
        action: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            domain: domain.into(),
            action: action.into(),
            r#ref: Some(original_id.to_string()),
            payload,
        }
    }

    pub fn parse_action(&self) -> anyhow::Result<(&str, &str)> {
        if self.domain.is_empty() {
            anyhow::bail!("domain is required");
        }
        if self.action.is_empty() {
            anyhow::bail!("action is required");
        }
        Ok((&self.domain, &self.action))
    }
}

impl TryFrom<String> for WsEnvelope {
    type Error = anyhow::Error;

    fn try_from(value: String) -> anyhow::Result<Self> {
        let envelope: WsEnvelope = serde_json::from_str(&value)?;
        if envelope.domain.is_empty() {
            anyhow::bail!("domain is required");
        }
        if envelope.action.is_empty() {
            anyhow::bail!("action is required");
        }
        Ok(envelope)
    }
}

impl From<WsEnvelope> for String {
    fn from(envelope: WsEnvelope) -> Self {
        serde_json::to_string(&envelope).expect("WsEnvelope should always serialize")
    }
}

mod client;
mod commands;
mod server;

pub use client::*;
pub use commands::*;
pub use server::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_decision_to_runtime_maps_allow_once_and_deny() {
        assert_eq!(
            PermissionDecision::AllowOnce.to_runtime_decision(None),
            RuntimePermissionDecision::AllowOnce
        );
        assert_eq!(
            PermissionDecision::Deny.to_runtime_decision(Some("deny")),
            RuntimePermissionDecision::Deny
        );
    }

    #[test]
    fn permission_decision_to_runtime_maps_allow_future_variants_by_option_id() {
        assert_eq!(
            PermissionDecision::AllowFuture.to_runtime_decision(Some("allow_for_session")),
            RuntimePermissionDecision::AllowForSession
        );
        assert_eq!(
            PermissionDecision::AllowFuture.to_runtime_decision(Some("session")),
            RuntimePermissionDecision::AllowForSession
        );
        assert_eq!(
            PermissionDecision::AllowFuture.to_runtime_decision(Some("allow_always")),
            RuntimePermissionDecision::AllowFuture
        );
    }

    #[test]
    fn test_envelope_roundtrip() {
        let env = WsEnvelope::new("session", "init", serde_json::json!({"model": "opus"}));
        let json: String = env.clone().into();
        let parsed = WsEnvelope::try_from(json).unwrap();
        assert_eq!(parsed.domain, "session");
        assert_eq!(parsed.action, "init");
        assert_eq!(parsed.payload, serde_json::json!({"model": "opus"}));
    }

    #[test]
    fn test_try_from_valid() {
        let json = serde_json::json!({
            "id": "abc",
            "domain": "agent",
            "action": "prompt.send",
            "payload": {}
        })
        .to_string();
        let env = WsEnvelope::try_from(json).unwrap();
        assert_eq!(env.id, "abc");
        assert_eq!(env.domain, "agent");
    }

    #[test]
    fn test_try_from_missing_domain() {
        let json = serde_json::json!({
            "id": "abc",
            "domain": "",
            "action": "init",
            "payload": {}
        })
        .to_string();
        assert!(WsEnvelope::try_from(json).is_err());
    }

    #[test]
    fn test_try_from_missing_action() {
        let json = serde_json::json!({
            "id": "abc",
            "domain": "session",
            "action": "",
            "payload": {}
        })
        .to_string();
        assert!(WsEnvelope::try_from(json).is_err());
    }

    #[test]
    fn test_try_from_invalid_json() {
        assert!(WsEnvelope::try_from("not json".to_string()).is_err());
    }

    #[test]
    fn test_reply_sets_ref() {
        let original = WsEnvelope::new("session", "init", serde_json::json!({}));
        let reply = WsEnvelope::reply(
            &original.id,
            "session",
            "initialized",
            serde_json::json!({}),
        );
        assert_eq!(reply.r#ref.as_deref(), Some(original.id.as_str()));
    }

    #[test]
    fn test_payload_types_roundtrip() {
        // SessionInitPayload
        let p = SessionInitPayload {
            provider: None,
            model: Some("opus".into()),
            thinking_effort: None,
            permission_mode: None,
            system_prompt: None,
            cwd: Some("/tmp".into()),
            feature_id: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: SessionInitPayload = serde_json::from_value(v).unwrap();

        // PromptSendPayload
        let p = PromptSendPayload {
            session_id: "s1".into(),
            text: "hello".into(),
            profile: None,
            claude_profile: None,
            images: vec![],
            attachments: vec![],
            use_worktree: None,
            new_project_branch: None,
            client_message_id: None,
            user_message_ref: None,
            replay: false,
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: PromptSendPayload = serde_json::from_value(v).unwrap();

        // CommandsGetPayload
        let p = CommandsGetPayload {
            cwd: "/tmp".into(),
            provider: "codex_cli".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: CommandsGetPayload = serde_json::from_value(v).unwrap();

        // PermissionRespondPayload
        let p = PermissionRespondPayload {
            session_id: "s1".into(),
            request_id: "r1".into(),
            decision: PermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: PermissionRespondPayload = serde_json::from_value(v).unwrap();

        // SessionInitializedPayload
        let p = SessionInitializedPayload {
            session_id: "s1".into(),
            provider: None,
            model: None,
            thinking_effort: None,
            profile: None,
            codex_permission_mode: None,
            input_tokens: None,
            output_tokens: None,
            context_window: None,
            supports_prompt_receipts: false,
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: SessionInitializedPayload = serde_json::from_value(v).unwrap();

        // SessionMessagePayload
        let p = SessionMessagePayload {
            blocks: vec![serde_json::json!({"type": "text"})],
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: SessionMessagePayload = serde_json::from_value(v).unwrap();

        // PermissionRequestPayload
        let p = PermissionRequestPayload {
            request_id: "r1".into(),
            tool_name: "bash".into(),
            tool_input: serde_json::json!({}),
            description: Some("run cmd".into()),
            pattern: None,
            preview: Some("ls".into()),
            options: vec![PermissionOptionPayload {
                decision: PermissionDecision::AllowOnce,
                option_id: None,
                label: "Allow once".into(),
                description: "Approve this tool call only".into(),
                collect_feedback: false,
            }],
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: PermissionRequestPayload = serde_json::from_value(v).unwrap();

        // ModeSetPayload
        let p = ModeSetPayload {
            session_id: "s1".into(),
            mode: "plan".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: ModeSetPayload = serde_json::from_value(v).unwrap();

        // SessionErrorPayload
        let p = SessionErrorPayload {
            code: "ERR".into(),
            message: "bad".into(),
            mode: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: SessionErrorPayload = serde_json::from_value(v).unwrap();

        // SessionEndedPayload
        let p = SessionEndedPayload {
            reason: "done".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        let _: SessionEndedPayload = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn test_permission_decision_serialization() {
        assert_eq!(
            serde_json::to_value(&PermissionDecision::AllowOnce).unwrap(),
            "allow_once"
        );
        assert_eq!(
            serde_json::to_value(&PermissionDecision::AllowFuture).unwrap(),
            "allow_future"
        );
        assert_eq!(
            serde_json::to_value(&PermissionDecision::Deny).unwrap(),
            "deny"
        );
    }

    #[test]
    fn test_permission_decision_deserialization() {
        let d: PermissionDecision =
            serde_json::from_value(serde_json::json!("allow_once")).unwrap();
        assert_eq!(d, PermissionDecision::AllowOnce);
        let d: PermissionDecision = serde_json::from_value(serde_json::json!("deny")).unwrap();
        assert_eq!(d, PermissionDecision::Deny);
    }

    #[test]
    fn test_permission_decision_invalid_variant() {
        let result = serde_json::from_value::<PermissionDecision>(serde_json::json!("invalid"));
        assert!(result.is_err());
    }

    #[test]
    fn prompt_send_parses_new_project_branch() {
        // "From branch": present with an explicit base ref.
        let with_base: PromptSendPayload = serde_json::from_value(serde_json::json!({
            "session_id": "s1",
            "text": "hi",
            "new_project_branch": { "base": "develop" },
        }))
        .unwrap();
        assert_eq!(
            with_base.new_project_branch.unwrap().base.as_deref(),
            Some("develop")
        );

        // Present with null base → fork from current HEAD.
        let from_head: PromptSendPayload = serde_json::from_value(serde_json::json!({
            "session_id": "s1",
            "text": "hi",
            "new_project_branch": { "base": null },
        }))
        .unwrap();
        let branch = from_head.new_project_branch.expect("should be present");
        assert!(branch.base.is_none());

        // Absent → not the "from branch" flow.
        let absent: PromptSendPayload = serde_json::from_value(serde_json::json!({
            "session_id": "s1",
            "text": "hi",
        }))
        .unwrap();
        assert!(absent.new_project_branch.is_none());
    }

    #[test]
    fn commands_get_payload_requires_provider() {
        let error =
            serde_json::from_value::<CommandsGetPayload>(serde_json::json!({"cwd": "/tmp"}))
                .expect_err("provider should be required");

        assert!(error.to_string().contains("provider"));
    }

    #[test]
    fn test_envelope_requires_id_field() {
        // Envelopes missing the `id` field must fail deserialization
        let json = serde_json::json!({
            "domain": "session",
            "action": "init",
            "payload": { "feature_id": 1 }
        })
        .to_string();
        let result = WsEnvelope::try_from(json);
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(
            err.contains("id"),
            "error should mention missing id field: {err}"
        );
    }
}
