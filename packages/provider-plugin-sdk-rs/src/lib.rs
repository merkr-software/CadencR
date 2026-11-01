//! SDK and CLI harness for code-backed Cadencr provider packages.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use agent_client_protocol::schema::v1::SessionConfigOption;

mod host_integration;
pub mod meta;
mod slash_commands;
mod updates;
pub use host_integration::{
    HostIntegration, ResumeCommand, HOST_INTEGRATION_FORMAT, SESSION_ID_PLACEHOLDER,
};
pub use slash_commands::{
    is_valid_slash_command_name, sanitize_slash_command_description, validate_slash_commands,
    SlashCommand, SlashCommandKind, MAX_SLASH_COMMANDS, MAX_SLASH_COMMAND_DESCRIPTION_CHARS,
    MAX_SLASH_COMMAND_NAME_CHARS, SLASH_COMMANDS_FORMAT,
};
pub use updates::{UpdateReport, UPDATE_REPORT_FORMAT};

pub const MODEL_DISCOVERY_FORMAT: &str = "acp-config-options-v1";
pub const ACP_V1_PROTOCOL: &str = "acp-v1";

#[derive(Debug)]
pub struct ProviderError(String);

impl ProviderError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProviderError {}

impl From<std::io::Error> for ProviderError {
    fn from(error: std::io::Error) -> Self {
        Self::new(error.to_string())
    }
}

impl From<serde_json::Error> for ProviderError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(error.to_string())
    }
}

pub trait CadencrProvider {
    fn models(
        &self,
        cwd: &Path,
        provider_args: &[OsString],
    ) -> Result<Vec<SessionConfigOption>, ProviderError>;
    fn run_acp(&self, provider_args: &[OsString]) -> Result<ExitCode, ProviderError>;
    fn version(&self) -> &str;

    /// Versions of whatever this connector can upgrade (usually its native
    /// CLI). `None` (the default) tells Cadencr updates are not managed here.
    fn updates(&self) -> Result<Option<UpdateReport>, ProviderError> {
        Ok(None)
    }

    /// Install `target` (or the latest version when `None`). Returns an
    /// optional human-readable summary shown to the user.
    fn update(&self, _target: Option<&str>) -> Result<Option<String>, ProviderError> {
        Err(ProviderError::new("this provider does not manage updates"))
    }

    /// Host conventions this provider opts into (compaction command, worktree
    /// configuration paths, terminal resume command). `None` (the default)
    /// prints `{}`: no host integration.
    fn host_integration(&self) -> Result<Option<HostIntegration>, ProviderError> {
        Ok(None)
    }

    /// The `/name` commands and skills the native agent accepts in a prompt
    /// for `cwd`, matching what its ACP `available_commands_update` would
    /// list there. `None` (the default) exits non-zero: Cadencr then shows
    /// the list the last live session advertised for that directory.
    fn slash_commands(&self, _cwd: &Path) -> Result<Option<Vec<SlashCommand>>, ProviderError> {
        Ok(None)
    }
}

