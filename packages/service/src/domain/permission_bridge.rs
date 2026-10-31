//! Shared permission bridge logic for routing tool-permission requests
//! through WebSocket to the frontend and awaiting user responses.
//!
//! Used by both the workflow engine (`WorkflowPermissionBridge`) and
//! the session handler (`WsBridgeCanUseTool`).

use std::sync::Arc;

use crate::domain::agents::adapter::{
    RuntimePermissionResponseKind, RuntimePermissionUpdate, RuntimeToolPermissionRequest,
    RuntimeToolPermissionResult,
};
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::handler::session_prompt::PermissionResponse;
use crate::domain::ws_session::protocol::{PermissionDecision, PermissionOptionPayload};
use crate::domain::ws_session::runtime::application::mark_agent_resumed;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

pub fn build_provider_permission_options(
    permission_updates: &[RuntimePermissionUpdate],
) -> Vec<PermissionOptionPayload> {
    let persistent_updates = persistent_permission_updates(permission_updates);
    let mut options = vec![PermissionOptionPayload {
        decision: PermissionDecision::AllowOnce,
        option_id: None,
        label: "Allow once".to_string(),
        description: "Approve this tool call only".to_string(),
        collect_feedback: false,
    }];
    if !persistent_updates.is_empty() {
        options.push(PermissionOptionPayload {
            decision: PermissionDecision::AllowFuture,
            option_id: None,
            label: "Allow future requests".to_string(),
            description: "Apply the provider's suggested permission update".to_string(),
            collect_feedback: false,
        });
    }
    options.push(PermissionOptionPayload {
        decision: PermissionDecision::Deny,
        option_id: None,
        label: "Deny".to_string(),
        description: "Reject this tool call".to_string(),
        collect_feedback: true,
    });
    options
}

pub fn persistent_permission_updates(
    permission_updates: &[RuntimePermissionUpdate],
) -> Vec<RuntimePermissionUpdate> {
    permission_updates
        .iter()
        .filter(|update| {
            matches!(
                update.data.get("destination").and_then(Value::as_str),
                Some("userSettings" | "projectSettings" | "localSettings")
            )
        })
        .cloned()
        .collect()
}

pub fn extract_permission_preview(input: &Value) -> Option<String> {
    preview_from_object(input)
        .or_else(|| {
            input
                .get("always")
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find_map(Value::as_str))
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            input
                .get("patterns")
                .and_then(Value::as_array)
                .and_then(|patterns| patterns.iter().find_map(Value::as_str))
                .map(ToOwned::to_owned)
        })
}

fn preview_from_object(input: &Value) -> Option<String> {
    preview_direct_value(input).or_else(|| {
        [
            "args",
            "arguments",
            "params",
            "metadata",
            "toolInput",
            "rawInput",
        ]
        .iter()
        .find_map(|key| input.get(*key).and_then(preview_from_object))
    })
}

fn preview_direct_value(input: &Value) -> Option<String> {
    [
        "command",
        "cmd",
        "script",
        "file_path",
        "filepath",
        "path",
        "filePath",
        "directory",
        "dir",
        "cwd",
        "target",
        "destination",
        "source",
        "url",
    ]
    .iter()
    .find_map(|key| preview_value(input.get(*key)))
}

pub fn provider_permission_description(request: &RuntimeToolPermissionRequest) -> String {
    request
        .decision_reason
        .clone()
        .or_else(|| {
            request
                .blocked_path
                .as_ref()
                .map(|path| format!("The provider requests permission for `{path}`"))
        })
        .unwrap_or_else(|| {
            format!(
                "The provider requests permission to use {}",
                request.tool_name
            )
        })
}

fn preview_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

