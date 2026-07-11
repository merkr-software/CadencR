use std::path::Path;

use serde_json::{json, Value};

use super::model::{approval_policy, approvals_reviewer, sandbox_policy};
use crate::domain::agents::adapter::{RuntimeAccessMode, RuntimePermissionMode};

pub(super) fn turn_start_params(
    thread_id: &str,
    input: Vec<Value>,
    cwd: &Path,
    permission_mode: Option<&RuntimePermissionMode>,
    access_mode: Option<&RuntimeAccessMode>,
    model: Option<String>,
    effort: Option<String>,
) -> Value {
    let collaboration_mode =
        collaboration_mode(permission_mode, model.as_deref(), effort.as_deref());
    let mut params = json!({
        "threadId": thread_id,
        "input": input,
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": approval_policy(permission_mode, access_mode),
        "approvalsReviewer": approvals_reviewer(access_mode),
        "sandboxPolicy": sandbox_policy(permission_mode, access_mode, cwd),
        "summary": "detailed",
    });
    if let Some(model) = model {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = effort {
        params["effort"] = Value::String(effort);
    }
    if let Some(collaboration_mode) = collaboration_mode {
        params["collaborationMode"] = collaboration_mode;
    }
    params
}

pub(super) fn collaboration_mode(
    permission_mode: Option<&RuntimePermissionMode>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Option<Value> {
    let model = model?;
    // Codex persists collaboration mode on the server thread, so send the
    // default mode explicitly when Cadencr leaves plan mode.
    let mode = if matches!(permission_mode, Some(RuntimePermissionMode::Plan)) {
        "plan"
    } else {
        "default"
    };
    Some(json!({
        "mode": mode,
        "settings": {
            "model": model,
            "reasoning_effort": effort,
            // Null means "use Codex's built-in instructions for this
            // collaboration mode". Supplying Cadencr's generic developer
            // guidance here replaces Codex's Plan Mode prompt, leaving the
            // runtime marked as plan while the model is not told how to behave
            // in plan mode. Cadencr guidance is sent separately via thread
            // config / base instructions.
            "developer_instructions": null
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::turn_start_params;
    use std::path::Path;

    #[test]
    fn turn_start_requests_detailed_reasoning_summaries_and_effort() {
        let params = turn_start_params(
            "thread",
            vec![serde_json::json!({ "type": "text", "text": "hello" })],
            Path::new("/tmp/app"),
            None,
            None,
            Some("gpt-5.6-sol".to_string()),
            Some("ultra".to_string()),
        );

        assert_eq!(params["summary"], "detailed");
        assert_eq!(params["effort"], "ultra");
        assert_eq!(params["model"], "gpt-5.6-sol");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            "ultra"
        );
    }

    #[test]
    fn turn_start_maps_plan_mode_to_codex_collaboration_mode() {
        let params = turn_start_params(
            "thread",
            vec![serde_json::json!({ "type": "text", "text": "plan" })],
            Path::new("/tmp/app"),
            Some(&crate::domain::agents::adapter::RuntimePermissionMode::Plan),
            None,
            Some("gpt-5.5".to_string()),
            Some("high".to_string()),
        );

        assert_eq!(params["collaborationMode"]["mode"], "plan");
        assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-5.5");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            "high"
        );
        assert!(
            params["collaborationMode"]["settings"]["developer_instructions"].is_null(),
            "Codex must use its built-in Plan Mode instructions; a custom \
             collaboration developer prompt replaces them and makes the model \
             unaware that runtime plan mode is active"
        );
    }

    #[test]
    fn turn_start_omits_collaboration_mode_without_model() {
        let params = turn_start_params(
            "thread",
            vec![serde_json::json!({ "type": "text", "text": "plan" })],
            Path::new("/tmp/app"),
            Some(&crate::domain::agents::adapter::RuntimePermissionMode::Plan),
            None,
            None,
            Some("high".to_string()),
        );

        assert!(params.get("collaborationMode").is_none());
    }

    #[test]
    fn turn_start_resets_codex_collaboration_mode_after_plan_mode() {
        let params = turn_start_params(
            "thread",
            vec![serde_json::json!({ "type": "text", "text": "approved" })],
            Path::new("/tmp/app"),
            Some(&crate::domain::agents::adapter::RuntimePermissionMode::AcceptEdits),
            None,
            Some("gpt-5.5".to_string()),
            Some("high".to_string()),
        );

        assert_eq!(params["collaborationMode"]["mode"], "default");
        assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-5.5");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            "high"
        );
    }
}
