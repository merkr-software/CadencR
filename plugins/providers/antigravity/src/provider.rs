use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use agent_client_protocol::schema::v1::SessionConfigOption;
use cadencr_provider_sdk::{
    CadencrProvider, HostIntegration, ProviderError, ResumeCommand, SlashCommand,
    SESSION_ID_PLACEHOLDER,
};

use crate::{catalog, cli, relay};

pub struct AntigravityProvider;

impl CadencrProvider for AntigravityProvider {
    fn models(
        &self,
        cwd: &Path,
        _provider_args: &[OsString],
    ) -> Result<Vec<SessionConfigOption>, ProviderError> {
        let binary = cli::resolve()?;
        cli::runtime()?.block_on(catalog::discover(&binary, cwd))
    }

    fn slash_commands(&self, cwd: &Path) -> Result<Option<Vec<SlashCommand>>, ProviderError> {
        cli::resolve()?;
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .filter(|home| home.is_absolute());
        Ok(Some(crate::slash_commands::commands(cwd, home.as_deref())?))
    }

    fn run_acp(&self, provider_args: &[OsString]) -> Result<ExitCode, ProviderError> {
        let binary = cli::resolve()?;
        let runtime = cli::runtime()?;
        let result = runtime.block_on(relay::run(&binary, provider_args));
        // Tokio stdin has a blocking reader that cannot be cancelled when
        // the agent or a signal closes the connection first.
        runtime.shutdown_timeout(cli::STDIN_SHUTDOWN);
        result
    }

    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    fn host_integration(&self) -> Result<Option<HostIntegration>, ProviderError> {
        Ok(Some(
            HostIntegration::builder()
                .compact_command("compact")
                .exclude_launcher_ports(true)
                .worktree_config_paths(
                    [
                        "AGENTS.md",
                        "GEMINI.md",
                        ".agents/agents",
                        ".agents/hooks.json",
                        ".agents/mcp_config.json",
                        ".agents/plugins",
                        ".agents/rules",
                        ".agents/skills",
                    ]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                )
                .resume_command(
                    ResumeCommand::builder()
                        .program(cli::BINARY)
                        .args(vec!["--conversation".into(), SESSION_ID_PLACEHOLDER.into()])
                        .build(),
                )
                .build(),
        ))
    }
}
