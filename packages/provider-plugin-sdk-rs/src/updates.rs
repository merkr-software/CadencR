//! Optional update contract: `updates` reports versions, `update` installs one.
//!
//! A connector usually wraps a native CLI it does not ship (Pi, Aider, …). The
//! connector knows how that CLI was installed and where its releases are
//! published, so it — not Cadencr — answers "which version is installed, which
//! ones exist" and performs the upgrade. Cadencr only renders the report and
//! triggers the command.

use std::ffi::OsString;
use std::process::ExitCode;

use serde_json::{json, Value};

use super::{CadencrProvider, ProviderError};

pub const UPDATE_REPORT_FORMAT: &str = "cadencr-updates-v1";

/// Versions known to the connector. Versions are opaque display strings; the
/// connector decides what "newer" means and reports it through `latest_version`.
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct UpdateReport {
    /// Installed version, `None` when the native CLI is missing.
    #[builder(into)]
    pub current_version: Option<String>,
    /// Newest installable version, `None` when the release source is unknown.
    #[builder(into)]
    pub latest_version: Option<String>,
    /// Installable versions, newest first. May be just `[latest_version]`.
    #[builder(default)]
    pub available_versions: Vec<String>,
    /// Whether `update --version <v>` accepts any entry of `available_versions`.
    #[builder(default)]
    pub supports_target_version: bool,
}

impl UpdateReport {
    fn to_json(&self) -> Value {
        json!({
            "supported": true,
            "current_version": self.current_version,
            "latest_version": self.latest_version,
            "available_versions": self.available_versions,
            "supports_target_version": self.supports_target_version,
        })
    }
}

pub(super) fn execute_updates(
    provider: &impl CadencrProvider,
    args: &[OsString],
) -> Result<ExitCode, ProviderError> {
    if args.len() != 2 || args[0] != "--format" || args[1] != UPDATE_REPORT_FORMAT {
        return Err(ProviderError::new(format!(
            "updates requires `--format {UPDATE_REPORT_FORMAT}`"
        )));
    }
    let report = match provider.updates() {
        Ok(Some(report)) => report.to_json(),
        Ok(None) => json!({ "supported": false }),
        Err(error) => return Ok(report_failure(&error)),
    };
    println!("{report}");
    Ok(ExitCode::SUCCESS)
}

pub(super) fn execute_update(
    provider: &impl CadencrProvider,
    args: &[OsString],
) -> Result<ExitCode, ProviderError> {
    let target = match args {
        [] => None,
        [flag, version] if flag == "--version" => Some(
            version
                .to_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| ProviderError::new("update `--version` must be non-empty UTF-8"))?,
        ),
        _ => {
            return Err(ProviderError::new(
                "update accepts only `[--version <version>]`",
            ))
        }
    };
    match provider.update(target) {
        Ok(message) => {
            println!("{}", json!({ "message": message }));
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => Ok(report_failure(&error)),
    }
}

/// Cadencr shows the stdout `{"message"}` of a failed `updates` / `update`
/// and never stderr, which may hold credentials.
fn report_failure(error: &ProviderError) -> ExitCode {
    println!("{}", json!({ "message": error.to_string() }));
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::UpdateReport;

    #[test]
    fn report_serializes_the_versioned_contract() {
        let report = UpdateReport::builder()
            .current_version("1.0.0")
            .latest_version("1.1.0")
            .available_versions(vec!["1.1.0".into(), "1.0.1".into()])
            .supports_target_version(true)
            .build();
        assert_eq!(
            report.to_json(),
            serde_json::json!({
                "supported": true,
                "current_version": "1.0.0",
                "latest_version": "1.1.0",
                "available_versions": ["1.1.0", "1.0.1"],
                "supports_target_version": true,
            })
        );
    }
}
