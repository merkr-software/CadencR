//! OpenCode 2.x (`@opencode/cli`) over ACP.
//!
//! 2.x `opencode acp` takes no `--cwd/--hostname/--port`: it speaks ACP on
//! stdio and keeps its HTTP server private (random port and password). What
//! the 1.x adapter fetched over that side channel now rides ACP itself, through
//! extensions [`wire`] translates; out-of-band session operations (move, fork)
//! go through `opencode api --standalone` on the same database.

mod hooks;
mod session_location;
mod wire;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use self::hooks::OpenCodeV2Hooks;
use self::wire::OpenCodeV2Wire;
use super::instructions::apply_instruction_config;
use crate::domain::agents::acp::runtime::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::{AcpClientInfo, AcpProcessTreePolicy, AcpStderrPolicy};
use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeError, RuntimePurpose, RuntimeSpawnConfig,
};

/// The `opencode acp` command for 2.x; the session directory rides
/// `session/new` and the process starts in it.
pub(in crate::domain::agents::opencode) fn acp_command(
    binary: &Path,
    cwd: &Path,
    session: Option<&cli_discovery::ChildSession>,
) -> tokio::process::Command {
    let mut command = cli_discovery::login_shell_session_command(
        binary.as_os_str(),
        [OsString::from("acp")],
        session,
    );
    command.current_dir(cwd);
    command
}

pub(in crate::domain::agents::opencode) async fn spawn_session(
    binary: PathBuf,
    content: Value,
    mut config: RuntimeSpawnConfig,
) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
    let enable_todos = !matches!(config.purpose, Some(RuntimePurpose::AutoName));
    let instructions_dir = apply_instruction_config(&mut config, enable_todos)?;
    let child_session = crate::domain::agents::process_sessions::for_runtime(&config);
    let mut command = acp_command(&binary, &config.cwd, child_session.as_ref());
    if let Some(env) = config.env.as_ref() {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let context_window = match config.model.as_deref() {
        Some(model) => {
            crate::domain::agents::providers::opencode::context_window_for_model(model).await
        }
        None => None,
    };
    let wire = OpenCodeV2Wire::new(config.cwd.clone(), session_database());
    spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
        command,
        child_session,
        // Keep any instructions file alive for the process lifetime via hooks.
        spawn_guard: None,
        client_info: AcpClientInfo::default(),
        stderr_policy: AcpStderrPolicy::Log,
        process_tree_policy: AcpProcessTreePolicy::Inherit,
        config,
        initial_content: content,
        context_window,
        hooks: Arc::new(OpenCodeV2Hooks::new(binary, instructions_dir)),
        wire_transform: Some(Arc::new(wire)),
    })
    .await
}

/// OpenCode's database: `OPENCODE_DB` (absolute, or relative to the data
/// directory), else `opencode.db` in the data directory.
fn session_database() -> Option<PathBuf> {
    let data = crate::domain::imports::opencode_data_dir()?;
    match std::env::var_os("OPENCODE_DB").map(PathBuf::from) {
        Some(path) if path.as_os_str() == ":memory:" => None,
        Some(path) if path.is_absolute() => Some(path),
        Some(path) => Some(data.join(path)),
        None => Some(data.join("opencode.db")),
    }
}
