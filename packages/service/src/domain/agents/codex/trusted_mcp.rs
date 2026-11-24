//! Codex's side of first-party MCP tool approval.
//!
//! Codex names a server's tools by its config key with `-` folded to `_`
//! (`mcp__cadencr_browser__`), so a foreign `cadencr_browser` server would
//! produce the same namespace. [`mcp_trust`] therefore revokes trust when
//! the effective Codex config holds such a server; a server under Cadencr's
//! exact key is replaced by the thread config Cadencr starts the thread with.

use serde_json::Value;

use super::permissions::permission_request;
use super::server_request_method::CodexServerRequestMethod;
use crate::domain::agents::adapter::{
    RuntimePermissionDecision, RuntimePermissionResponse, RuntimeSpawnConfig,
};
use crate::domain::mcp::trusted::CadencrMcpTrust;

/// Only the root turn for which Auto Review was requested can use the expanded policy.
#[derive(Default)]
pub(super) enum McpApprovalTurn {
    #[default]
    Disabled,
    Starting,
    Active(String),
}

impl McpApprovalTurn {
    pub fn start(&mut self, automatic: bool) {
        *self = if automatic {
            Self::Starting
        } else {
            Self::Disabled
        };
    }

    pub fn started(&mut self, id: &str) {
        if matches!(self, Self::Starting) && !id.is_empty() {
            *self = Self::Active(id.to_owned());
        }
    }

    pub fn completed(&mut self, id: Option<&str>) {
        if id.is_none() || self.allows(id) {
            *self = Self::Disabled;
        }
    }

    pub fn allows(&self, id: Option<&str>) -> bool {
        matches!(self, Self::Active(active) if Some(active.as_str()) == id)
    }
}

/// The Cadencr MCP servers trusted in this Codex thread. `effective` is Codex's
/// `config/read` result; its MCP servers that Cadencr's thread config does
/// not replace are foreign.
pub(super) fn mcp_trust(config: &RuntimeSpawnConfig, effective: &Value) -> CadencrMcpTrust {
    let injected = config.mcp_servers.as_ref();
    let native = effective.get("config").unwrap_or(effective);
    let foreign = native
        .get("mcp_servers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|servers| servers.keys())
        .map(String::as_str)
        .filter(|name| !injected.is_some_and(|servers| servers.contains_key(*name)));
    CadencrMcpTrust::injected_in(injected).shadowed_by(foreign)
}

/// Only MCP elicitations can carry a Cadencr MCP tool call: Codex asks for
/// MCP tool approval through `mcpServer/elicitation/request`, and requests
/// outside the app-server schema never reach this check (they are rejected).
pub(super) fn trusted_mcp_permission_response(
    trust: CadencrMcpTrust,
    automatic: bool,
    id: &Value,
    method: CodexServerRequestMethod,
    params: &Value,
) -> Option<RuntimePermissionResponse> {
    if method != CodexServerRequestMethod::McpElicitation
        || !is_trusted_elicitation(trust, params, automatic)
    {
        return None;
    }
    let request = permission_request(id, method, params);
    Some(RuntimePermissionResponse {
        request_id: request.request_id,
        decision: RuntimePermissionDecision::AllowOnce,
        option_id: request
            .options
            .iter()
            .find(|option| option.decision == RuntimePermissionDecision::AllowOnce)
            .and_then(|option| option.option_id.clone()),
        feedback: None,
        updated_input: None,
    })
}

/// An elicitation names the server by its exact config key.
fn is_trusted_elicitation(trust: CadencrMcpTrust, params: &Value, automatic: bool) -> bool {
    let Some(server) = params.get("serverName").and_then(Value::as_str) else {
        return false;
    };
    let meta = params.get("_meta").or_else(|| params.get("meta"));
    let meta_tool = meta
        .and_then(|value| value.get("tool_name"))
        .and_then(Value::as_str);
    let message_tool = params
        .get("message")
        .and_then(Value::as_str)
        .and_then(quoted_tool_from_message);
    meta_tool
        .or(message_tool)
        .and_then(|tool| tool_of_server(server, tool))
        .is_some_and(|tool| {
            trust.allows(
                server,
                tool,
                automatic
                    && params["mode"] == "form"
                    && params["requestedSchema"]
                        == serde_json::json!({"type":"object","properties":{}})
                    && meta
                        .and_then(|meta| meta.get("codex_approval_kind"))
                        .and_then(Value::as_str)
                        == Some("mcp_tool_call"),
            )
        })
}

/// `tool` bare, or qualified by the elicitation's own server.
fn tool_of_server<'a>(server: &str, tool: &'a str) -> Option<&'a str> {
    match tool
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
    {
        Some((named, bare)) => (named == server).then_some(bare),
        None => Some(tool),
    }
}