pub fn run_cli(provider: &impl CadencrProvider) -> ExitCode {
    match execute(provider, std::env::args_os().skip(1).collect()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn execute(
    provider: &impl CadencrProvider,
    args: Vec<OsString>,
) -> Result<ExitCode, ProviderError> {
    let Some(command) = args.first().and_then(|value| value.to_str()) else {
        return Err(ProviderError::new(
            "expected `models`, `run`, `version`, `updates`, `update`, `host-integration`, \
             or `slash-commands`",
        ));
    };
    match command {
        "models" => execute_models(provider, &args[1..]),
        "run" => execute_run(provider, &args[1..]),
        "updates" => updates::execute_updates(provider, &args[1..]),
        "update" => updates::execute_update(provider, &args[1..]),
        "host-integration" => host_integration::execute_host_integration(provider, &args[1..]),
        "slash-commands" => slash_commands::execute_slash_commands(provider, &args[1..]),
        "version" if args.len() == 1 => {
            println!("{}", provider.version());
            Ok(ExitCode::SUCCESS)
        }
        _ => Err(ProviderError::new(format!(
            "unknown or invalid provider command `{command}`"
        ))),
    }
}

fn execute_models(
    provider: &impl CadencrProvider,
    args: &[OsString],
) -> Result<ExitCode, ProviderError> {
    if args.len() < 4 || args[0] != "--format" || args[2] != "--cwd" {
        return Err(ProviderError::new(format!(
            "models requires `--format {MODEL_DISCOVERY_FORMAT} --cwd <absolute-path>`"
        )));
    }
    if args[1] != MODEL_DISCOVERY_FORMAT {
        return Err(ProviderError::new(format!(
            "models requires `--format {MODEL_DISCOVERY_FORMAT}`"
        )));
    }
    let cwd = PathBuf::from(&args[3]);
    if !cwd.is_absolute() {
        return Err(ProviderError::new("models `--cwd` must be absolute"));
    }
    serde_json::to_writer(
        std::io::stdout().lock(),
        &provider.models(&cwd, &args[4..])?,
    )?;
    println!();
    Ok(ExitCode::SUCCESS)
}

fn execute_run(
    provider: &impl CadencrProvider,
    args: &[OsString],
) -> Result<ExitCode, ProviderError> {
    if args.len() < 2 || args[0] != "--protocol" || args[1] != ACP_V1_PROTOCOL {
        return Err(ProviderError::new(format!(
            "run requires `--protocol {ACP_V1_PROTOCOL}`"
        )));
    }
    provider.run_acp(&args[2..])
}

#[cfg(test)]
mod tests {
    use super::{execute, CadencrProvider, ProviderError};
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use std::path::Path;
    use std::process::ExitCode;

    struct FixtureProvider;

    impl CadencrProvider for FixtureProvider {
        fn models(
            &self,
            _cwd: &Path,
            _provider_args: &[std::ffi::OsString],
        ) -> Result<Vec<SessionConfigOption>, ProviderError> {
            Ok(Vec::new())
        }

        fn run_acp(
            &self,
            _provider_args: &[std::ffi::OsString],
        ) -> Result<ExitCode, ProviderError> {
            Ok(ExitCode::SUCCESS)
        }

        fn version(&self) -> &str {
            "1.2.3"
        }
    }

    #[test]
    fn rejects_missing_and_non_absolute_model_arguments() {
        let provider = FixtureProvider;
        assert!(execute(&provider, vec!["models".into()]).is_err());
        assert!(execute(
            &provider,
            vec![
                "models".into(),
                "--format".into(),
                "acp-config-options-v1".into(),
                "--cwd".into(),
                "relative".into(),
            ],
        )
        .is_err());
    }

    #[test]
    fn update_commands_default_to_unsupported() {
        let updates = execute(
            &FixtureProvider,
            vec![
                "updates".into(),
                "--format".into(),
                "cadencr-updates-v1".into(),
            ],
        );
        assert_eq!(updates.unwrap(), ExitCode::SUCCESS);
        assert!(execute(&FixtureProvider, vec!["updates".into()]).is_err());
        assert_eq!(
            execute(&FixtureProvider, vec!["update".into()]).unwrap(),
            ExitCode::FAILURE
        );
        assert!(execute(
            &FixtureProvider,
            vec!["update".into(), "--version".into(), " ".into()],
        )
        .is_err());
    }

    #[test]
    fn host_integration_defaults_to_none_and_checks_the_format() {
        let command = |format: &str| {
            execute(
                &FixtureProvider,
                vec!["host-integration".into(), "--format".into(), format.into()],
            )
        };
        assert_eq!(
            command("cadencr-host-integration-v1").unwrap(),
            ExitCode::SUCCESS
        );
        assert!(command("cadencr-host-integration-v2").is_err());
        assert!(execute(&FixtureProvider, vec!["host-integration".into()]).is_err());
    }

    #[test]
    fn slash_commands_default_to_unsupported_and_check_arguments() {
        let command = |args: &[&str]| {
            let mut full = vec![std::ffi::OsString::from("slash-commands")];
            full.extend(args.iter().map(std::ffi::OsString::from));
            execute(&FixtureProvider, full)
        };
        let valid = ["--format", "cadencr-slash-commands-v1", "--cwd", "/repo"];
        // Unsupported is an error without stdout, like an older package.
        assert!(command(&valid).is_err());
        assert!(command(&["--format", "cadencr-slash-commands-v2", "--cwd", "/repo"]).is_err());
        assert!(command(&["--format", "cadencr-slash-commands-v1", "--cwd", "repo"]).is_err());
        assert!(command(&["--format", "cadencr-slash-commands-v1"]).is_err());
    }

    #[test]
    fn slash_commands_print_or_report_failures() {
        struct Listing(Result<Vec<super::SlashCommand>, &'static str>);
        impl CadencrProvider for Listing {
            fn models(
                &self,
                _cwd: &Path,
                _provider_args: &[std::ffi::OsString],
            ) -> Result<Vec<SessionConfigOption>, ProviderError> {
                Ok(Vec::new())
            }
            fn run_acp(
                &self,
                _provider_args: &[std::ffi::OsString],
            ) -> Result<ExitCode, ProviderError> {
                Ok(ExitCode::SUCCESS)
            }
            fn version(&self) -> &str {
                "1.0.0"
            }
            fn slash_commands(
                &self,
                cwd: &Path,
            ) -> Result<Option<Vec<super::SlashCommand>>, ProviderError> {
                assert_eq!(cwd, Path::new("/repo"));
                self.0.clone().map(Some).map_err(ProviderError::new)
            }
        }
        let args = || {
            [
                "slash-commands",
                "--format",
                "cadencr-slash-commands-v1",
                "--cwd",
                "/repo",
            ]
            .map(std::ffi::OsString::from)
            .to_vec()
        };
        let listed = Listing(Ok(vec![super::SlashCommand::builder()
            .name("review")
            .build()]));
        assert_eq!(execute(&listed, args()).unwrap(), ExitCode::SUCCESS);
        let failing = Listing(Err("config unreadable"));
        assert_eq!(execute(&failing, args()).unwrap(), ExitCode::FAILURE);
        let invalid = Listing(Ok(vec![super::SlashCommand::builder()
            .name("/bad")
            .build()]));
        assert_eq!(execute(&invalid, args()).unwrap(), ExitCode::FAILURE);
    }

    #[test]
    fn accepts_the_versioned_runtime_contract() {
        let result = execute(
            &FixtureProvider,
            vec!["run".into(), "--protocol".into(), "acp-v1".into()],
        )
        .unwrap();
        assert_eq!(result, ExitCode::SUCCESS);
    }
}
