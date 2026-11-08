use codex_app_server_sdk_rs::{CodexAppServerClient, CodexCommandKind};

use super::timeouts::{with_probe_timeout, PROBE_TIMEOUT};
use super::{profile_runtime::app_server_spawn_options, CodexAdapter};
use crate::domain::agents::adapter::{
    AgentRuntimeAdapter, RuntimeError, RuntimeSlashCommand, RuntimeSlashCommandKind,
};

impl From<CodexCommandKind> for RuntimeSlashCommandKind {
    fn from(kind: CodexCommandKind) -> Self {
        match kind {
            CodexCommandKind::Command => Self::Command,
            CodexCommandKind::Skill => Self::Skill,
        }
    }
}

pub(super) async fn runtime_slash_commands(
    cwd: &str,
    profile: Option<&str>,
) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
    let resolved = CodexAdapter
        .resolve_profile(profile, std::path::Path::new(cwd))
        .await?
        .expect("Codex always resolves a default profile");
    let secrets = super::app_server_failure::secrets(Some(&resolved.env));
    let client = CodexAppServerClient::spawn_with_options(app_server_spawn_options(
        Some(resolved.env),
        resolved.env_unset,
        Some(cwd.into()),
    ))
    .await
    .map_err(RuntimeError::from)?;
    let result = async {
        client.initialize_with_timeout(PROBE_TIMEOUT).await?;
        with_probe_timeout("Codex skills/list", client.list_commands_in_directory(cwd)).await
    }
    .await;
    client.shutdown().await;
    Ok(result
        .map_err(|error| super::app_server_failure::explain(&client, error, &secrets))?
        .into_iter()
        .map(|command| RuntimeSlashCommand {
            name: command.name,
            description: command.description,
            kind: command.kind.into(),
        })
        .collect())
}
