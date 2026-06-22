use crate::domain::agents::adapter::{RuntimeAccessMode, RuntimePermissionMode};
use crate::domain::settings;

#[cfg(test)]
pub type CodexAccessMode = RuntimeAccessMode;

pub const ACCESS_MODE_SETTING_KEY: &str = "codex_permission_mode";
pub const DEFAULT_ACCESS_MODE_WIRE: &str = "default";

pub fn accepts_model(model: &str) -> bool {
    let trimmed = model.trim();
    // Codex owns only bare OpenAI-style model ids. Slash-qualified refs
    // (`provider/model`) stay available to OpenCode via adapter order.
    !trimmed.contains('/') && (trimmed.starts_with("gpt-") || trimmed.starts_with("codex-"))
}

pub fn parse_access_mode(mode: Option<&str>) -> RuntimeAccessMode {
    mode.and_then(parse_access_mode_wire)
        .unwrap_or(RuntimeAccessMode::Default)
}

pub fn parse_access_mode_wire(mode: &str) -> Option<RuntimeAccessMode> {
    match mode {
        "default" => Some(RuntimeAccessMode::Default),
        "fullAccess" => Some(RuntimeAccessMode::FullAccess),
        "autoReview" => Some(RuntimeAccessMode::AutoReview),
        _ => None,
    }
}

pub fn access_mode_wire(mode: &RuntimeAccessMode) -> &'static str {
    match mode {
        RuntimeAccessMode::Default => "default",
        RuntimeAccessMode::FullAccess => "fullAccess",
        RuntimeAccessMode::AutoReview => "autoReview",
    }
}

pub async fn configured_access_mode(read_pool: &sqlx::SqlitePool) -> String {
    settings::resolve_setting(
        read_pool,
        ACCESS_MODE_SETTING_KEY,
        None,
        None,
        Some(DEFAULT_ACCESS_MODE_WIRE),
    )
    .await
    .unwrap_or_else(|| DEFAULT_ACCESS_MODE_WIRE.to_string())
}

pub fn canonical_access_mode_wire(raw_mode: &str) -> Option<String> {
    parse_access_mode_wire(raw_mode).map(|mode| access_mode_wire(&mode).to_string())
}

pub fn approval_policy(
    mode: Option<&RuntimePermissionMode>,
    access_mode: Option<&RuntimeAccessMode>,
) -> serde_json::Value {
    match (mode, access_mode) {
        (_, Some(RuntimeAccessMode::FullAccess))
        | (Some(RuntimePermissionMode::BypassPermissions), _)
        | (Some(RuntimePermissionMode::DontAsk), _) => {
            serde_json::Value::String("never".to_string())
        }
        _ => serde_json::Value::String("on-request".to_string()),
    }
}

pub fn approvals_reviewer(access_mode: Option<&RuntimeAccessMode>) -> serde_json::Value {
    match access_mode {
        Some(RuntimeAccessMode::AutoReview) => serde_json::Value::String("auto_review".to_string()),
        _ => serde_json::Value::String("user".to_string()),
    }
}

pub fn sandbox_mode(
    mode: Option<&RuntimePermissionMode>,
    access_mode: Option<&RuntimeAccessMode>,
) -> serde_json::Value {
    // Plan mode does NOT change the sandbox: planning is signaled via the
    // `plan_mode` hint emitted at turn start (see codex/turn_start.rs). This
    // keeps the user's chosen permission level intact while still asking the
    // model to plan rather than execute. Only the explicit "Full Access"
    // escape hatch (mapped from BypassPermissions) widens the sandbox.
    match (mode, access_mode) {
        (_, Some(RuntimeAccessMode::FullAccess))
        | (Some(RuntimePermissionMode::BypassPermissions), _)
        | (Some(RuntimePermissionMode::DontAsk), _) => {
            serde_json::Value::String("danger-full-access".to_string())
        }
        _ => serde_json::Value::String("workspace-write".to_string()),
    }
}

pub fn sandbox_policy(
    mode: Option<&RuntimePermissionMode>,
    access_mode: Option<&RuntimeAccessMode>,
    cwd: &std::path::Path,
) -> serde_json::Value {
    match (mode, access_mode) {
        (_, Some(RuntimeAccessMode::FullAccess))
        | (Some(RuntimePermissionMode::BypassPermissions), _) => {
            serde_json::json!({ "type": "dangerFullAccess" })
        }
        _ => serde_json::json!({
            "type": "workspaceWrite",
            "writableRoots": workspace_writable_roots(cwd),
            "readOnlyAccess": { "type": "fullAccess" },
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        }),
    }
}

