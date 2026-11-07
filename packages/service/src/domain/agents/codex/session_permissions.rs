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
        take_pending,
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
