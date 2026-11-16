//! Permission-mapping helpers for the sub-agent listener.
//!
//! Maps `PendingPermission` (from `GET /permission`) onto Cadencr's
//! `RuntimePermissionRequest`. Reuses the OpenCode adapter's canonical
//! `permission_options()` so root-session and sub-agent prompts render
//! the same buttons, and `extract_permission_preview` (the same helper
//! the rest of the adapter uses) for the command-line preview.

use serde_json::{json, Value};

use opencode_sdk_rs::{OpenCodeClient, PendingPermission, PermissionReply};

use crate::domain::agents::adapter::RuntimePermissionRequest;
use crate::domain::agents::opencode::permissions::permission_options;
use crate::domain::agents::opencode::tool_names::{
    canonical_acp_tool_name, canonical_cadencr_tool_name,
};
use crate::domain::mcp::trusted::CadencrBrowserTrust;
use crate::domain::permission_bridge::extract_permission_preview;

pub(super) fn should_auto_allow_trusted_cadencr_browser_permission(
    entry: &PendingPermission,
    trust: CadencrBrowserTrust,
) -> bool {
    entry
        .tool
        .as_deref()
        .map(|raw| canonical_cadencr_tool_name(&canonical_acp_tool_name(raw)))
        .is_some_and(|name| trust.allows_tool_name(&name))
}

pub(super) async fn try_auto_allow_trusted_cadencr_browser_permission(
    client: &OpenCodeClient,
    directory: &str,
    entry: &PendingPermission,
    trust: CadencrBrowserTrust,
) -> bool {
    if !should_auto_allow_trusted_cadencr_browser_permission(entry, trust) {
        return false;
    }
    if let Err(error) = client
        .reply_permission(&entry.id, PermissionReply::Once, Some(directory))
        .await
    {
        tracing::warn!(
            %error,
            permission_id = %entry.id,
            "failed to auto-allow trusted Cadencr browser MCP permission"
        );
        return false;
    }
    true
}

pub(super) fn build_request(entry: &PendingPermission) -> RuntimePermissionRequest {
    let tool_name = entry
        .tool
        .as_deref()
        .map(|raw| canonical_cadencr_tool_name(&canonical_acp_tool_name(raw)))
        .unwrap_or_else(|| "tool".to_string());
    let tool_input = merge_tool_input(&entry.metadata, &entry.patterns);
    RuntimePermissionRequest {
        request_id: entry.id.clone(),
        tool_use_id: entry.call_id.clone(),
        preview: extract_permission_preview(&tool_input),
        tool_name,
        tool_input,
        description: entry.title.clone(),
        pattern: None,
        options: permission_options(),
    }
}

/// Combine upstream `metadata` and `patterns` into a single `tool_input`
/// object the BE/FE preview extractors can read uniformly. Shell-style
/// tools leave `metadata` empty and stash the command in `patterns[]`,
/// so a bare `metadata.clone()` would render an empty Bash prompt.
fn merge_tool_input(metadata: &Value, patterns: &[String]) -> Value {
    let mut merged = metadata.as_object().cloned().unwrap_or_default();
    if !patterns.is_empty() {
        merged
            .entry("patterns".to_string())
            .or_insert_with(|| json!(patterns));
    }
    Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::{build_request, should_auto_allow_trusted_cadencr_browser_permission};
    use crate::domain::mcp::trusted::test_support::injected_browser_servers;
    use crate::domain::mcp::trusted::CadencrBrowserTrust;
    use opencode_sdk_rs::PendingPermission;
    use serde_json::json;

    fn sample() -> PendingPermission {
        PendingPermission {
            id: "per_1".into(),
            session_id: "ses_child".into(),
            tool: Some("bash".into()),
            title: Some("Run git status".into()),
            call_id: Some("call_42".into()),
            message_id: Some("msg_99".into()),
            patterns: vec!["git status".into()],
            metadata: json!({}),
        }
    }

    #[test]
    fn build_request_surfaces_bash_patterns_in_tool_input_and_preview() {
        // Bash leaves `metadata` empty and stashes the command in
        // `patterns[]`. The synthesized `tool_input` must surface the
        // pattern so the FE permission prompt has a command to render.
        let req = build_request(&sample());
        assert_eq!(req.request_id, "per_1");
        assert_eq!(req.tool_use_id.as_deref(), Some("call_42"));
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.tool_input["patterns"][0], "git status");
        assert_eq!(req.preview.as_deref(), Some("git status"));
        assert_eq!(req.description.as_deref(), Some("Run git status"));
        // Mirrors the root-session OpenCode adapter's button set.
        assert_eq!(req.options.len(), 3);
    }

    #[test]
    fn auto_allows_trusted_cadencr_browser_permission() {
        let entry = PendingPermission {
            tool: Some("cadencr-browser_browser_open_url".into()),
            metadata: json!({ "url": "http://localhost:1420" }),
            ..sample()
        };

        let trust = CadencrBrowserTrust::injected_in(Some(&injected_browser_servers()));
        assert!(should_auto_allow_trusted_cadencr_browser_permission(
            &entry, trust
        ));
        // The same tool name from a session where Cadencr did not attach its
        // browser server comes from someone else's `cadencr-browser`.
        assert!(!should_auto_allow_trusted_cadencr_browser_permission(
            &entry,
            CadencrBrowserTrust::default()
        ));
    }

    #[test]
    fn build_request_preserves_metadata_keys_alongside_patterns() {
        // Edit-style tools populate metadata AND patterns — both should
        // survive the merge so the FE can render either field.
        let entry = PendingPermission {
            tool: Some("edit".into()),
            metadata: json!({ "filepath": "/etc/hosts", "diff": "-old\n+new" }),
            patterns: vec!["/etc/hosts".into()],
            ..sample()
        };
        let req = build_request(&entry);
        assert_eq!(req.tool_input["filepath"], "/etc/hosts");
        assert_eq!(req.tool_input["patterns"][0], "/etc/hosts");
    }

    #[test]
    fn build_request_falls_back_to_default_tool_name_when_kind_missing() {
        let entry = PendingPermission {
            tool: None,
            ..sample()
        };
        assert_eq!(build_request(&entry).tool_name, "tool");
    }
}
