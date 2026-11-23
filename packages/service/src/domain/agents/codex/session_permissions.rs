use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::permissions::PendingCodexRequest;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionDecision, RuntimePermissionResponseKind,
};

pub(super) const PLAN_APPROVAL_REQUEST_PREFIX: &str = "codex_plan_approval_";

pub(super) async fn take_pending(
    pending_requests: &Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
    request_id: &str,
) -> Result<PendingCodexRequest, RuntimeError> {
    if let Some(request) = pending_requests.lock().await.remove(request_id) {
        return Ok(request);
    }
    Err(RuntimeError::new(
        "received permission response for unknown Codex request",
    ))
}

pub(super) fn is_plan_approval_request_id(request_id: &str) -> bool {
    request_id.starts_with(PLAN_APPROVAL_REQUEST_PREFIX)
}

/// How closing `request_id` unanswered (Escape, a rejected plan) reaches
/// Codex. Neither a plan approval nor an async question blocks a turn: the
/// plan arrives once its turn is done, and any answer to it becomes the next
/// prompt, so a close must drop it rather than send a revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UnansweredClose {
    /// Nothing to tell Codex: the plan is dropped.
    DropPlan,
    /// The async question is withdrawn from Codex.
    WithdrawQuestion,
    /// Codex waits on it: the caller denies it and stops the turn.
    Blocking,
}

pub(super) fn unanswered_close(request_id: &str) -> UnansweredClose {
    if is_plan_approval_request_id(request_id) {
        UnansweredClose::DropPlan
    } else if super::async_questions::is_async_question(request_id) {
        UnansweredClose::WithdrawQuestion
    } else {
        UnansweredClose::Blocking
    }
}

pub(super) fn permission_kind_for_request_id(request_id: &str) -> RuntimePermissionResponseKind {
    if is_plan_approval_request_id(request_id) {
        RuntimePermissionResponseKind::PlanApproval
    } else {
        RuntimePermissionResponseKind::ContinueOnDeny
    }
}

pub(super) fn plan_approval_prompt(
    decision: RuntimePermissionDecision,
    feedback: Option<String>,
) -> String {
    match decision {
        RuntimePermissionDecision::AllowOnce
        | RuntimePermissionDecision::AllowFuture
        | RuntimePermissionDecision::AllowForSession => {
            "Plan approved. Proceed with execution.".to_string()
        }
        RuntimePermissionDecision::Deny => feedback
            .filter(|feedback| !feedback.trim().is_empty())
            .map(|feedback| format!("User feedback on plan rejection:\n\n{feedback}"))
            .unwrap_or_else(|| "Plan rejected. Revise the plan.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde_json::json;
    use tokio::sync::Mutex;

    use super::{
        is_plan_approval_request_id, permission_kind_for_request_id, plan_approval_prompt,
        take_pending, unanswered_close, UnansweredClose,
    };
    use crate::domain::agents::adapter::{
        RuntimePermissionDecision, RuntimePermissionResponseKind,
    };
    use crate::domain::agents::codex::permissions::PendingCodexRequest;
    use crate::domain::agents::codex::server_request_method::CodexServerRequestMethod;

    #[test]
    fn identifies_synthetic_plan_approval_requests() {
        assert!(is_plan_approval_request_id("codex_plan_approval_plan_1"));
        assert!(!is_plan_approval_request_id("approval_1"));
    }

    /// Closing a plan used to deny it, which Codex reads as "revise the plan":
    /// it started a new turn instead of stopping.
    #[test]
    fn closing_a_plan_drops_it_without_a_revision_prompt() {
        assert_eq!(
            unanswered_close("codex_plan_approval_plan_1"),
            UnansweredClose::DropPlan
        );
        assert_eq!(unanswered_close("approval_1"), UnansweredClose::Blocking);
    }

    #[test]
    fn codex_permission_denials_keep_turn_running() {
        assert_eq!(
            permission_kind_for_request_id("approval_1"),
            RuntimePermissionResponseKind::ContinueOnDeny
        );
        assert_eq!(
            permission_kind_for_request_id("codex_plan_approval_plan_1"),
            RuntimePermissionResponseKind::PlanApproval
        );
    }

    #[tokio::test]
    async fn take_pending_requires_exact_request_id() {
        let pending = Arc::new(Mutex::new(HashMap::from([(
            "approval_1".to_string(),
            PendingCodexRequest {
                id: json!("approval_1"),
                method: CodexServerRequestMethod::CommandExecutionApproval,
                params: json!({}),
            },
        )])));

        let error = take_pending(&pending, "wrong_id")
            .await
            .expect_err("unknown id should fail");
        assert!(error.to_string().contains("unknown Codex request"));
    }

    #[tokio::test]
    async fn take_pending_removes_request_atomically() {
        let pending = Arc::new(Mutex::new(HashMap::from([(
            "approval_1".to_string(),
            PendingCodexRequest {
                id: json!("approval_1"),
                method: CodexServerRequestMethod::CommandExecutionApproval,
                params: json!({}),
            },
        )])));

        let request = take_pending(&pending, "approval_1")
            .await
            .expect("pending request should resolve");
        assert_eq!(
            request.method,
            CodexServerRequestMethod::CommandExecutionApproval
        );
        assert!(pending.lock().await.is_empty());
        assert!(take_pending(&pending, "approval_1").await.is_err());
    }

    #[test]
    fn plan_approval_prompt_preserves_rejection_feedback() {
        assert_eq!(
            plan_approval_prompt(RuntimePermissionDecision::AllowOnce, None),
            "Plan approved. Proceed with execution."
        );
        assert_eq!(
            plan_approval_prompt(
                RuntimePermissionDecision::Deny,
                Some("Please inspect package scripts first".to_string())
            ),
            "User feedback on plan rejection:\n\nPlease inspect package scripts first"
        );
        assert_eq!(
            plan_approval_prompt(RuntimePermissionDecision::Deny, Some("  ".to_string())),
            "Plan rejected. Revise the plan."
        );
    }
}
