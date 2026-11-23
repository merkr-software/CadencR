//! Edit-tool input normalization for OpenCode's ACP adapter.
//!
//! OpenCode (and ACP in general) names file-edit fields using camelCase
//! (`oldText` / `newText` / `filePath`); the Cadencr frontend's diff
//! renderer expects the canonical Anthropic-style snake_case keys
//! (`old_string` / `new_string` / `file_path`). This module owns the
//! single rewrite path. Split out of `adapter.rs` to keep that file under
//! the 400-line ceiling.

use serde_json::Value;

use crate::domain::agents::acp::runtime::tool_input;
use crate::domain::agents::adapter::RuntimePermissionMode;
use crate::domain::agents::mcp_tool_names::McpToolNameResolver;
use crate::domain::agents::opencode::tool_names::{
    canonical_acp_tool_name, canonical_cadencr_tool_name,
};

/// The Cadencr name of an OpenCode tool (MCP tools by their server prefix).
pub(super) fn normalize_tool_name(names: &McpToolNameResolver, raw: &str) -> String {
    let canonical = canonical_cadencr_tool_name(&canonical_acp_tool_name(raw));
    names.canonical_name(&canonical).unwrap_or(canonical)
}

/// The OpenCode agent (ACP mode) for a Cadencr permission mode.
pub(super) fn opencode_mode(mode: RuntimePermissionMode) -> String {
    match mode {
        RuntimePermissionMode::Plan => "plan".to_string(),
        RuntimePermissionMode::OpenCodeAgent(name) => name,
        _ => "build".to_string(),
    }
}

/// Rename ACP-flavoured edit-tool keys to the canonical Anthropic-style
/// keys the FE diff renderer expects. Operates only on known edit tool
/// names (Edit / MultiEdit / Write / ApplyPatch — `ApplyPatch` shares the
/// same key shape per the ACP schema) so other tool inputs pass through
/// unchanged.
///
/// `Write` takes a different canonical shape: the FE Write renderer reads
/// `content`, not `new_string`, and there is no diff base (`oldText` is
/// dropped). Edit / MultiEdit / ApplyPatch keep `{old_string, new_string}`.
pub fn normalize_edit_input(tool_name: &str, input: Value) -> Value {
    tool_input::normalize_edit_input(tool_name, input)
}

#[cfg(test)]
mod tests {
    use super::normalize_edit_input;
    use serde_json::{json, Value};

    #[test]
    fn normalize_rewrites_acp_edit_keys() {
        let normalized = normalize_edit_input(
            "Edit",
            json!({ "path": "/x", "oldText": "a", "newText": "b" }),
        );
        assert_eq!(normalized["file_path"], "/x");
        assert_eq!(normalized["old_string"], "a");
        assert_eq!(normalized["new_string"], "b");
        assert!(normalized.get("path").is_none());
        assert!(normalized.get("oldText").is_none());
        assert!(normalized.get("newText").is_none());
    }

    #[test]
    fn normalize_leaves_existing_canonical_keys_untouched() {
        let normalized = normalize_edit_input(
            "Edit",
            json!({ "file_path": "/x", "old_string": "a", "new_string": "b" }),
        );
        assert_eq!(normalized["file_path"], "/x");
        assert_eq!(normalized["old_string"], "a");
        assert_eq!(normalized["new_string"], "b");
    }

    #[test]
    fn normalize_apply_patch_matches_edit_normalization() {
        // ApplyPatch shares the ACP edit-tool key shape; rewrite must match Edit.
        let raw = json!({ "filePath": "/x", "oldText": "a", "newText": "b" });
        assert_eq!(
            normalize_edit_input("Edit", raw.clone()),
            normalize_edit_input("ApplyPatch", raw)
        );
    }

    #[test]
    fn normalize_write_rewrites_new_text_to_content() {
        // Write expects `content`, not `new_string` — see
        // packages/desktop/src/lib/tool-adapter.ts:154-159.
        let normalized = normalize_edit_input(
            "Write",
            json!({ "filePath": "/x/new.txt", "newText": "hello" }),
        );
        assert_eq!(normalized["file_path"], "/x/new.txt");
        assert_eq!(normalized["content"], "hello");
        assert!(normalized.get("new_string").is_none());
        assert!(normalized.get("newText").is_none());
    }

    #[test]
    fn normalize_write_drops_old_text_field() {
        // Write has no diff base; an `oldText` field would never be read
        // by the FE and is dropped to keep the canonical shape clean.
        let normalized = normalize_edit_input(
            "Write",
            json!({ "filePath": "/x/new.txt", "oldText": "ignored", "newText": "hello" }),
        );
        assert_eq!(normalized["content"], "hello");
        assert!(normalized.get("oldText").is_none());
        assert!(normalized.get("old_string").is_none());
    }

    #[test]
    fn normalize_write_leaves_canonical_content_key_untouched() {
        let normalized = normalize_edit_input(
            "Write",
            json!({ "file_path": "/x", "content": "already canonical" }),
        );
        assert_eq!(normalized["file_path"], "/x");
        assert_eq!(normalized["content"], "already canonical");
    }

    #[test]
    fn normalize_skips_non_edit_tools() {
        let raw = json!({ "path": "/x", "command": "ls" });
        let normalized = normalize_edit_input("Bash", raw.clone());
        assert_eq!(normalized, raw);
    }

    #[test]
    fn normalize_returns_non_object_inputs_unchanged() {
        let normalized = normalize_edit_input("Edit", Value::Null);
        assert!(normalized.is_null());
    }
}