/// Wait for a user response on the permission channel, clear the DB gate +
/// broadcast the next turn, and apply the decision.
///
/// Preconditions: the caller has already
/// - persisted the pending-input row via
///   [`crate::domain::ws_session::runtime::application::mark_awaiting_user`] (which both wrote the
///   `pending_*` column and broadcast `"askUser"`), and
/// - sent the matching `permission.request` WS envelope to the client.
///
/// On response this function calls
/// [`mark_agent_resumed`] which NULLs the given
/// column *before* broadcasting the terminal turn (`"agent"` / `"none"`),
/// closing the lag-recovery race where a snapshot re-read resurrected
/// `"askUser"` from a row that had already been answered.
#[allow(clippy::too_many_arguments)]
pub async fn wait_and_apply_decision(
    response_rx: &Arc<Mutex<mpsc::Receiver<PermissionResponse>>>,
    tool_use_id: &str,
    original_input: serde_json::Value,
    permission_updates: &[RuntimePermissionUpdate],
    session_status_tx: &crate::domain::session_status::SessionStatusBroadcaster,
    feature_id: i64,
    write_pool: &sqlx::SqlitePool,
    db_session_id: i64,
    clear_kind: crate::domain::ws_session::persistence::PendingUserInputKind,
) -> RuntimeToolPermissionResult {
    let mut rx = response_rx.lock().await;
    match rx.recv().await {
        Some(response) => {
            // Claude Code keeps streaming after `can_use_tool` returns Deny
            // with `interrupt: false`, so the turn stays on the agent until a
            // real Result arrives. Broadcasting Idle here would flip the
            // sidebar while the CLI is still working.
            mark_agent_resumed(
                write_pool,
                session_status_tx,
                db_session_id,
                feature_id,
                clear_kind,
                AgentStatus::Agent,
            )
            .await;
            let input = response.updated_input.unwrap_or(original_input);
            apply_decision(
                tool_use_id,
                response.decision,
                response.feedback,
                input,
                permission_updates,
            )
        }
        None => {
            // Channel closed before we got a response. Clear the DB gate AND
            // broadcast Idle so any connected client still showing Question
            // drops back to idle — otherwise the sidebar stays stuck even
            // after the gate is gone from the DB.
            mark_agent_resumed(
                write_pool,
                session_status_tx,
                db_session_id,
                feature_id,
                clear_kind,
                AgentStatus::Idle,
            )
            .await;
            RuntimeToolPermissionResult::Deny {
                message: "Permission channel closed".to_string(),
                interrupt: Some(false),
                tool_use_id: Some(tool_use_id.to_string()),
            }
        }
    }
}

/// Status broadcast on the direct-SDK response path (OpenCode per-tool
/// perms, AskUserQuestion). Deny ends the turn here because the caller
/// explicitly emits `session.ended` alongside this broadcast.
pub fn status_after_decision(decision: PermissionDecision) -> AgentStatus {
    match decision {
        PermissionDecision::AllowOnce | PermissionDecision::AllowFuture => AgentStatus::Agent,
        PermissionDecision::Deny => AgentStatus::Idle,
    }
}

pub fn status_after_approval(decision: PermissionDecision, feedback: Option<&str>) -> AgentStatus {
    match decision {
        PermissionDecision::AllowOnce | PermissionDecision::AllowFuture => AgentStatus::Agent,
        PermissionDecision::Deny => {
            let has_feedback = feedback.is_some_and(|f| !f.trim().is_empty());
            if has_feedback {
                AgentStatus::Agent
            } else {
                AgentStatus::Idle
            }
        }
    }
}

pub fn status_after_runtime_permission(
    kind: RuntimePermissionResponseKind,
    decision: PermissionDecision,
    feedback: Option<&str>,
) -> AgentStatus {
    match kind {
        RuntimePermissionResponseKind::PlanApproval => status_after_approval(decision, feedback),
        RuntimePermissionResponseKind::ContinueOnDeny
            if matches!(decision, PermissionDecision::Deny) =>
        {
            AgentStatus::Agent
        }
        RuntimePermissionResponseKind::ContinueOnDeny | RuntimePermissionResponseKind::Normal => {
            status_after_decision(decision)
        }
    }
}

pub fn runtime_permission_denial_completes_session(
    kind: RuntimePermissionResponseKind,
    decision: PermissionDecision,
    feedback: Option<&str>,
) -> bool {
    matches!(decision, PermissionDecision::Deny)
        && !matches!(kind, RuntimePermissionResponseKind::PlanApproval)
        && status_after_runtime_permission(kind, decision, feedback) == AgentStatus::Idle
}

#[cfg(test)]
mod tests {
    use super::{
        build_provider_permission_options, runtime_permission_denial_completes_session,
        status_after_approval, status_after_decision, status_after_runtime_permission,
    };
    use crate::domain::agents::adapter::{RuntimePermissionResponseKind, RuntimePermissionUpdate};
    use crate::domain::session_status::AgentStatus;
    use crate::domain::ws_session::protocol::PermissionDecision;

    #[test]
    fn deny_decision_ends_turn_on_direct_sdk_path() {
        assert_eq!(
            status_after_decision(PermissionDecision::Deny),
            AgentStatus::Idle
        );
    }

    #[test]
    fn allow_decisions_resume_agent_status() {
        assert_eq!(
            status_after_decision(PermissionDecision::AllowOnce),
            AgentStatus::Agent
        );
        assert_eq!(
            status_after_decision(PermissionDecision::AllowFuture),
            AgentStatus::Agent
        );
    }

    #[test]
    fn approval_deny_without_feedback_ends_turn() {
        assert_eq!(
            status_after_approval(PermissionDecision::Deny, None),
            AgentStatus::Idle,
        );
        assert_eq!(
            status_after_approval(PermissionDecision::Deny, Some("")),
            AgentStatus::Idle,
        );
        assert_eq!(
            status_after_approval(PermissionDecision::Deny, Some("   ")),
            AgentStatus::Idle,
        );
    }

