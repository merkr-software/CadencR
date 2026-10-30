//! Resolve ACP tool-call metadata into Cadencr's canonical tool names.
//!
//! ACP `title` is display text, not a stable tool identifier. Cursor uses
//! command previews such as `` `pnpm lint` `` for that field, while `kind`
//! carries the protocol-level `execute` classification.
//!
//! OpenCode's Task tool is a special case: `toToolKind("task")` returns
//! `"think"`, and once metadata lands the `title` becomes the human
//! description (e.g. "Audit auth"). Preferring `kind` alone therefore
//! mis-labels Task as `Think`, which skips Cadencr's sub-agent pairing,
//! raw-output suppression, and Task panel. Recover via a literal
//! `"task"`/`"agent"` title or Task's distinctive `subagent_type` input.

use serde_json::Value;

use super::provider_hooks::AcpProviderHooks;

pub(super) fn resolve_tool_name(body: &Value, hooks: &dyn AcpProviderHooks) -> String {
    let hint = body
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| programmatic_name(body))
        .or_else(|| task_tool_from_input(body))
        .or_else(|| task_or_agent_title(body))
        .or_else(|| tool_name_from_kind(body))
        .or_else(|| body.get("title").and_then(Value::as_str))
        .unwrap_or("tool");
    hooks.normalize_tool_name(hint)
}

/// Standard ACP `ToolCall.name` / `ToolCallUpdateFields.name`: the
/// programmatic tool name, when the agent provides one.
fn programmatic_name(body: &Value) -> Option<&str> {
    body.get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

/// OpenCode can first surface Task as `kind=think` (empty input), then fill
/// `rawInput` with `subagent_type`. Re-resolve only when the recorded name is
/// missing or the Think mislabel — avoid re-scanning every unrelated update.
pub(super) fn recover_tool_name_from_update(
    tool_call_id: &str,
    body: &Value,
    indexer: &mut super::events_stream_blocks::EventIndexer,
    hooks: &dyn AcpProviderHooks,
) {
    let recorded = indexer.tool_name_for(tool_call_id);
    if recorded.is_some_and(|name| {
        name.eq_ignore_ascii_case("task")
            || name.eq_ignore_ascii_case("agent")
            || !name.eq_ignore_ascii_case("think")
    }) {
        return;
    }
    let resolved = resolve_tool_name(body, hooks);
    if !(resolved.eq_ignore_ascii_case("task") || resolved.eq_ignore_ascii_case("agent")) {
        return;
    }
    indexer.record_tool_name(tool_call_id, &resolved);
    hooks.record_tool_call_start(tool_call_id, &resolved);
}

/// Literal OpenCode Task/Agent titles must beat `kind: "think"`. Do not treat
/// arbitrary one-word titles as tool ids — that would override `kind` for
/// other providers (e.g. title `"run"` + `kind: "execute"`).
fn task_or_agent_title(body: &Value) -> Option<&str> {
    let title = body.get("title").and_then(Value::as_str)?.trim();
    if title.eq_ignore_ascii_case("task") || title.eq_ignore_ascii_case("agent") {
        Some(title)
    } else {
        None
    }
}

/// OpenCode Task tools always carry `subagent_type` in their input once the
/// model fills args — even after `title` has been rewritten to the
/// description. Use that as a stable Task signal when `kind` is the useless
/// `"think"` bucket.
fn task_tool_from_input(body: &Value) -> Option<&'static str> {
    let input = body
        .get("rawInput")
        .or_else(|| body.get("toolInput"))
        .filter(|value| value.is_object())?;
    if input.get("subagent_type").and_then(Value::as_str).is_some() {
        Some("task")
    } else {
        None
    }
}

fn tool_name_from_kind(body: &Value) -> Option<&'static str> {
    match body.get("kind").and_then(Value::as_str)? {
        "read" => Some("Read"),
        "edit" => Some("Edit"),
        "delete" => Some("Delete"),
        "move" => Some("Move"),
        "search" => Some("Search"),
        "execute" => Some("Bash"),
        "think" => Some("Think"),
        "fetch" => Some("Fetch"),
        "switch_mode" => Some("SwitchMode"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_tool_name;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::adapter::RuntimePermissionMode;
    use serde_json::{json, Value};

    struct IdentityHooks;

    #[async_trait::async_trait]
    impl AcpProviderHooks for IdentityHooks {
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

    #[test]
    fn execute_kind_wins_over_human_readable_command_title() {
        let body = json!({ "title": "`pnpm lint`", "kind": "execute" });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "Bash");
    }

    #[test]
    fn execute_kind_wins_over_id_like_non_task_title() {
        // Generic one-word titles must not override kind for other providers.
        let body = json!({ "title": "run", "kind": "execute" });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "Bash");
    }

    #[test]
    fn explicit_tool_name_wins_over_coarse_kind() {
        let body = json!({ "toolName": "CustomRunner", "title": "run", "kind": "execute" });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "CustomRunner");
    }

    #[test]
    fn standard_acp_name_wins_over_kind_and_title() {
        // ACP schema 1.12 `ToolCall.name` ("Programmatic name of the tool").
        let body = json!({ "name": "Agent", "title": "Explore auth", "kind": "think" });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "Agent");
        let blank = json!({ "name": "  ", "title": "run", "kind": "execute" });
        assert_eq!(resolve_tool_name(&blank, &IdentityHooks), "Bash");
    }

    #[test]
    fn title_remains_the_fallback_when_kind_is_unknown() {
        let body = json!({ "title": "custom action", "kind": "other" });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "custom action");
    }

    #[test]
    fn literal_task_title_wins_over_think_kind() {
        // OpenCode: toToolKind("task") == "think", pending title is still "task".
        let body = json!({ "title": "task", "kind": "think", "rawInput": {} });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "task");
    }

    #[test]
    fn subagent_type_input_identifies_task_when_title_is_a_description() {
        // After ctx.metadata, OpenCode replaces title with the description.
        let body = json!({
            "title": "Audit",
            "kind": "think",
            "rawInput": {
                "description": "Audit",
                "prompt": "…",
                "subagent_type": "general"
            }
        });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "task");
    }

    #[test]
    fn descriptive_think_title_without_task_input_stays_think() {
        let body = json!({ "title": "Reason about the plan", "kind": "think" });
        assert_eq!(resolve_tool_name(&body, &IdentityHooks), "Think");
    }
}
