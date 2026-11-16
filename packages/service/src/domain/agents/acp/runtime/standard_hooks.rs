//! The one `AcpProviderHooks` impl that adds nothing.
//!
//! Split out of `provider_hooks.rs` to keep that file (the trait plus its ~30
//! documented defaults) under the 400-line ceiling.

use async_trait::async_trait;
use serde_json::Value;

use super::provider_hooks::AcpProviderHooks;
use crate::domain::agents::adapter::RuntimePermissionMode;

/// Standard ACP v1 behavior, with no provider-specific extension whatsoever.
///
/// The three methods below are the trait's only required ones — deliberately so,
/// since every built-in provider has to make an explicit decision about tool
/// naming and mode mapping. An agent Cadencr knows nothing about has no such
/// decision to make, so this impl answers each of them the only neutral way:
///
/// - **tool names** pass through unchanged. `events_tool_call_name.rs` already
///   maps the standard ACP `kind` values (`read`, `edit`, `execute`, …) onto
///   Cadencr's canonical names; a rename table here would be guessing at a
///   provider-native vocabulary.
/// - **tool inputs** pass through unchanged. Standard ACP `rawInput` is what the
///   agent meant, and rewriting it would change what the user approves.
/// - **permission modes** are not mapped. Modes are negotiated per session and
///   reported by `session/new`; mapping a Cadencr mode onto a guessed provider
///   mode id would push the session into a mode the agent never advertised.
///
/// Every other hook keeps its trait default, which declines the optional
/// capability rather than claiming it. This is what the generic ACP provider
/// (`providers/installed/`) spawns with, and what the runtime's own tests use
/// when they need hooks that add nothing.
pub struct StandardAcpHooks;

#[async_trait]
impl AcpProviderHooks for StandardAcpHooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        raw.to_string()
    }
    fn normalize_tool_input(&self, _tool_name: &str, input: Value) -> Value {
        input
    }
    fn mode_for_permission_mode(&self, _mode: RuntimePermissionMode) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{AcpProviderHooks, StandardAcpHooks};
    use serde_json::{json, Value};

    #[test]
    fn default_flatten_tool_result_content_joins_text_blocks() {
        let hooks = StandardAcpHooks;
        let payload = hooks.flatten_tool_result_content(&[
            json!({ "type": "text", "text": "first" }),
            json!({ "type": "text", "text": "second" }),
        ]);
        assert_eq!(payload, Value::String("first\nsecond".to_string()));
    }

    #[test]
    fn default_flatten_tool_result_content_preserves_structured_blocks() {
        let hooks = StandardAcpHooks;
        let blocks = vec![json!({ "type": "diff", "path": "a.rs" })];
        assert_eq!(hooks.flatten_tool_result_content(&blocks), json!(blocks));
    }

    /// Optional ACP capabilities must stay declined: claiming one the agent
    /// never advertised makes the runtime send a method it cannot answer.
    #[test]
    fn standard_hooks_claim_no_optional_capability() {
        let hooks = StandardAcpHooks;
        assert!(!hooks.supports_durable_resume());
        assert!(hooks.model_config_id().is_none());
        assert!(hooks.thinking_effort_config_id().is_none());
        assert!(hooks.default_mode_id().is_none());
        assert!(hooks.compact_prompt().is_none());
        assert!(hooks
            .mode_for_permission_mode(crate::domain::agents::adapter::RuntimePermissionMode::Plan)
            .is_none());
        assert_eq!(hooks.normalize_tool_name("acme.deploy"), "acme.deploy");
        let input = json!({ "command": "git status", "_meta": { "acme": 1 } });
        assert_eq!(hooks.normalize_tool_input("Bash", input.clone()), input);
    }
}