fn quoted_tool_from_message(message: &str) -> Option<&str> {
    let marker = " tool \"";
    let start = message.find(marker)? + marker.len();
    let rest = message.get(start..)?;
    let end = rest.find('"')?;
    rest.get(..end)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{mcp_trust, trusted_mcp_permission_response};
    use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimeSpawnConfig};
    use crate::domain::agents::codex::server_request_method::method;
    use crate::domain::mcp::trusted::test_support::injected_browser_servers;
    use crate::domain::mcp::trusted::CadencrMcpTrust;

    fn spawn_config() -> RuntimeSpawnConfig {
        RuntimeSpawnConfig {
            mcp_servers: Some(injected_browser_servers()),
            ..RuntimeSpawnConfig::default()
        }
    }

    fn trusted() -> CadencrMcpTrust {
        mcp_trust(&spawn_config(), &json!({ "config": {} }))
    }

    #[test]
    fn automatic_mcp_approval_expires_with_the_acknowledged_turn() {
        let mut policy = super::McpApprovalTurn::default();
        policy.start(true);
        assert!(!policy.allows(Some("previous")));
        policy.started("current");
        assert!(policy.allows(Some("current")));
        assert!(!policy.allows(None));
        policy.completed(Some("previous"));
        assert!(policy.allows(Some("current")));
        policy.completed(Some("current"));
        policy.started("current"); // A late start reply cannot reopen the turn.
        assert!(!policy.allows(Some("current")));
        policy.start(false);
        policy.started("next");
        assert!(!policy.allows(Some("next")));
    }

    #[test]
    fn trusted_cadencr_browser_permission_builds_allow_response() {
        let response = trusted_mcp_permission_response(
            trusted(),
            false,
            &json!("approval-browser"),
            method("mcpServer/elicitation/request"),
            &json!({
                "serverName": "cadencr-browser",
                "_meta": { "tool_name": "browser_screenshot" },
                "message": "Approve browser screenshot"
            }),
        )
        .expect("trusted browser MCP should be auto-allowed");

        assert_eq!(response.request_id, "approval-browser");
        assert_eq!(response.decision, RuntimePermissionDecision::AllowOnce);
    }

    #[test]
    fn trusted_cadencr_browser_permission_recognizes_codex_message_only_elicitation() {
        let response = trusted_mcp_permission_response(
            trusted(),
            false,
            &json!("approval-message-browser"),
            method("mcpServer/elicitation/request"),
            &json!({
                "_meta": {
                    "codex_approval_kind": "mcp_tool_call",
                    "persist": ["session", "always"],
                    "tool_description": "Open a localhost URL",
                    "tool_params": { "url": "http://127.0.0.1:5175" },
                    "tool_params_display": [{
                        "display_name": "url",
                        "name": "url",
                        "value": "http://127.0.0.1:5175"
                    }]
                },
                "message": "Allow the cadencr-browser MCP server to run tool \"browser_open_url\"?",
                "mode": "form",
                "requestedSchema": {
                    "properties": {},
                    "type": "object"
                },
                "serverName": "cadencr-browser",
                "threadId": "019eba7c-7ebf-75f1-a6aa-022c40e3c9b9",
                "turnId": "019eba7c-83e9-7011-bdf3-935c998e388a"
            }),
        )
        .expect("Codex message-only Cadencr browser MCP approval should be auto-allowed");

        assert_eq!(response.request_id, "approval-message-browser");
        assert_eq!(response.decision, RuntimePermissionDecision::AllowOnce);
    }

    #[test]
    fn trusted_cadencr_browser_permission_rejects_untrusted_codex_message_tool() {
        assert!(trusted_mcp_permission_response(
            trusted(),
            false,
            &json!("approval-message-workspace"),
            method("mcpServer/elicitation/request"),
            &json!({
                "serverName": "cadencr-browser",
                "message": "Allow the cadencr-browser MCP server to run tool \"read_conversation\"?"
            }),
        )
        .is_none());
    }

    #[test]
    fn trusted_cadencr_browser_permission_ignores_non_permission_server_requests() {
        assert!(trusted_mcp_permission_response(
            trusted(),
            false,
            &json!("not-approval"),
            method("item/commandExecution/requestApproval"),
            &json!({
                "serverName": "cadencr-browser",
                "message": "Allow the cadencr-browser MCP server to run tool \"browser_open_url\"?"
            }),
        )
        .is_none());
    }

    #[test]
    fn project_approval_requires_auto_review_and_an_empty_tool_approval_form() {
        let servers = crate::domain::mcp::trusted::test_support::injected_servers(&["project"]);
        let trust = CadencrMcpTrust::injected_in(Some(&servers));
        let mut params = json!({
            "serverName":"cadencr-project", "mode":"form", "requestedSchema":{"type":"object","properties":{}},
            "_meta":{"codex_approval_kind":"mcp_tool_call"},
            "message":"Allow the cadencr-project MCP server to run tool \"project_list_sessions\"?"
        });
        assert!(super::is_trusted_elicitation(trust, &params, true));
        assert!(!super::is_trusted_elicitation(trust, &params, false));
        params["requestedSchema"]["properties"]["answer"] = json!({"type":"string"});
        assert!(!super::is_trusted_elicitation(trust, &params, true));
        params["requestedSchema"]["properties"] = json!({});
        params["_meta"] = json!({});
        assert!(!super::is_trusted_elicitation(trust, &params, true));
    }

    fn browser_elicitation(server: &str) -> serde_json::Value {
        json!({
            "serverName": server,
            "_meta": { "tool_name": "mcp__cadencr-browser__browser_open_url" },
            "message": "Allow the MCP server to run tool \"browser_open_url\"?"
        })
    }

    #[test]
    fn browser_tools_are_not_auto_allowed_when_cadencr_did_not_attach_its_server() {
        let untrusted = mcp_trust(&RuntimeSpawnConfig::default(), &json!({ "config": {} }));
        assert!(trusted_mcp_permission_response(
            untrusted,
            false,
            &json!("a"),
            method("mcpServer/elicitation/request"),
            &browser_elicitation("cadencr-browser"),
        )
        .is_none());
    }

    #[test]
    fn a_foreign_server_folding_into_the_browser_namespace_revokes_trust() {
        let effective = json!({ "config": { "mcp_servers": {
            "cadencr_browser": { "command": "evil" }
        }}});
        let trust = mcp_trust(&spawn_config(), &effective);
        assert!(!trust.is_trusted());
        assert!(trusted_mcp_permission_response(
            trust,
            false,
            &json!("a"),
            method("mcpServer/elicitation/request"),
            &browser_elicitation("cadencr-browser"),
        )
        .is_none());
    }

    #[test]
    fn a_native_server_under_cadencr_exact_key_is_replaced_and_keeps_trust() {
        let effective = json!({ "config": { "mcp_servers": {
            "cadencr-browser": { "command": "old" },
            "chrome-devtools": { "command": "chrome-devtools-mcp" }
        }}});
        assert!(mcp_trust(&spawn_config(), &effective).is_trusted());
    }

    #[test]
    fn elicitations_from_other_server_names_are_not_auto_allowed() {
        for server in ["cadencr_browser", "evil"] {
            assert!(trusted_mcp_permission_response(
                trusted(),
                false,
                &json!("a"),
                method("mcpServer/elicitation/request"),
                &browser_elicitation(server),
            )
            .is_none());
        }
    }
}
