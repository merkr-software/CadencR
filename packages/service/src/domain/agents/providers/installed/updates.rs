//! Optional connector update commands (`updates` / `update`).
//!
//! The connector owns version semantics: it reports what is installed, what
//! can be installed, and performs the upgrade (usually of the native CLI it
//! wraps). The host only bounds the commands and validates the report shape.
//! See `docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md#optional-update-commands`.

use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::command_capture::run_provider_subcommand;
use super::host_integration::HostIntegrationCache;
use super::installation::LocalExecutable;
use super::managed::process_policy::ManagedCommandOutput;
use super::slash_commands::SlashCommandCatalog;
use crate::domain::agents::updates::{
    display_tail, ProviderUpdater, ProviderVersionReport, UpdateContext, UpdateError,
    UPDATE_TIMEOUT,
};

pub const UPDATE_REPORT_FORMAT: &str = "cadencr-updates-v1";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_VERSION_CHARS: usize = 64;
const MAX_AVAILABLE_VERSIONS: usize = 100;

#[derive(Debug)]
pub struct PluginUpdater {
    executable: LocalExecutable,
    /// Re-read after a successful update: the new build may declare different
    /// host conventions and list slash commands differently.
    host_integration: Arc<HostIntegrationCache>,
    slash_commands: Arc<SlashCommandCatalog>,
}

impl PluginUpdater {
    pub fn new(
        executable: LocalExecutable,
        host_integration: Arc<HostIntegrationCache>,
        slash_commands: Arc<SlashCommandCatalog>,
    ) -> Self {
        Self {
            executable,
            host_integration,
            slash_commands,
        }
    }

    async fn run(
        &self,
        command: &'static str,
        args: &[&str],
        timeout: Duration,
    ) -> Result<ManagedCommandOutput, UpdateError> {
        let args: Vec<OsString> = std::iter::once(command)
            .chain(args.iter().copied())
            .map(OsString::from)
            .collect();
        let cwd = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        run_provider_subcommand(&self.executable, &args, &cwd, timeout)
            .await
            .map_err(|error| UpdateError::failed(format!("connector `{command}` command {error}")))
    }
}

#[async_trait]
impl ProviderUpdater for PluginUpdater {
    async fn check(&self, _context: &UpdateContext) -> Result<ProviderVersionReport, UpdateError> {
        let output = self
            .run(
                "updates",
                &["--format", UPDATE_REPORT_FORMAT],
                CHECK_TIMEOUT,
            )
            .await?;
        if output.status.success() {
            return parse_report(&output.stdout);
        }
        // A connector reports its own failures as `{"message"}`. Any other
        // non-zero exit is a connector built before this optional command
        // existed. Stderr may hold credentials and is never surfaced.
        match parse_message(&output.stdout) {
            Some(message) => Err(UpdateError::failed(message)),
            None => Err(UpdateError::Unsupported),
        }
    }

    async fn update(
        &self,
        _context: &UpdateContext,
        target: Option<&str>,
    ) -> Result<Option<String>, UpdateError> {
        let args = match target {
            Some(version) => vec!["--version", version],
            None => Vec::new(),
        };
        let output = self.run("update", &args, UPDATE_TIMEOUT).await?;
        let message = parse_message(&output.stdout);
        if output.status.success() {
            self.host_integration.invalidate();
            self.slash_commands.invalidate().await;
            return Ok(message);
        }
        Err(UpdateError::failed(message.unwrap_or_else(|| {
            format!("connector `update` command exited with {}", output.status)
        })))
    }
}

#[derive(Deserialize)]
struct WireReport {
    supported: bool,
    current_version: Option<String>,
    latest_version: Option<String>,
    #[serde(default)]
    available_versions: Vec<String>,
    #[serde(default)]
    supports_target_version: bool,
}

fn parse_report(stdout: &[u8]) -> Result<ProviderVersionReport, UpdateError> {
    let wire: WireReport = serde_json::from_slice(stdout).map_err(|error| {
        UpdateError::failed(format!(
            "connector `updates` output is not {UPDATE_REPORT_FORMAT} JSON: {error}"
        ))
    })?;
    if !wire.supported {
        return Err(UpdateError::Unsupported);
    }
    let current_version = wire.current_version.map(validate_version).transpose()?;
    let latest_version = wire.latest_version.map(validate_version).transpose()?;
    if wire.available_versions.len() > MAX_AVAILABLE_VERSIONS {
        return Err(UpdateError::failed(format!(
            "connector reported more than {MAX_AVAILABLE_VERSIONS} available versions"
        )));
    }
    let mut available_versions = wire
        .available_versions
        .into_iter()
        .map(validate_version)
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(latest) = &latest_version {
        if !available_versions.contains(latest) {
            available_versions.insert(0, latest.clone());
        }
    }
    let update_available = matches!(
        (&current_version, &latest_version),
        (Some(current), Some(latest)) if current != latest
    );
    Ok(ProviderVersionReport {
        current_version,
        latest_version,
        available_versions,
        update_available,
        supports_target_version: wire.supports_target_version,
        check_error: None,
    })
}

fn validate_version(version: String) -> Result<String, UpdateError> {
    let valid = !version.is_empty()
        && version.trim() == version
        && version.chars().count() <= MAX_VERSION_CHARS
        && !version.chars().any(char::is_control);
    if valid {
        Ok(version)
    } else {
        Err(UpdateError::failed(format!(
            "connector reported an invalid version string {version:?}"
        )))
    }
}

