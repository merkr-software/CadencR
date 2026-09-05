mod adapter;
mod extensions;
mod model_config;
mod normalize;
mod permission_policy;

use std::ffi::OsString;
use std::sync::Arc;

use serde_json::Value;

use crate::domain::agents::acp::runtime::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::{AcpClientInfo, AcpProcessTreePolicy, AcpStderrPolicy};
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeAccessMode, RuntimeError, RuntimeSpawnConfig,
};

use self::adapter::CursorAcpAdapter;

pub(super) async fn session_finished(_runtime_session_id: &str) -> bool {
    false
}

pub(super) async fn spawn_acp_session(
    content: Value,
    config: RuntimeSpawnConfig,
) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
    let binary = cursor_agent_sdk_rs::resolve_binary().await?;
    let mut command = cli_discovery::login_shell_exec_command(
        binary.as_os_str(),
        cursor_acp_args(config.access_mode.as_ref()),
    );
    command.current_dir(&config.cwd);
    if let Some(env) = config.env.as_ref() {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let hooks = Arc::new(CursorAcpAdapter::new(config.access_mode.clone()));
    spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
        command,
        spawn_guard: None,
        client_info: AcpClientInfo::default(),
        stderr_policy: AcpStderrPolicy::Log,
        process_tree_policy: AcpProcessTreePolicy::Inherit,
        config,
        initial_content: content,
        // Cursor ACP does not currently report an authoritative context
        // window in its catalog/turn results. Do not guess from model names.
        context_window: None,
        hooks,
    })
    .await
}

fn cursor_acp_args(access_mode: Option<&RuntimeAccessMode>) -> Vec<OsString> {
    match access_mode {
        Some(RuntimeAccessMode::FullAccess) => vec![
            OsString::from("--force"),
            OsString::from("--sandbox"),
            OsString::from("disabled"),
            OsString::from("acp"),
        ],
        Some(RuntimeAccessMode::AutoReview) => vec![
            OsString::from("--auto-review"),
            OsString::from("--sandbox"),
            OsString::from("enabled"),
            OsString::from("acp"),
        ],
        Some(RuntimeAccessMode::Default) | None => vec![
            OsString::from("--sandbox"),
            OsString::from("enabled"),
            OsString::from("acp"),
        ],
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::cursor_acp_args;
    use crate::domain::agents::adapter::RuntimeAccessMode;

    #[test]
    fn maps_access_modes_to_cursor_cli_flags() {
        let sandboxed = vec![
            OsString::from("--sandbox"),
            OsString::from("enabled"),
            OsString::from("acp"),
        ];
        assert_eq!(cursor_acp_args(None), sandboxed);
        assert_eq!(
            cursor_acp_args(Some(&RuntimeAccessMode::Default)),
            vec![
                OsString::from("--sandbox"),
                OsString::from("enabled"),
                OsString::from("acp")
            ]
        );
        assert_eq!(
            cursor_acp_args(Some(&RuntimeAccessMode::FullAccess)),
            vec![
                OsString::from("--force"),
                OsString::from("--sandbox"),
                OsString::from("disabled"),
                OsString::from("acp")
            ]
        );
        assert_eq!(
            cursor_acp_args(Some(&RuntimeAccessMode::AutoReview)),
            vec![
                OsString::from("--auto-review"),
                OsString::from("--sandbox"),
                OsString::from("enabled"),
                OsString::from("acp")
            ]
        );
    }
}