    #[test]
    fn approval_deny_with_feedback_hands_turn_back_to_agent() {
        assert_eq!(
            status_after_approval(PermissionDecision::Deny, Some("not quite, try X")),
            AgentStatus::Agent,
        );
    }

    #[test]
    fn approval_allow_always_resumes_agent() {
        assert_eq!(
            status_after_approval(PermissionDecision::AllowOnce, None),
            AgentStatus::Agent,
        );
        assert_eq!(
            status_after_approval(PermissionDecision::AllowFuture, Some("extra note")),
            AgentStatus::Agent,
        );
    }

    #[test]
    fn runtime_permission_continue_on_deny_hands_turn_back_to_agent() {
        assert_eq!(
            status_after_runtime_permission(
                RuntimePermissionResponseKind::ContinueOnDeny,
                PermissionDecision::Deny,
                None,
            ),
            AgentStatus::Agent,
        );
    }

    #[test]
    fn runtime_permission_completion_uses_central_status_policy() {
        assert!(runtime_permission_denial_completes_session(
            RuntimePermissionResponseKind::Normal,
            PermissionDecision::Deny,
            None,
        ));
        assert!(!runtime_permission_denial_completes_session(
            RuntimePermissionResponseKind::ContinueOnDeny,
            PermissionDecision::Deny,
            None,
        ));
    }

    #[test]
    fn provider_permission_options_only_include_future_for_persistent_updates() {
        let without_updates = build_provider_permission_options(&[]);
        assert!(!without_updates
            .iter()
            .any(|option| option.decision == PermissionDecision::AllowFuture));

        let session_updates = vec![RuntimePermissionUpdate {
            data: serde_json::json!({
                "type": "addRules",
                "destination": "session",
            }),
        }];
        let with_session_updates = build_provider_permission_options(&session_updates);
        assert!(!with_session_updates
            .iter()
            .any(|option| option.decision == PermissionDecision::AllowFuture));

        let persistent_updates = vec![RuntimePermissionUpdate {
            data: serde_json::json!({
                "type": "addRules",
                "destination": "localSettings",
            }),
        }];
        let with_persistent_updates = build_provider_permission_options(&persistent_updates);
        assert!(with_persistent_updates
            .iter()
            .any(|option| option.decision == PermissionDecision::AllowFuture));
    }
}

/// Apply a provider-native permission decision. Persistent approvals are only
/// sent back when the provider supplied explicit permission updates.
fn apply_decision(
    tool_use_id: &str,
    decision: PermissionDecision,
    feedback: Option<String>,
    input: serde_json::Value,
    permission_updates: &[RuntimePermissionUpdate],
) -> RuntimeToolPermissionResult {
    match decision {
        PermissionDecision::AllowOnce | PermissionDecision::AllowFuture => {
            let updated_permissions = if matches!(decision, PermissionDecision::AllowFuture)
                && !permission_updates.is_empty()
            {
                Some(permission_updates.to_vec())
            } else {
                None
            };
            RuntimeToolPermissionResult::Allow {
                updated_input: input,
                updated_permissions,
                tool_use_id: Some(tool_use_id.to_string()),
            }
        }
        PermissionDecision::Deny => {
            let message = feedback.unwrap_or_else(|| "User denied permission".to_string());
            RuntimeToolPermissionResult::Deny {
                message,
                interrupt: Some(false),
                tool_use_id: Some(tool_use_id.to_string()),
            }
        }
    }
}

/// Wait for a user response on the permission channel and convert an
/// allow/deny into a `PermissionResult`. Used for approval gates such as
/// `ExitPlanMode` that bypass normal resolution.
#[allow(dead_code)]
pub async fn wait_for_approval(
    response_rx: &Arc<Mutex<mpsc::Receiver<PermissionResponse>>>,
    tool_use_id: &str,
    input: serde_json::Value,
    deny_message: &str,
) -> RuntimeToolPermissionResult {
    let mut rx = response_rx.lock().await;
    match rx.recv().await {
        Some(response) => match response.decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowFuture => {
                RuntimeToolPermissionResult::Allow {
                    updated_input: input,
                    updated_permissions: None,
                    tool_use_id: Some(tool_use_id.to_string()),
                }
            }
            PermissionDecision::Deny => {
                let feedback = response
                    .feedback
                    .unwrap_or_else(|| deny_message.to_string());
                RuntimeToolPermissionResult::Deny {
                    message: feedback,
                    interrupt: Some(false),
                    tool_use_id: Some(tool_use_id.to_string()),
                }
            }
        },
        None => RuntimeToolPermissionResult::Deny {
            message: "Approval channel closed".to_string(),
            interrupt: Some(false),
            tool_use_id: Some(tool_use_id.to_string()),
        },
    }
}
