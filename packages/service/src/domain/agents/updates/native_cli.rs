//! Updater for built-in providers backed by a locally installed agent CLI.
//!
//! The provider supplies three facts — how to find its binary (the existing
//! discovery metadata), where its releases are published, and which of the
//! CLI's own subcommands upgrades it. The CLI's upgrader knows how it was
//! installed (standalone, npm, Homebrew…), so Cadencr never reimplements
//! package-manager logic.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;

use async_trait::async_trait;
use cli_discovery::Candidate;

use super::version::is_newer;
use super::{
    display_tail, ProviderUpdater, ProviderVersionReport, UpdateContext, UpdateError,
    UPDATE_TIMEOUT,
};
use crate::domain::agents::discovery::{best_cli, read_override_setting};
use crate::domain::agents::providers::ProviderDiscoveryMetadata;
use crate::shared::bounded_command::capture_bounded;

pub type LatestVersionFuture<'a> =
    Pin<Box<dyn Future<Output = Result<String, UpdateError>> + Send + 'a>>;

/// Provider-owned release lookup (npm dist-tag, install manifest, …).
pub type LatestVersionSource = for<'a> fn(&'a reqwest::Client) -> LatestVersionFuture<'a>;

#[derive(Clone, bon::Builder)]
pub struct NativeCliUpdater {
    discovery: ProviderDiscoveryMetadata,
    latest_version: LatestVersionSource,
    /// The CLI's self-upgrade subcommand, e.g. `["update"]`.
    update_args: &'static [&'static str],
}

impl std::fmt::Debug for NativeCliUpdater {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeCliUpdater")
            .field("discovery_id", &self.discovery.discovery_id())
            .field("update_args", &self.update_args)
            .finish()
    }
}

impl NativeCliUpdater {
    async fn override_path(&self, context: &UpdateContext) -> Option<PathBuf> {
        read_override_setting(&context.read_pool, self.discovery.setting_key()).await
    }

    async fn resolve(&self, override_path: Option<&Path>) -> Option<Candidate> {
        best_cli(&self.discovery, override_path).await
    }
}

#[async_trait]
impl ProviderUpdater for NativeCliUpdater {
    async fn check(&self, context: &UpdateContext) -> Result<ProviderVersionReport, UpdateError> {
        let override_path = self.override_path(context).await;
        let Some(candidate) = self.resolve(override_path.as_deref()).await else {
            return Ok(ProviderVersionReport::default());
        };
        let current = candidate
            .version_text
            .ok_or_else(|| UpdateError::failed("could not read the installed version"))?;
        let mut report = ProviderVersionReport {
            current_version: Some(current.clone()),
            ..ProviderVersionReport::default()
        };
        match (self.latest_version)(&context.http).await {
            Ok(latest) => {
                report.update_available = is_newer(&latest, &current);
                report.available_versions = vec![latest.clone()];
                report.latest_version = Some(latest);
            }
            Err(error) => report.check_error = Some(error.to_string()),
        }
        Ok(report)
    }

    /// Always installs the latest version: `supports_target_version` is never
    /// reported, so the service refuses explicit targets before calling this.
    async fn update(
        &self,
        context: &UpdateContext,
        _target: Option<&str>,
    ) -> Result<Option<String>, UpdateError> {
        let override_path = self.override_path(context).await;
        let candidate = self
            .resolve(override_path.as_deref())
            .await
            .ok_or_else(|| UpdateError::failed("the provider CLI is not installed"))?;
        let result = run_update(&candidate.path, self.update_args).await;
        // Drop the SDK's cached binary resolution even on failure: a partial
        // upgrade may have replaced or moved the binary it cached. Re-applying
        // the override is exactly the invalidation `set_binary_override` does.
        self.discovery.apply_override(override_path);
        result
    }
}

async fn run_update(binary: &Path, args: &[&str]) -> Result<Option<String>, UpdateError> {
    let command_label = format!(
        "{} {}",
        binary
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        args.join(" ")
    );
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = dirs::home_dir() {
        command.current_dir(home);
    }
    let output = capture_bounded(command, UPDATE_TIMEOUT)
        .await
        .map_err(|error| UpdateError::failed(format!("`{command_label}` {error}")))?;
    if output.status.success() {
        return Ok(None);
    }
    // Unlike connector output, this is the user's own CLI reporting on its own
    // install, and the cause (permissions, disk space) is only in its output.
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Err(UpdateError::failed(format!(
        "`{command_label}` failed ({}): {}",
        output.status,
        display_tail(&combined)
    )))
}

#[cfg(test)]
mod tests {
    use super::run_update;
    use std::path::Path;

    #[tokio::test]
    async fn failed_upgrade_reports_the_command_and_its_output() {
        let error = run_update(
            Path::new("/bin/sh"),
            &["-c", "echo 'EACCES: denied' >&2; exit 3"],
        )
        .await
        .expect_err("non-zero exit must fail");
        let message = error.to_string();
        assert!(message.contains("sh -c"), "{message}");
        assert!(message.contains("EACCES: denied"), "{message}");
    }

    #[tokio::test]
    async fn successful_upgrade_returns_no_summary() {
        let result = run_update(Path::new("/bin/sh"), &["-c", "echo updated"]).await;
        assert_eq!(result, Ok(None));
    }
}
