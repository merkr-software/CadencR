//! Wire-protocol helpers for the CLI's bidirectional control channel.
//!
//! The Claude Code CLI uses a bidirectional **control protocol** over
//! stdin/stdout. When the CLI needs tool approval, it emits a
//! `control_request` message on stdout:
//!
//! ```json
//! {
//!   "type": "control_request",
//!   "request_id": "req_1_abcd1234",
//!   "request": {
//!     "subtype": "can_use_tool",
//!     "tool_name": "Write",
//!     "input": { "file_path": "/tmp/test.txt", "content": "..." },
//!     "permission_suggestions": []
//!   }
//! }
//! ```
//!
//! The SDK responds on stdin with a `control_response`:
//!
//! ```json
//! {
//!   "type": "control_response",
//!   "response": {
//!     "subtype": "success",
//!     "request_id": "req_1_abcd1234",
//!     "response": { "behavior": "allow", "updatedInput": { ... } }
//!   }
//! }
//! ```
//!
//! This module owns the wire-shape helpers (`control_request_subtype`,
//! `parse_control_response`, `parse_permission_request`), the shared
//! [`write_to_stdin`] helper, and the pending-control bookkeeping types
//! used by both [`super::query_struct::Query`] (sender side) and
//! [`super::reader`] (receiver side).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex};
use tracing::debug;

use crate::error::SdkError;
use crate::permissions::PermissionRequest;

/// Outcome of a `control_request` round-trip carried through a oneshot.
/// `Ok(value)` is the inner `response` payload from the CLI's
/// `control_response` (with `subtype: "success"`); `Err` carries either a
/// CLI-reported `subtype: "error"` or a transport failure.
pub(super) type ControlOutcome = Result<serde_json::Value, SdkError>;

/// In-flight `control_request` waiting on a `control_response`. Carries
/// the outbound subtype so the reader loop can stamp it onto
/// `SdkError::ControlRequestFailed` — the CLI's response only signals
/// success/error, not which command it answered.
pub(super) struct PendingControlEntry {
    pub(super) subtype: String,
    pub(super) sender: oneshot::Sender<ControlOutcome>,
}

/// Map of in-flight `control_request` ids to their pending entry. Cleared
/// entries indicate either resolution by the reader loop (success/error)
/// or sender drop on timeout.
pub(super) type PendingControl = Arc<Mutex<HashMap<String, PendingControlEntry>>>;

/// Default round-trip timeout for `control_request`s. Matches the
/// official Python SDK's 60 s default — the CLI usually replies in
/// milliseconds, but the protocol allows the CLI to defer the response
/// while it finishes prior work, so a generous ceiling avoids false
/// timeouts under load (a hot turn streaming many tool calls can keep
/// the CLI's read loop briefly busy). If we don't hear back in this
/// window it almost certainly means the envelope shape was wrong (CLI
/// silently drops unknown shapes) or the subprocess is wedged.
pub(super) const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Extract the `request.subtype` from a `control_request` message,
/// or `None` if this isn't a control_request.
pub(super) fn control_request_subtype(value: &serde_json::Value) -> Option<&str> {
    if value.get("type").and_then(|t| t.as_str()) != Some("control_request") {
        return None;
    }
    value.pointer("/request/subtype").and_then(|s| s.as_str())
}

