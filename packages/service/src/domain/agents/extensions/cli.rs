//! Running a provider's CLI for extension commands: the binary Cadencr would
//! spawn for agents (override first, then discovery), argv only (no shell),
//! from the home directory so project-scoped config never leaks in.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::http::StatusCode;
use serde::de::DeserializeOwned;
use sqlx::SqlitePool;

use crate::domain::agents::discovery::{best_cli, read_override_setting};
use crate::domain::agents::providers::ProviderDiscoveryMetadata;
use crate::domain::agents::updates::display_tail;
use crate::error::AppError;
use crate::shared::bounded_command::capture_bounded_up_to;

/// Listing a marketplace prints megabytes of JSON; installs fetch from the network.
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionError {
    /// The CLI has no command for this operation.
    Unsupported(String),
    /// The request itself is invalid (unknown option, missing value…).
    Invalid(String),
    /// The CLI ran and refused or failed; the message is its own output.
    Failed(String),
}

impl ExtensionError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }

    /// The same error with every `secret` masked: a CLI's own output (clap
    /// errors, validation messages) can echo what the user typed, and a 502
    /// is also logged.
    pub fn redacted<'a>(self, secrets: impl IntoIterator<Item = &'a str>) -> Self {
        let mask = |mut message: String, secrets: Vec<&str>| {
            for secret in secrets {
                message = message.replace(secret, "•••");
            }
            message
        };
        // Short values ("eu", "1") are not secrets and masking them would garble the text.
        let secrets: Vec<&str> = secrets
            .into_iter()
            .filter(|value| value.len() >= 6)
            .collect();
        match self {
            Self::Unsupported(message) => Self::Unsupported(mask(message, secrets)),
            Self::Invalid(message) => Self::Invalid(mask(message, secrets)),
            Self::Failed(message) => Self::Failed(mask(message, secrets)),
        }
    }
}

/// A server name or plugin id passed positionally: refused when it would
/// read as a flag. Names come from CLI and third-party marketplace output.
pub fn positional(value: &str) -> Result<&str, ExtensionError> {
    if value.is_empty() || value.starts_with('-') {
        return Err(ExtensionError::Invalid(format!(
            "`{value}` is not a name an agent CLI accepts"
        )));
    }
    Ok(value)
}

impl std::fmt::Display for ExtensionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(message) | Self::Invalid(message) | Self::Failed(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl From<ExtensionError> for AppError {
    fn from(error: ExtensionError) -> Self {
        match error {
            ExtensionError::Unsupported(message) => AppError::Coded {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "EXTENSION_UNSUPPORTED",
                message,
            },
            ExtensionError::Invalid(message) => AppError::Coded {
                status: StatusCode::BAD_REQUEST,
                code: "EXTENSION_INVALID",
                message,
            },
            ExtensionError::Failed(message) => AppError::Coded {
                status: StatusCode::BAD_GATEWAY,
                code: "EXTENSION_CLI_FAILED",
                message,
            },
        }
    }
}

/// A resolved CLI binary, ready to run subcommands.
#[derive(Debug, Clone)]
pub struct CliRunner {
    binary: PathBuf,
    pub version: Option<String>,
    env: Vec<(String, String)>,
    env_unset: Vec<String>,
    config_home: Option<PathBuf>,
}

impl CliRunner {
    /// The binary agent sessions would spawn. `None`: not installed here.
    pub async fn resolve(
        read_pool: &SqlitePool,
        discovery: &ProviderDiscoveryMetadata,
    ) -> Option<Self> {
        let override_path = read_override_setting(read_pool, discovery.setting_key()).await;
        best_cli(discovery, override_path.as_deref())
            .await
            .map(|candidate| Self {
                binary: candidate.path,
                version: candidate.version_text,
                env: Vec::new(),
                env_unset: Vec::new(),
                config_home: None,
            })
    }

    #[cfg(test)]
    pub fn for_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            version: None,
            env: Vec::new(),
            env_unset: Vec::new(),
            config_home: None,
        }
    }

    /// The same CLI as a provider profile runs it: `env` set, `unset`
    /// removed, reading its config from `config_home`.
    pub fn for_profile(
        &self,
        env: impl IntoIterator<Item = (String, String)>,
        unset: Vec<String>,
        config_home: Option<PathBuf>,
    ) -> Self {
        Self {
            binary: self.binary.clone(),
            version: self.version.clone(),
            env: env.into_iter().collect(),
            env_unset: unset,
            config_home,
        }
    }

    /// Where this CLI keeps its user config, when its profile says.
    pub fn config_home(&self) -> Option<&Path> {
        self.config_home.as_deref()
    }

    /// Run `args`; stdout on success, the CLI's own explanation on failure.
    pub async fn run(&self, args: &[String]) -> Result<String, ExtensionError> {
        let label = command_label(&self.binary, args);
        let mut command = tokio::process::Command::new(&self.binary);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in &self.env_unset {
            command.env_remove(key);
        }
        command.envs(self.env.iter().map(|(key, value)| (key, value)));
        if let Some(home) = dirs::home_dir() {
            command.current_dir(home);
        }
        let output = capture_bounded_up_to(command, COMMAND_TIMEOUT, MAX_OUTPUT_BYTES)
            .await
            .map_err(|error| self.redacted(ExtensionError::failed(format!("`{label}` {error}"))))?;
        let stdout = String::from_utf8(output.stdout)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
        if output.status.success() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = display_tail(&format!("{stderr}\n{stdout}"));
        Err(self.redacted(ExtensionError::failed(if detail.is_empty() {
            format!("`{label}` failed ({})", output.status)
        } else {
            format!("`{label}` failed: {detail}")
        })))
    }

    /// A profile's values (keys, proxy URLs…) never reach an error message.
    fn redacted(&self, error: ExtensionError) -> ExtensionError {
        error.redacted(self.env.iter().map(|(_, value)| value.as_str()))
    }

    pub async fn run_json<T: DeserializeOwned>(
        &self,
        args: &[String],
    ) -> Result<T, ExtensionError> {
        let stdout = self.run(args).await?;
        serde_json::from_str(json_body(&stdout)).map_err(|error| {
            ExtensionError::failed(format!(
                "`{}` printed output Cadencr could not read: {error}",
                command_label(&self.binary, args)
            ))
        })
    }
}

