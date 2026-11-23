//! Parent-tool-use linkage extraction for sub-agent nesting.
//!
//! Split out of `events_tool_call.rs` to keep that file under the 400-line
//! ceiling (per `.claude/rules/file-size.md`). The function and its tests
//! cover the small but spec-relevant concern of mapping ACP's various
//! parent-id field names onto a single `parent_tool_use_id` the FE uses to
//! nest child events under the parent tool block.

use serde_json::Value;

/// Extract a parent-tool-use id for sub-agent linkage from a `tool_call` /
/// `tool_call_update` body. ACP carries this on the parent-side as
/// `parentToolCallId` / `parentToolUseId`; we accept both spellings (camel
/// and snake case) so adapters that emit either still surface nesting
/// metadata.
///
/// **Why `subAgentSessionId` is NOT in the fallback chain.** Some adapters
/// expose a `subAgentSessionId` field carrying the **child session id**, not
/// a tool_use id. Feeding that into `parent_tool_use_id` is wrong: the FE
/// looks `parent_tool_use_id` up in a `tool_use_id → block` map and a child
/// session id will never key into that map, silently orphaning the child
/// event. If a future provider streams real sub-agent events keyed only by
/// session id, the right shape is a per-session `child_session_id →
/// parent_tool_use_id` registry that translates *before* stamping — not a
/// fallback that pretends a session id is a tool_use id. (See spec § 6 in
/// `docs/PROVIDER_SPEC/OPENCODE.md`.) On the current OpenCode wire,
/// sub-agents do not stream child events at all — the final result is
/// delivered via the parent tool's `tool_call_update` and synthesised under
/// the parent block by `synthesize_tool_call_completion`.
///
/// Note: ACP sub-agent **replay** (loading a child session's history on
/// restart) is a separate concern — it requires `session/load`, which is
/// gated on the agent advertising the `loadSession` capability. This is
/// out of scope until OpenCode supports durable sessions; the existing
/// skip-and-log path in `lifecycle.rs` covers the absence-of-capability
/// case.
pub(super) fn parent_tool_use_id(body: &Value) -> Option<&str> {
    body.get("parentToolCallId")
        .or_else(|| body.get("parentToolUseId"))
        .or_else(|| body.get("parent_tool_use_id"))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::parent_tool_use_id;
    use serde_json::json;

    #[test]
    fn picks_parent_tool_call_id_first() {
        let body = json!({
            "parentToolCallId": "parent-1",
            "parentToolUseId": "ignored",
        });
        assert_eq!(parent_tool_use_id(&body), Some("parent-1"));
    }

    #[test]
    fn falls_back_to_parent_tool_use_id() {
        let body = json!({ "parentToolUseId": "parent-2" });
        assert_eq!(parent_tool_use_id(&body), Some("parent-2"));
    }

    #[test]
    fn falls_back_to_snake_case_parent_tool_use_id() {
        let body = json!({ "parent_tool_use_id": "parent-3" });
        assert_eq!(parent_tool_use_id(&body), Some("parent-3"));
    }

    #[test]
    fn ignores_sub_agent_session_id_because_it_is_a_session_not_a_tool_use_id() {
        // Regression: previously this fell back to `subAgentSessionId`, but
        // session ids never key into the FE's tool_use_id map, so child
        // events stamped with one were silently orphaned. The right shape is
        // a child-session→parent-tool-use registry, not this fallback.
        let body = json!({ "subAgentSessionId": "sub-4" });
        assert!(parent_tool_use_id(&body).is_none());
    }

    #[test]
    fn returns_none_when_no_parent_field_present() {
        let body = json!({ "toolCallId": "t-1" });
        assert!(parent_tool_use_id(&body).is_none());
    }
}
