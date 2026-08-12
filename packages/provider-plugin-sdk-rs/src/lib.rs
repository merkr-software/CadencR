//! SDK and CLI harness for code-backed Cadencr provider packages.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use agent_client_protocol::schema::v1::SessionConfigOption;

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
        return Err(ProviderError::new("expected `models`, `run`, or `version`"));
    };
    match command {
        "models" => execute_models(provider, &args[1..]),
        "run" => execute_run(provider, &args[1..]),
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
    fn accepts_the_versioned_runtime_contract() {
        let result = execute(
            &FixtureProvider,
            vec!["run".into(), "--protocol".into(), "acp-v1".into()],
        )
        .unwrap();
        assert_eq!(result, ExitCode::SUCCESS);
    }
}