/// The JSON document in a CLI's stdout, past any banner line it printed first.
fn json_body(stdout: &str) -> &str {
    stdout
        .find(['{', '['])
        .map(|start| &stdout[start..])
        .unwrap_or(stdout)
}

/// What the error names: the binary and its subcommand, never the values
/// (they can carry secrets the user typed).
fn command_label(binary: &Path, args: &[String]) -> String {
    let name = binary
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let verbs: Vec<&str> = args
        .iter()
        .take_while(|arg| !arg.starts_with('-'))
        .take(2)
        .map(String::as_str)
        .collect();
    format!("{name} {}", verbs.join(" ")).trim_end().to_string()
}

/// `args!["mcp", "list"]` → `Vec<String>`.
macro_rules! args {
    ($($arg:expr),* $(,)?) => { vec![$(String::from($arg)),*] };
}
pub(crate) use args;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failures_carry_the_cli_output_but_not_its_values() {
        let runner = CliRunner::for_binary("/bin/sh");
        let error = runner
            .run(&args!["-c", "echo 'plugin not found' >&2; exit 2"])
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("plugin not found"), "{message}");
        assert!(!message.contains("exit 2"), "{message}");
    }

    #[tokio::test]
    async fn json_output_skips_a_leading_banner() {
        let runner = CliRunner::for_binary("/bin/sh");
        let value: Vec<u32> = runner
            .run_json(&args!["-c", "echo 'Checking…'; echo '[1,2]'"])
            .await
            .unwrap();
        assert_eq!(value, vec![1, 2]);
    }

    #[tokio::test]
    async fn a_profile_environment_reaches_the_cli() {
        let runner = CliRunner::for_binary("/bin/sh").for_profile(
            [(
                "CADENCR_EXT_TEST_HOME".to_string(),
                "/profiles/work".to_string(),
            )],
            vec!["HOME".to_string()],
            None,
        );
        let output = runner
            .run(&args![
                "-c",
                "echo \"$CADENCR_EXT_TEST_HOME|${HOME:-unset}\""
            ])
            .await
            .unwrap();
        assert_eq!(output.trim(), "/profiles/work|unset");
    }

    #[tokio::test]
    async fn profile_values_stay_out_of_errors() {
        let runner = CliRunner::for_binary("/bin/sh").for_profile(
            [("PROXY".to_string(), "https://user:pass@proxy".to_string())],
            Vec::new(),
            None,
        );
        let error = runner
            .run(&args!["-c", "echo \"cannot reach $PROXY\" >&2; exit 1"])
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("user:pass"), "{error}");
    }

    #[test]
    fn redaction_masks_typed_values_but_not_short_words() {
        let error = ExtensionError::failed("invalid value 'TOKEN=sk-12345' for --env in eu")
            .redacted(["sk-12345", "eu"]);
        assert_eq!(
            error.to_string(),
            "invalid value 'TOKEN=•••' for --env in eu"
        );
    }

    #[test]
    fn names_that_read_as_flags_are_refused() {
        assert!(positional("acme@market").is_ok());
        assert!(positional("--scope").is_err());
        assert!(positional("").is_err());
    }

    #[test]
    fn labels_stop_before_flags_and_values() {
        let label = command_label(
            Path::new("/usr/bin/claude"),
            &args![
                "mcp",
                "add-json",
                "-s",
                "user",
                "x",
                "{\"env\":{\"K\":\"secret\"}}"
            ],
        );
        assert_eq!(label, "claude mcp add-json");
    }
}
