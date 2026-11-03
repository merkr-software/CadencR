//! Prompt-free conformance gate for an integrity-verified managed provider.
//!
//! The probe proves that version, model discovery, and the ACP v1 configuration
//! contract are usable before activation. It never sends `session/prompt`, never
//! invokes an ACP authentication method, and tears its temporary session down on
//! every path. Provider-account authentication remains the native CLI's concern.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

mod acp_probe;
mod command_probe;
mod model_reconciliation;

const CONFORMANCE_TIMEOUT: Duration = Duration::from_secs(90);

/// Inputs already covered by package integrity verification.
#[derive(Debug, Clone, bon::Builder)]
pub struct ManagedConformanceRequest {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub expected_provider_version: String,
}

/// Evidence recorded after a successful prompt-free probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedConformanceReport {
    pub version: ManagedProbeOutcome,
    pub verified_version: String,
    pub session_id: String,
    pub model_config_id: String,
    pub model_ids: Vec<String>,
    pub default_model: String,
    pub discovered_model_count: usize,
    pub resume: ManagedProbeOutcome,
    pub load: ManagedProbeOutcome,
    pub close: ManagedProbeOutcome,
    /// Prompt/tool capabilities require a real user turn and are never claimed
    /// by this non-billable admission probe.
    pub prompt: ManagedProbeOutcome,
    /// Always false until a real platform sandbox is implemented.
    pub os_sandbox_applied: bool,
}

/// Result of probing one optional ACP lifecycle capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedProbeOutcome {
    Passed,
    NotAdvertised,
    /// Not verified without a real user turn, including optional restore/close
    /// when the disposable empty session was explicitly not retained. Also used
    /// for legacy load when stable resume was tested instead. Never `Passed`.
    Unprobed,
}

/// Stable conformance failure suitable for quarantine and receipts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedConformanceErrorCode {
    ProcessPolicyRejected,
    VersionFailed,
    ModelDiscoveryFailed,
    InitializeFailed,
    SessionNewFailed,
    ModelContractMismatch,
    ConfigurationFailed,
    RestoreFailed,
    CleanupFailed,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedConformanceError {
    pub code: ManagedConformanceErrorCode,
    pub message: String,
}

impl ManagedConformanceError {
    pub(super) fn new(code: ManagedConformanceErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ManagedConformanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ManagedConformanceError {}

/// Verify pre-prompt usability of an already integrity-checked executable.
pub async fn verify_managed_provider(
    request: ManagedConformanceRequest,
) -> Result<ManagedConformanceReport, ManagedConformanceError> {
    match tokio::time::timeout(CONFORMANCE_TIMEOUT, verify_inner(request)).await {
        Ok(result) => result,
        Err(_) => Err(ManagedConformanceError::new(
            ManagedConformanceErrorCode::TimedOut,
            "managed provider conformance timed out after 90 seconds",
        )),
    }
}

async fn verify_inner(
    request: ManagedConformanceRequest,
) -> Result<ManagedConformanceReport, ManagedConformanceError> {
    let version = command_probe::verify_version(&request).await?;
    let discovered = command_probe::discover_models(&request).await?;
    acp_probe::probe_acp(request, discovered, version).await
}

#[derive(Debug)]
pub(super) struct ModelContract {
    pub(super) config_id: String,
    pub(super) current_model: String,
    pub(super) model_ids: Vec<String>,
}

pub(super) fn error(
    code: ManagedConformanceErrorCode,
    message: impl Into<String>,
) -> ManagedConformanceError {
    ManagedConformanceError::new(code, message)
}

pub(super) fn policy_error(error: impl fmt::Display) -> ManagedConformanceError {
    ManagedConformanceError::new(
        ManagedConformanceErrorCode::ProcessPolicyRejected,
        error.to_string(),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use serde_json::Value;

    use super::*;

    async fn probe_fixture(
        flags: &[&str],
    ) -> (
        Result<ManagedConformanceReport, ManagedConformanceError>,
        Vec<Value>,
    ) {
        let cwd = tempfile::tempdir().unwrap();
        let state = cwd.path().join("state.json");
        let forbidden = cwd.path().join("forbidden-method");
        let mut args = vec![
            "--state".into(),
            state.to_string_lossy().into_owned(),
            "--forbidden".into(),
            forbidden.to_string_lossy().into_owned(),
        ];
        args.extend(flags.iter().map(|flag| flag.to_string()));
        let result = verify_managed_provider(
            ManagedConformanceRequest::builder()
                .executable(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/fixtures/managed_reject_active_resume_agent.py"),
                )
                .args(args)
                .env(BTreeMap::new())
                .cwd(cwd.path().to_path_buf())
                .expected_provider_version("1.2.3".to_string())
                .build(),
        )
        .await;
        assert!(
            !forbidden.exists(),
            "conformance must not send a prompt or authenticate"
        );
        let calls: Vec<Value> = std::fs::read_to_string(state.with_extension("json.calls"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "session/new")
                .count(),
            1,
            "restore must never fall back to replacement context"
        );
        (result, calls)
    }

    #[tokio::test]
    async fn admission_applies_the_discovered_model_before_strict_confirmation_and_restore() {
        let (result, calls) = probe_fixture(&["--different-initial-model"]).await;
        let report = result.unwrap();
        let selected = calls
            .iter()
            .find(|call| call["method"] == "session/set_config_option")
            .unwrap();
        assert_eq!(selected["params"]["value"], "fixture/default");
        assert_eq!(report.default_model, "fixture/default");
        assert_eq!(report.resume, ManagedProbeOutcome::Passed);
        assert_eq!(report.close, ManagedProbeOutcome::Passed);
        assert_eq!(report.prompt, ManagedProbeOutcome::Unprobed);
    }

    #[tokio::test]
    async fn an_explicitly_unretained_empty_session_does_not_claim_restore_or_close_success() {
        for flags in [
            vec!["--empty-not-retained"],
            vec!["--empty-not-retained", "--load-only"],
        ] {
            let (result, _) = probe_fixture(&flags).await;
            let report = result.unwrap();
            assert_eq!(
                report.resume,
                if flags.contains(&"--load-only") {
                    ManagedProbeOutcome::NotAdvertised
                } else {
                    ManagedProbeOutcome::Unprobed
                }
            );
            assert_eq!(report.load, ManagedProbeOutcome::Unprobed);
            assert_eq!(report.close, ManagedProbeOutcome::Unprobed);
            assert_eq!(report.prompt, ManagedProbeOutcome::Unprobed);
        }
    }

    #[tokio::test]
    async fn invalid_selectors_ignored_selection_and_other_restore_failures_still_reject() {
        use ManagedConformanceErrorCode::{
            ConfigurationFailed, ModelContractMismatch, RestoreFailed,
        };

        for (flags, expected) in [
            (vec!["--invalid-live-model"], ModelContractMismatch),
            (vec!["--changed-live-catalog"], ModelContractMismatch),
            (
                vec!["--different-initial-model", "--ignore-model-selection"],
                ConfigurationFailed,
            ),
            (vec!["--restore-wrong-model"], RestoreFailed),
            (vec!["--restore-method-missing"], RestoreFailed),
            (vec!["--other-session-missing"], RestoreFailed),
        ] {
            let (result, calls) = probe_fixture(&flags).await;
            assert_eq!(result.unwrap_err().code, expected, "{flags:?}");
            if expected == ModelContractMismatch {
                assert!(!calls
                    .iter()
                    .any(|call| call["method"] == "session/set_config_option"));
            }
        }
    }
}
