//! Auto Review preflight for Cursor permission requests.
//!
//! Cursor accepts `--auto-review` for `agent acp`, but its ACP session
//! bootstrap does not copy that mode into the session metadata. It
//! consequently asks the ACP client about ordinary shell allowlist misses and
//! MCP calls. Keep the workaround connector-local and fail closed: in Auto
//! Review, preflight only ordinary shell allowlist misses after Cursor has
//! applied its parser, sandbox, blocklist, delete-protection, hook, and
//! team-policy checks. MCP, non-shell, and stronger safety requests still reach
//! the user because ACP does not expose a trustworthy classifier for them.

use serde_json::Value;

use crate::access::AccessMode;

/// The `optionId` to answer Cursor with, when the request is auto-approved.
/// `launched` is the mode `agent` runs with: while a Full Access switch waits
/// for a fresh conversation to be saved (`proxy/restart.rs`), every request
/// is approved, as Cursor's Run Everything would, inside the kept sandbox.
pub fn automatic_allow_option(
    access: AccessMode,
    launched: AccessMode,
    params: &Value,
) -> Option<String> {
    if access == AccessMode::FullAccess && launched != AccessMode::FullAccess {
        return Some(allow_once_option_id(params));
    }
    if access != AccessMode::AutoReview {
        return None;
    }
    let tool_call = params.get("toolCall")?;
    if tool_call.get("kind").and_then(Value::as_str) != Some("execute")
        || !has_only_allowlist_miss_reasons(tool_call)
    {
        return None;
    }
    Some(allow_once_option_id(params))
}

fn allow_once_option_id(params: &Value) -> String {
    params
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some("allow_once"))
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
        .unwrap_or("allow-once")
        .to_string()
}

fn has_only_allowlist_miss_reasons(tool_call: &Value) -> bool {
    let reasons = tool_call_text(tool_call)
        .flat_map(|text| text.split(" • "))
        .map(str::trim)
        .collect::<Vec<_>>();
    !reasons.is_empty()
        && reasons.iter().all(|reason| {
            reason
                .strip_prefix("Not in allowlist:")
                .is_some_and(|command| !command.trim().is_empty())
        })
}

fn tool_call_text(tool_call: &Value) -> impl Iterator<Item = &str> {
    tool_call
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| block.pointer("/content/text").and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::automatic_allow_option;
    use crate::access::AccessMode;

    fn params(command: &str, reason: &str) -> Value {
        json!({
            "toolCall": {
                "title": format!("`{command}`"),
                "kind": "execute",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": reason }
                }]
            },
            "options": [
                { "optionId": "allow-always", "kind": "allow_always", "name": "Always" },
                { "optionId": "allow-once", "kind": "allow_once", "name": "Allow" },
                { "optionId": "reject-once", "kind": "reject_once", "name": "Reject" }
            ]
        })
    }

    fn mcp_params(content: &str) -> Value {
        json!({
            "toolCall": {
                "title": "chrome-devtools-new_page: new_page",
                "kind": "other",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": content }
                }]
            }
        })
    }

    #[test]
    fn auto_review_preflights_cursor_shell_allowlist_misses() {
        assert_eq!(
            automatic_allow_option(
                AccessMode::AutoReview,
                AccessMode::AutoReview,
                &params("printf cursor-acp-auto-review", "Not in allowlist: printf"),
            )
            .as_deref(),
            Some("allow-once")
        );
    }

    #[test]
    fn auto_review_keeps_explicit_safety_requests_interactive() {
        for reason in [
            "Delete protection is enabled",
            "In team blocklist: git push",
            "Hook requested approval: review required",
            "Not in allowlist: git diff • Delete protection is enabled",
            "Not in allowlist:   ",
        ] {
            assert_eq!(
                automatic_allow_option(
                    AccessMode::AutoReview,
                    AccessMode::AutoReview,
                    &params("git diff", reason)
                ),
                None
            );
        }
    }

    #[test]
    fn auto_review_keeps_mcp_requests_interactive() {
        for params in [
            mcp_params("```json\n{\"url\":\"https://google.com\"}\n```"),
            mcp_params("Approval required by a newer policy"),
            json!({ "toolCall": { "title": "chrome-devtools-new_page: new_page", "kind": "other" } }),
        ] {
            assert_eq!(
                automatic_allow_option(AccessMode::AutoReview, AccessMode::AutoReview, &params),
                None
            );
        }
    }

    #[test]
    fn other_modes_do_not_preflight_the_same_request() {
        for mode in [AccessMode::Default, AccessMode::FullAccess] {
            assert_eq!(
                automatic_allow_option(mode, mode, &params("pwd", "Not in allowlist: pwd")),
                None
            );
        }
    }

    #[test]
    fn deferred_full_access_approves_every_request_until_the_restart() {
        for request in [
            params("rm -rf build", "Delete protection is enabled"),
            mcp_params("x"),
        ] {
            assert_eq!(
                automatic_allow_option(AccessMode::FullAccess, AccessMode::Default, &request)
                    .as_deref(),
                Some("allow-once")
            );
        }
    }

    #[test]
    fn missing_options_fall_back_to_cursor_allow_once_id() {
        let mut request = params("pwd", "Not in allowlist: pwd");
        request.as_object_mut().unwrap().remove("options");
        assert_eq!(
            automatic_allow_option(AccessMode::AutoReview, AccessMode::AutoReview, &request)
                .as_deref(),
            Some("allow-once")
        );
    }
}