/// Convert a raw CLI `control_response` into a `ControlOutcome`.
///
/// Wire shape (mirrors the official Claude Agent SDKs):
///
/// ```json
/// // success
/// { "type": "control_response",
///   "response": { "subtype": "success", "request_id": "...", "response": { … } } }
///
/// // error
/// { "type": "control_response",
///   "response": { "subtype": "error", "request_id": "...", "error": "<message>" } }
/// ```
///
/// `outbound_subtype` is the subtype we sent on the corresponding
/// `control_request`. It's stamped onto `ControlRequestFailed` so callers
/// can branch on which command was rejected — the CLI's response only
/// tells us success/error, not which command produced it.
pub(super) fn parse_control_response(
    raw: &serde_json::Value,
    outbound_subtype: &str,
) -> ControlOutcome {
    let subtype = raw
        .pointer("/response/subtype")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match subtype {
        "success" => Ok(raw
            .pointer("/response/response")
            .cloned()
            .unwrap_or(serde_json::Value::Null)),
        "error" => {
            let message = raw
                .pointer("/response/error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "CLI returned control_response error without message".into());
            Err(SdkError::ControlRequestFailed {
                subtype: outbound_subtype.to_string(),
                message,
            })
        }
        other => Err(SdkError::ControlRequestFailed {
            subtype: outbound_subtype.to_string(),
            message: format!("unknown control_response subtype `{other}`"),
        }),
    }
}

pub(super) fn control_cancel_request_id(value: &serde_json::Value) -> Option<&str> {
    if value.get("type").and_then(|v| v.as_str()) == Some("control_cancel_request") {
        return value.get("request_id").and_then(|v| v.as_str());
    }
    None
}

/// Parse a raw JSON permission request (control_request) into a typed
/// `PermissionRequest`.
///
/// Extracts fields from the nested `request` object within the
/// `control_request` envelope. The `request_id` is stored in
/// `tool_use_id` so it can be echoed back in the response.
pub(super) fn parse_permission_request(value: &serde_json::Value) -> PermissionRequest {
    let request = value
        .get("request")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let request_id = value
        .get("request_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    PermissionRequest {
        tool_name: request
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        input: request
            .get("input")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        tool_use_id: request_id.to_string(),
        agent_id: request
            .get("agent_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        suggestions: request
            .get("permission_suggestions")
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        blocked_path: request
            .get("blocked_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        decision_reason: request
            .get("decision_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

/// Build a `control_request` envelope with a fresh `{id_prefix}_{nanos}`
/// request id. Returns `(request_id, envelope)`.
///
/// `request` is the inner object (must include a `subtype` field). Used
/// by the one-shot metadata probes ([`super::metadata`]) and the
/// `initialize` handshake in [`super::spawn`]. The counter-based
/// `control_request`s in [`super::control_commands`] mint their own ids
/// because they need to register a `pending_control` entry under that
/// id before sending.
pub(super) fn build_control_request(
    id_prefix: &str,
    request: serde_json::Value,
) -> (String, serde_json::Value) {
    let request_id = format!(
        "{id_prefix}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let envelope = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    });
    (request_id, envelope)
}

/// Build a `control_response` envelope acknowledging a CLI-initiated
/// `control_request` with `subtype: "success"` and an empty inner
/// `response`. Used by the reader to ack the CLI's own `initialize`
/// round-trip and by the metadata probes for the same purpose.
pub(super) fn build_success_ack(request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {}
        }
    })
}

/// Write a JSON value to the CLI's stdin as newline-terminated NDJSON.
///
/// Used by both `Query` methods and the background `reader_loop` to avoid
/// duplicating the lock-serialize-write-flush sequence.
pub(super) async fn write_to_stdin(
    process_stdin: &Mutex<Option<BufWriter<ChildStdin>>>,
    value: &serde_json::Value,
) -> Result<(), SdkError> {
    let mut guard = process_stdin.lock().await;
    let stdin = guard.as_mut().ok_or(SdkError::InputClosed)?;
    let json = serde_json::to_string(value).map_err(SdkError::SerializationError)?;
    debug!(stdin_json = %json, "writing to CLI stdin");
    stdin
        .write_all(json.as_bytes())
        .await
        .map_err(SdkError::IoError)?;
    stdin.write_all(b"\n").await.map_err(SdkError::IoError)?;
    stdin.flush().await.map_err(SdkError::IoError)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_request_subtype_extracts_correctly() {
        let pr = serde_json::json!({
            "type": "control_request",
            "request_id": "req_1_abc123",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Write",
                "input": { "path": "/tmp/foo" }
            }
        });
        assert_eq!(control_request_subtype(&pr), Some("can_use_tool"));

        let not_pr = serde_json::json!({ "type": "stream_event" });
        assert_eq!(control_request_subtype(&not_pr), None);

        let hook_req = serde_json::json!({
            "type": "control_request",
            "request_id": "req_2",
            "request": { "subtype": "hook_callback" }
        });
        assert_eq!(control_request_subtype(&hook_req), Some("hook_callback"));

        let init_req = serde_json::json!({
            "type": "control_request",
            "request_id": "req_3",
            "request": { "subtype": "initialize" }
        });
        assert_eq!(control_request_subtype(&init_req), Some("initialize"));
    }

    #[test]
    fn parse_permission_request_extracts_fields() {
        let pr = serde_json::json!({
            "type": "control_request",
            "request_id": "req_1_abc",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Edit",
                "input": { "file": "main.rs" },
                "agent_id": "agent_1",
                "blocked_path": "/src/main.rs",
                "decision_reason": "file write",
                "permission_suggestions": []
            }
        });
        let req = parse_permission_request(&pr);
        assert_eq!(req.tool_name, "Edit");
        assert_eq!(req.tool_use_id, "req_1_abc"); // request_id becomes tool_use_id
        assert_eq!(req.agent_id, Some("agent_1".to_string()));
        assert_eq!(req.blocked_path, Some("/src/main.rs".to_string()));
        assert_eq!(req.decision_reason, Some("file write".to_string()));
    }

    #[test]
    fn parse_control_response_success_returns_inner_response() {
        let raw = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "req_0_set_permission_mode_deadbeef",
                "response": { "ok": true }
            }
        });
        let outcome = parse_control_response(&raw, "set_permission_mode").expect("success");
        assert_eq!(outcome, serde_json::json!({ "ok": true }));
    }

    #[test]
    fn parse_control_response_success_with_no_inner_response_returns_null() {
        let raw = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "req_0" }
        });
        let outcome = parse_control_response(&raw, "set_model").expect("success");
        assert_eq!(outcome, serde_json::Value::Null);
    }

    #[test]
    fn parse_control_response_error_carries_outbound_subtype() {
        let raw = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "req_0",
                "error": "permission mode `nope` not recognized"
            }
        });
        let err = parse_control_response(&raw, "set_permission_mode").expect_err("must be err");
        match err {
            SdkError::ControlRequestFailed { subtype, message } => {
                assert_eq!(
                    subtype, "set_permission_mode",
                    "subtype must be the outbound command, not the response slot"
                );
                assert!(
                    message.contains("nope"),
                    "expected message to surface CLI error, got: {message}"
                );
            }
            other => panic!("expected ControlRequestFailed, got {other:?}"),
        }
    }

    #[test]
    fn parse_control_response_unknown_subtype_returns_error() {
        let raw = serde_json::json!({
            "type": "control_response",
            "response": { "subtype": "weird", "request_id": "req_0" }
        });
        let err = parse_control_response(&raw, "set_model").expect_err("must be err");
        match err {
            SdkError::ControlRequestFailed { subtype, message } => {
                assert_eq!(subtype, "set_model");
                assert!(
                    message.contains("weird"),
                    "message should mention the unknown response subtype, got: {message}"
                );
            }
            other => panic!("expected ControlRequestFailed, got {other:?}"),
        }
    }
}
