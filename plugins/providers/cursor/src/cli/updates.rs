//! Cursor Agent release detection and self-update (`agent update`).
//!
//! Cursor publishes no package-registry feed. Its official installer script
//! pins the current build in its download URL
//! (`https://downloads.cursor.com/lab/<version>/…`), and `agent update`
//! installs that same build, so the script is the release source. The script
//! is fetched with the system `curl` (the same tool Cursor's installer needs)
//! to keep the connector free of an HTTP/TLS stack.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use cadencr_provider_sdk::{ProviderError, UpdateReport};
use regex_lite::Regex;

use super::{binary, output_tail, run_captured};

const INSTALL_SCRIPT_URL: &str = "https://cursor.com/install";
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

pub async fn report() -> Result<UpdateReport, ProviderError> {
    let Ok(binary) = binary::resolve_binary() else {
        // A missing CLI is a reportable state, not a failure: no current version.
        let latest = latest_version().await?;
        return Ok(UpdateReport::builder()
            .latest_version(latest.clone())
            .available_versions(vec![latest])
            .build());
    };
    let current = installed_version(&binary).await?;
    let latest = latest_version().await?;
    Ok(UpdateReport::builder()
        .current_version(current)
        .latest_version(latest.clone())
        .available_versions(vec![latest])
        .supports_target_version(false)
        .build())
}

pub async fn update(target: Option<&str>) -> Result<Option<String>, ProviderError> {
    if let Some(target) = target {
        return Err(ProviderError::new(format!(
            "`agent update` installs only Cursor's latest build; version `{target}` cannot be targeted"
        )));
    }
    let binary = binary::resolve_binary()?;
    let args = [OsString::from("update")];
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let output = run_captured(&binary, &args, home.as_deref(), UPDATE_TIMEOUT).await?;
    if output.status.success() {
        return Ok(None);
    }
    // The user's own CLI reporting on its own install: the cause (permissions,
    // disk space) is only in its output.
    Err(ProviderError::new(format!(
        "`{}` failed ({}): {}",
        binary::command_label(&binary, &args),
        output.status,
        output_tail(&output, 600)
    )))
}

async fn installed_version(binary: &Path) -> Result<String, ProviderError> {
    let output = run_captured(
        binary,
        &[OsString::from("--version")],
        None,
        VERSION_TIMEOUT,
    )
    .await?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(ProviderError::new(format!(
            "could not read the installed Cursor Agent version: {}",
            output_tail(&output, 300)
        )));
    }
    version_from_cli_output(&text)
        .ok_or_else(|| ProviderError::new("could not read the installed Cursor Agent version"))
}

/// Cursor versions are date/hash strings such as `2026.03.11-6dfa30c`.
fn version_from_cli_output(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| line.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .map(ToOwned::to_owned)
}

async fn latest_version() -> Result<String, ProviderError> {
    let args = ["-fsSL", "--max-time", "15", INSTALL_SCRIPT_URL].map(OsString::from);
    let output = run_captured(Path::new("curl"), &args, None, FETCH_TIMEOUT)
        .await
        .map_err(|error| {
            ProviderError::new(format!("could not reach the Cursor installer: {error}"))
        })?;
    if !output.status.success() {
        return Err(ProviderError::new(format!(
            "could not reach the Cursor installer ({}): {}",
            output.status,
            output_tail(&output, 300)
        )));
    }
    version_from_install_script(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| ProviderError::new("the Cursor installer no longer names a release version"))
}

fn version_from_install_script(script: &str) -> Option<String> {
    static MATCHER: OnceLock<Option<Regex>> = OnceLock::new();
    MATCHER
        .get_or_init(|| Regex::new(r"downloads\.cursor\.com/lab/([0-9][0-9A-Za-z.\-]*)/").ok())
        .as_ref()?
        .captures(script)
        .and_then(|captures| captures.get(1))
        .map(|version| version.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::{version_from_cli_output, version_from_install_script};

    #[test]
    fn reads_the_pinned_build_from_the_installer() {
        let script = r#"DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.14-0f9edde/${OS}/${ARCH}/agent-cli-package.tar.gz""#;
        assert_eq!(
            version_from_install_script(script).as_deref(),
            Some("2026.10.14-0f9edde")
        );
        assert_eq!(version_from_install_script("echo hello"), None);
    }

    #[test]
    fn reads_the_cli_version_line() {
        assert_eq!(
            version_from_cli_output("Using Node v22\n2026.10.22-27dcf5f\n").as_deref(),
            Some("2026.10.22-27dcf5f")
        );
        assert_eq!(version_from_cli_output("no version"), None);
    }
}
