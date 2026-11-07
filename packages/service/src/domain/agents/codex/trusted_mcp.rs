//! Codex's side of Cadencr's browser-tool auto-approval.
//!
//! Codex names a server's tools by its config key with `-` folded to `_`
//! (`mcp__cadencr_browser__`), so a foreign `cadencr_browser` server would
//! produce the same namespace. [`browser_trust`] therefore revokes trust when
//! the effective Codex config holds such a server; a server under Cadencr's
//! exact key is replaced by the thread config Cadencr starts the thread with.

use serde_json::Value;

use super::permissions::permission_request;
use super::raw_tool_names::function_tool_name;
use crate::domain::agents::adapter::{
    RuntimePermissionDecision, RuntimePermissionResponse, RuntimeSpawnConfig,
};
use crate::domain::mcp::trusted::CadencrBrowserTrust;

/// Codex's namespace for Cadencr's browser server, without trailing `_`.
const CODEX_BROWSER_NAMESPACE: &str = "mcp__cadencr_browser";
const CANONICAL_BROWSER_PREFIX: &str = "mcp__cadencr-browser__";

/// The browser trust of a Codex thread. `effective` is Codex's
/// `config/read` result; its MCP servers that Cadencr's thread config does
/// not replace are foreign.
pub(super) fn browser_trust(config: &RuntimeSpawnConfig, effective: &Value) -> CadencrBrowserTrust {
    let injected = config.mcp_servers.as_ref();
    let native = effective.get("config").unwrap_or(effective);
    let foreign = native
        .get("mcp_servers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|servers| servers.keys())
        .map(String::as_str)
        .filter(|name| !injected.is_some_and(|servers| servers.contains_key(*name)));
    CadencrBrowserTrust::injected_in(injected).shadowed_by(foreign)
}

pub(super) fn trusted_cadencr_browser_permission_response(
    trust: CadencrBrowserTrust,
    id: &Value,
    method: &str,
    params: &Value,
) -> Option<RuntimePermissionResponse> {
    let trusted = match method {
        "mcpServer/elicitation/request" => is_trusted_elicitation(trust, params),
        "item/tool/requestApproval" => is_trusted_item_tool_request(trust, params),
        _ => false,
    };
    if !trusted {
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
fn is_trusted_elicitation(trust: CadencrBrowserTrust, params: &Value) -> bool {
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
        .is_some_and(|tool| trust.allows_server_tool(server, tool))
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

fn is_trusted_item_tool_request(trust: CadencrBrowserTrust, params: &Value) -> bool {
    let item = params.get("item").unwrap_or(params);
    if trust.allows_tool_name(&canonical_browser_name(&function_tool_name(item))) {
        return true;
    }
    let namespace = item.get("namespace").and_then(Value::as_str);
    let tool = item
        .get("name")
        .or_else(|| item.get("tool"))
        .and_then(Value::as_str);
    namespace.zip(tool).is_some_and(|(namespace, tool)| {
        namespace.trim_end_matches('_') == CODEX_BROWSER_NAMESPACE
            && trust.allows_tool_name(&format!(
                "{CANONICAL_BROWSER_PREFIX}{}",
                tool.trim_start_matches('_')
            ))
    })
}

/// Codex's flattened `mcp__cadencr_browser____<tool>` → the canonical name.
fn canonical_browser_name(name: &str) -> String {
    name.strip_prefix(CODEX_BROWSER_NAMESPACE)
        .filter(|rest| rest.starts_with("__"))
        .map(|rest| format!("{CANONICAL_BROWSER_PREFIX}{}", rest.trim_start_matches('_')))
        .unwrap_or_else(|| name.to_string())
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

    use super::{browser_trust, trusted_cadencr_browser_permission_response};
    use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimeSpawnConfig};
    use crate::domain::mcp::trusted::test_support::injected_browser_servers;
    use crate::domain::mcp::trusted::CadencrBrowserTrust;

    fn spawn_config() -> RuntimeSpawnConfig {
        RuntimeSpawnConfig {
            mcp_servers: Some(injected_browser_servers()),
            ..RuntimeSpawnConfig::default()
        }
    }

    fn trusted() -> CadencrBrowserTrust {
        browser_trust(&spawn_config(), &json!({ "config": {} }))
    }

    #[test]
    fn trusted_cadencr_browser_permission_builds_allow_response() {
        let response = trusted_cadencr_browser_permission_response(
            trusted(),
            &json!("approval-browser"),
            "mcpServer/elicitation/request",
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
    fn trusted_cadencr_browser_permission_recognizes_raw_codex_namespace_item() {
        let response = trusted_cadencr_browser_permission_response(
            trusted(),
            &json!("approval-raw-browser"),
            "item/tool/requestApproval",
            &json!({
                "item": {
                    "type": "function_call",
                    "namespace": "mcp__cadencr_browser",
                    "name": "browser_open_url",
                    "arguments": "{\"url\":\"http://localhost:1420\"}"
                }
            }),
        )
        .expect("raw Codex Cadencr browser MCP call should be auto-allowed");

        assert_eq!(response.request_id, "approval-raw-browser");
        assert_eq!(response.decision, RuntimePermissionDecision::AllowOnce);
    }

    #[test]
    fn trusted_cadencr_browser_permission_recognizes_codex_message_only_elicitation() {
        let response = trusted_cadencr_browser_permission_response(
            trusted(),
            &json!("approval-message-browser"),
            "mcpServer/elicitation/request",
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
        assert!(trusted_cadencr_browser_permission_response(
            trusted(),
            &json!("approval-message-workspace"),
            "mcpServer/elicitation/request",
            &json!({
                "serverName": "cadencr-browser",
                "message": "Allow the cadencr-browser MCP server to run tool \"read_conversation\"?"
            }),
        )
        .is_none());
    }

    #[test]
    fn trusted_cadencr_browser_permission_ignores_non_permission_server_requests() {
        assert!(trusted_cadencr_browser_permission_response(
            trusted(),
            &json!("not-approval"),
            "server/ping",
            &json!({
                "serverName": "cadencr-browser",
                "message": "Allow the cadencr-browser MCP server to run tool \"browser_open_url\"?"
            }),
        )
        .is_none());
    }

    fn browser_elicitation(server: &str) -> serde_json::Value {
        json!({
            "serverName": server,
            "_meta": { "tool_name": "mcp__cadencr-browser__browser_open_url" },
            "message": "Allow the MCP server to run tool \"browser_open_url\"?"
        })
    }

    fn browser_item(namespace: &str) -> serde_json::Value {
        json!({ "item": { "type": "function_call", "namespace": namespace, "name": "browser_open_url" } })
    }

    #[test]
    fn browser_tools_are_not_auto_allowed_when_cadencr_did_not_attach_its_server() {
        let untrusted = browser_trust(&RuntimeSpawnConfig::default(), &json!({ "config": {} }));
        for (method, params) in [
            (
                "mcpServer/elicitation/request",
                browser_elicitation("cadencr-browser"),
            ),
            (
                "item/tool/requestApproval",
                browser_item("mcp__cadencr_browser__"),
            ),
        ] {
            assert!(trusted_cadencr_browser_permission_response(
                untrusted,
                &json!("a"),
                method,
                &params
            )
            .is_none());
        }
    }

    #[test]
    fn a_foreign_server_folding_into_the_browser_namespace_revokes_trust() {
        let effective = json!({ "config": { "mcp_servers": {
            "cadencr_browser": { "command": "evil" }
        }}});
        let trust = browser_trust(&spawn_config(), &effective);
        assert!(!trust.is_trusted());
        assert!(trusted_cadencr_browser_permission_response(
            trust,
            &json!("a"),
            "item/tool/requestApproval",
            &browser_item("mcp__cadencr_browser__"),
        )
        .is_none());
    }

    #[test]
    fn a_native_server_under_cadencr_exact_key_is_replaced_and_keeps_trust() {
        let effective = json!({ "config": { "mcp_servers": {
            "cadencr-browser": { "command": "old" },
            "chrome-devtools": { "command": "chrome-devtools-mcp" }
        }}});
        assert!(browser_trust(&spawn_config(), &effective).is_trusted());
    }

    #[test]
    fn elicitations_from_other_server_names_are_not_auto_allowed() {
        for server in ["cadencr_browser", "evil"] {
            assert!(trusted_cadencr_browser_permission_response(
                trusted(),
                &json!("a"),
                "mcpServer/elicitation/request",
                &browser_elicitation(server),
            )
            .is_none());
        }
    }

    #[test]
    fn codex_flattened_browser_tool_names_are_recognized() {
        let params = json!({ "item": { "type": "function_call",
            "name": "mcp__cadencr_browser____browser_open_url" } });
        assert!(trusted_cadencr_browser_permission_response(
            trusted(),
            &json!("a"),
            "item/tool/requestApproval",
            &params,
        )
        .is_some());
    }
}
