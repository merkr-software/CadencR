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
    /// Visible but unsafe to verify without a real user turn. Conformance never
    /// upgrades this state to `Passed`.
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