/// Optional `{"message": "..."}` printed by `update`, or by any optional
/// command (`updates`, `update`, `slash-commands`) when it fails.
pub(super) fn parse_message(stdout: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct WireMessage {
        message: Option<String>,
    }
    let message = serde_json::from_slice::<WireMessage>(stdout)
        .ok()?
        .message?;
    let message = display_tail(&message);
    (!message.is_empty()).then_some(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn script_updater(directory: &tempfile::TempDir, body: &str) -> PluginUpdater {
        let command = crate::domain::agents::providers::installed::test_fixtures::write_script(
            directory.path(),
            "provider",
            body,
        );
        PluginUpdater::new(
            LocalExecutable {
                command,
                args: Vec::new(),
                env: BTreeMap::new(),
            },
            std::sync::Arc::new(
                crate::domain::agents::providers::installed::host_integration::HostIntegrationCache::new(
                    "provider",
                ),
            ),
            std::sync::Arc::default(),
        )
    }

    fn context() -> UpdateContext {
        UpdateContext {
            read_pool: sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
            http: reqwest::Client::new(),
        }
    }

    #[test]
    fn reports_map_to_versions_and_update_availability() {
        let report = parse_report(
            br#"{"supported":true,"current_version":"1.0.0","latest_version":"1.2.0","available_versions":["1.1.0"],"supports_target_version":true}"#,
        )
        .unwrap();
        assert_eq!(report.current_version.as_deref(), Some("1.0.0"));
        assert_eq!(report.available_versions, vec!["1.2.0", "1.1.0"]);
        assert!(report.update_available);
        assert!(report.supports_target_version);

        let same = parse_report(
            br#"{"supported":true,"current_version":"1.2.0","latest_version":"1.2.0"}"#,
        )
        .unwrap();
        assert!(!same.update_available);
    }

    #[test]
    fn unsupported_and_malformed_reports_are_distinct() {
        assert_eq!(
            parse_report(br#"{"supported":false}"#),
            Err(UpdateError::Unsupported)
        );
        assert!(matches!(
            parse_report(b"Updating..."),
            Err(UpdateError::Failed(_))
        ));
        assert!(matches!(
            parse_report(br#"{"supported":true,"current_version":" 1.0 "}"#),
            Err(UpdateError::Failed(_))
        ));
    }

    #[test]
    fn update_messages_are_bounded_plain_text() {
        assert_eq!(
            parse_message(br#"{"message":"  Installed pi 2.0\n"}"#).as_deref(),
            Some("Installed pi 2.0")
        );
        assert_eq!(parse_message(b"not json"), None);
        assert_eq!(parse_message(br#"{"message":"   "}"#), None);
    }

    #[tokio::test]
    async fn runs_the_connector_commands() {
        let directory = tempfile::tempdir().unwrap();
        let updater = script_updater(
            &directory,
            r#"#!/bin/sh
case "$1" in
  updates) echo '{"supported":true,"current_version":"1.0.0","latest_version":"1.1.0"}' ;;
  update) [ "$3" = "1.1.0" ] && echo '{"message":"done"}' && exit 0; echo '{"message":"bad target"}'; exit 4 ;;
esac
"#,
        );
        let report = updater.check(&context()).await.unwrap();
        assert!(report.update_available);
        assert_eq!(
            updater.update(&context(), Some("1.1.0")).await,
            Ok(Some("done".into()))
        );
        assert_eq!(
            updater.update(&context(), None).await,
            Err(UpdateError::failed("bad target"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_successful_update_refreshes_the_slash_command_listing() {
        use crate::domain::agents::providers::installed::installation::HostInstallation;
        use crate::domain::agents::providers::installed::test_fixtures::{
            descriptor, descriptor_json,
        };
        let directory = tempfile::tempdir().unwrap();
        let runs = directory.path().join("runs");
        let mut updater = script_updater(
            &directory,
            &format!(
                "#!/bin/sh
case \"$1\" in
  update) echo '{{\"message\":\"done\"}}' ;;
  \
                 slash-commands) echo run >> '{}'; echo '[]' ;;
esac
",
                runs.display()
            ),
        );
        let catalog = std::sync::Arc::new(SlashCommandCatalog::default());
        updater.slash_commands = std::sync::Arc::clone(&catalog);
        let installation = HostInstallation::from_descriptor(
            descriptor(descriptor_json(
                "provider",
                &updater.executable.command.to_string_lossy(),
            )),
            std::path::Path::new("/p/provider.json"),
        )
        .unwrap();
        let cwd = directory.path().to_str().unwrap();
        catalog.commands(&installation, cwd).await.unwrap();
        catalog.commands(&installation, cwd).await.unwrap();
        updater.update(&context(), None).await.unwrap();
        catalog.commands(&installation, cwd).await.unwrap();
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 2);
    }

    #[tokio::test]
    async fn a_connector_without_update_commands_is_unsupported() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = script_updater(
            &directory,
            "#!/bin/sh\necho 'unknown or invalid provider command' >&2\nexit 1\n",
        );
        assert_eq!(
            legacy.check(&context()).await,
            Err(UpdateError::Unsupported)
        );

        let failing_directory = tempfile::tempdir().unwrap();
        let failing = script_updater(
            &failing_directory,
            "#!/bin/sh\necho '{\"message\":\"registry unreachable\"}'\nexit 1\n",
        );
        assert_eq!(
            failing.check(&context()).await,
            Err(UpdateError::failed("registry unreachable"))
        );
    }
}