fn workspace_writable_roots(cwd: &std::path::Path) -> Vec<String> {
    workspace_writable_roots_with_ssh_parent(
        cwd,
        crate::shared::ssh_env::current_ssh_auth_sock_parent(),
    )
}

fn workspace_writable_roots_with_ssh_parent(
    cwd: &std::path::Path,
    ssh_auth_sock_parent: Option<std::path::PathBuf>,
) -> Vec<String> {
    let cwd = cwd.to_string_lossy().to_string();
    let mut roots = vec![cwd.clone()];
    if let Some(root) = ssh_auth_sock_parent.map(|path| path.to_string_lossy().to_string()) {
        if root != cwd {
            roots.push(root);
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::{
        approval_policy, approvals_reviewer, sandbox_policy,
        workspace_writable_roots_with_ssh_parent, CodexAccessMode, RuntimePermissionMode,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn approval_policy_uses_interactive_on_request_for_codex_escalations() {
        assert_eq!(approval_policy(None, None), serde_json::json!("on-request"));
        assert_eq!(
            approval_policy(Some(&RuntimePermissionMode::AcceptEdits), None),
            serde_json::json!("on-request")
        );
        assert_eq!(
            approval_policy(Some(&RuntimePermissionMode::Plan), None),
            serde_json::json!("on-request")
        );
        assert_eq!(
            approval_policy(Some(&RuntimePermissionMode::BypassPermissions), None),
            serde_json::json!("never")
        );
    }

    #[test]
    fn plan_mode_keeps_workspace_write_sandbox() {
        // Codex has no native plan flag. We signal planning via the turn-start
        // `plan_mode` hint, NOT by narrowing the sandbox — see
        // codex/turn_start.rs and codex/model.rs::sandbox_policy.
        let policy = sandbox_policy(
            Some(&RuntimePermissionMode::Plan),
            None,
            Path::new("/tmp/app"),
        );
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["writableRoots"][0], "/tmp/app");
    }

    #[test]
    fn workspace_write_policy_matches_codex_schema() {
        let policy = sandbox_policy(None, None, Path::new("/tmp/app"));
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["writableRoots"][0], "/tmp/app");
        assert_eq!(policy["readOnlyAccess"]["type"], "fullAccess");
        assert_eq!(policy["networkAccess"], false);
        assert_eq!(policy["excludeTmpdirEnvVar"], false);
        assert_eq!(policy["excludeSlashTmp"], false);
    }

    #[test]
    fn full_access_policy_uses_danger_full_access() {
        let policy = sandbox_policy(
            Some(&RuntimePermissionMode::BypassPermissions),
            Some(&CodexAccessMode::Default),
            Path::new("/tmp/app"),
        );
        assert_eq!(policy["type"], "dangerFullAccess");
    }

    #[test]
    fn workspace_write_policy_includes_ssh_auth_sock_parent() {
        let roots = workspace_writable_roots_with_ssh_parent(
            Path::new("/tmp/app"),
            Some(PathBuf::from("/tmp/com.apple.launchd.test")),
        );

        assert_eq!(roots, vec!["/tmp/app", "/tmp/com.apple.launchd.test"]);
    }

    #[test]
    fn codex_access_modes_map_to_app_server_policy() {
        assert_eq!(
            approval_policy(None, Some(&CodexAccessMode::Default)),
            serde_json::json!("on-request")
        );
        assert_eq!(
            approvals_reviewer(Some(&CodexAccessMode::Default)),
            serde_json::json!("user")
        );
        assert_eq!(
            approval_policy(None, Some(&CodexAccessMode::FullAccess)),
            serde_json::json!("never")
        );
        assert_eq!(
            approvals_reviewer(Some(&CodexAccessMode::FullAccess)),
            serde_json::json!("user")
        );
        assert_eq!(
            approval_policy(None, Some(&CodexAccessMode::AutoReview)),
            serde_json::json!("on-request")
        );
        assert_eq!(
            approvals_reviewer(Some(&CodexAccessMode::AutoReview)),
            serde_json::json!("auto_review")
        );
    }

    #[test]
    fn auto_review_keeps_workspace_write_sandbox() {
        let policy = sandbox_policy(
            None,
            Some(&CodexAccessMode::AutoReview),
            Path::new("/tmp/app"),
        );
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["writableRoots"][0], "/tmp/app");
    }
}
