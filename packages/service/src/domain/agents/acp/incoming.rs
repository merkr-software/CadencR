//! Typed inbound envelopes for ACP notifications and server-initiated
//! requests.
//!
//! Cadencr keeps the raw JSON around so OpenCode-style provider extensions
//! (object-shaped `env`, `parentToolCallId`, etc.) survive routing even
//! when they fail the official-schema deserializer.
//!
//! Server-requests cache an `Option<AgentRequest>` typed parse alongside
//! the raw `Value`; handlers prefer typed and fall back to raw. Session-
//! update notifications stay raw-only — every variant we route has an
//! extension the strict schema would drop, so a typed parse would always
//! lose data.

use agent_client_protocol::{schema::v1::AgentRequest, JsonRpcMessage};
use serde_json::Value;

/// Inbound one-way notification from the agent. `Extension` covers
/// proprietary methods like `current_mode_update` from older agents.
#[derive(Debug, Clone)]
pub enum AcpNotification {
    SessionUpdate { raw: Value },
    Extension { method: String, params: Value },
}

/// Inbound request from the agent. `Known` covers schema-modeled methods
/// (FS, terminal, permission); `typed` is populated when the params
/// deserialize cleanly, and `raw` is always kept for the extension fallback.
#[derive(Debug, Clone)]
pub enum AcpServerRequest {
    Known {
        id: Value,
        method: String,
        raw: Value,
        typed: Option<AgentRequest>,
    },
    Extension {
        id: Value,
        method: String,
        params: Value,
    },
}

impl AcpNotification {
    pub fn from_parts(method: String, params: Value) -> Self {
        match method.as_str() {
            "session/update" => Self::SessionUpdate { raw: params },
            _ => Self::Extension { method, params },
        }
    }

    pub(crate) fn params(&self) -> &Value {
        match self {
            Self::SessionUpdate { raw, .. } => raw,
            Self::Extension { params, .. } => params,
        }
    }
}

impl AcpServerRequest {
    pub fn from_parts(id: Value, method: String, params: Value) -> Self {
        match method.as_str() {
            "session/request_permission" | "fs/read_text_file" | "fs/write_text_file" => {
                let typed = AgentRequest::parse_message(&method, &params).ok();
                Self::Known {
                    id,
                    method,
                    raw: params,
                    typed,
                }
            }
            // Terminal traffic stays raw: OpenCode sends provider extensions
            // such as object-shaped `env`, and the runtime terminal registry
            // already consumes the raw ACP-compatible payload directly.
            "terminal/create"
            | "terminal/output"
            | "terminal/wait_for_exit"
            | "terminal/kill"
            | "terminal/release" => Self::Known {
                id,
                method,
                raw: params,
                typed: None,
            },
            _ => Self::Extension { id, method, params },
        }
    }

    pub(crate) fn id(&self) -> &Value {
        match self {
            Self::Known { id, .. } | Self::Extension { id, .. } => id,
        }
    }

    pub(crate) fn method(&self) -> &str {
        match self {
            Self::Known { method, .. } | Self::Extension { method, .. } => method,
        }
    }

    pub(crate) fn params(&self) -> &Value {
        match self {
            Self::Known { raw, .. } | Self::Extension { params: raw, .. } => raw,
        }
    }

    pub(crate) fn typed_as<T>(&self, extract: fn(&AgentRequest) -> Option<&T>) -> Option<&T> {
        match self {
            Self::Known {
                typed: Some(typed), ..
            } => extract(typed),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AcpNotification, AcpServerRequest};
    use agent_client_protocol::schema::v1::AgentRequest;
    use serde_json::json;

    #[test]
    fn session_update_envelope_preserves_raw_params_verbatim() {
        let notification = AcpNotification::from_parts(
            "session/update".to_string(),
            json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t-1",
                    "title": "Bash",
                    "parentToolCallId": "parent-1"
                }
            }),
        );

        let AcpNotification::SessionUpdate { raw } = notification else {
            panic!("expected session update");
        };
        // Raw must survive routing intact — downstream mappers depend on
        // OpenCode extensions (`parentToolCallId` here) that the strict
        // schema would silently drop.
        assert_eq!(raw["sessionId"], "s-1");
        assert_eq!(raw["update"]["parentToolCallId"], "parent-1");
    }

    #[test]
    fn unknown_notification_method_falls_through_to_extension() {
        let notification =
            AcpNotification::from_parts("_opencode/custom".to_string(), json!({ "foo": "bar" }));
        let AcpNotification::Extension { method, params } = notification else {
            panic!("expected extension notification");
        };
        assert_eq!(method, "_opencode/custom");
        assert_eq!(params["foo"], "bar");
    }

    #[test]
    fn parses_schema_clean_fs_read_request_to_typed_agent_request() {
        let request = AcpServerRequest::from_parts(
            json!("req-1"),
            "fs/read_text_file".to_string(),
            json!({
                "sessionId": "s-1",
                "path": "/tmp/file.txt",
                "line": 1,
                "limit": 5
            }),
        );

        let AcpServerRequest::Known { typed, raw, .. } = request else {
            panic!("expected known request");
        };
        assert_eq!(raw["path"], "/tmp/file.txt");
        assert!(matches!(
            typed.unwrap(),
            AgentRequest::ReadTextFileRequest(_)
        ));
    }

    #[test]
    fn preserves_raw_known_request_when_opencode_extension_prevents_schema_parse() {
        let request = AcpServerRequest::from_parts(
            json!("term-1"),
            "terminal/create".to_string(),
            json!({
                "command": "sh",
                "args": ["-c", "echo ok"],
                "env": { "ACP_PARITY": "ok" },
                "outputByteLimit": 64
            }),
        );

        let AcpServerRequest::Known { typed, raw, .. } = request else {
            panic!("expected known request");
        };
        assert!(typed.is_none());
        assert_eq!(raw["env"]["ACP_PARITY"], "ok");
    }

    #[test]
    fn terminal_create_skips_typed_parse_even_for_schema_clean_payload() {
        let request = AcpServerRequest::from_parts(
            json!("term-2"),
            "terminal/create".to_string(),
            json!({
                "sessionId": "s-1",
                "command": "sh",
                "args": ["-c", "echo ok"],
                "env": [{ "name": "ACP_PARITY", "value": "ok" }],
                "outputByteLimit": 64
            }),
        );

        let AcpServerRequest::Known { typed, raw, .. } = request else {
            panic!("expected known request");
        };
        assert!(typed.is_none());
        assert_eq!(raw["env"][0]["name"], "ACP_PARITY");
    }
}
