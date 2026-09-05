use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::verification::verify_receipt_trust;
use super::ManagedStorage;
use crate::domain::agents::providers::installed::managed::blocklist::load_enforced_blocklist;
use crate::domain::agents::providers::installed::managed::history::read_state;
use crate::domain::agents::providers::installed::managed::quarantine::{
    append as quarantine, ManagedFailureStage,
};
use crate::domain::agents::providers::installed::managed::receipt::{
    hash_regular_file, read_receipt, receipt_path, verify_payload_manifest, ManagedPackageReceipt,
    ManagedRevision,
};
use crate::domain::agents::providers::installed::managed::trust::pinned_index_trust_store;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ManagedLaunchGuardCode {
    StateInvalid,
    ReceiptInvalid,
    RevisionInactive,
    ProviderDisabled,
    PayloadTampered,
    ProviderBlocked,
    BlocklistInvalid,
    TrustInvalid,
}

impl ManagedLaunchGuardCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StateInvalid => "MANAGED_STATE_INVALID",
            Self::ReceiptInvalid => "MANAGED_RECEIPT_INVALID",
            Self::RevisionInactive => "MANAGED_REVISION_INACTIVE",
            Self::ProviderDisabled => "MANAGED_PROVIDER_DISABLED",
            Self::PayloadTampered => "MANAGED_PAYLOAD_TAMPERED",
            Self::ProviderBlocked => "MANAGED_PROVIDER_BLOCKED",
            Self::BlocklistInvalid => "MANAGED_BLOCKLIST_INVALID",
            Self::TrustInvalid => "MANAGED_TRUST_INVALID",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedLaunchGuardError {
    pub code: ManagedLaunchGuardCode,
    pub message: String,
}

impl std::fmt::Display for ManagedLaunchGuardError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ManagedLaunchGuardError {}

/// Classify host-managed paths before choosing the stricter process policy.
/// Any lexical path below the managed root counts, including malformed layouts,
/// so callers fail closed through [`verify_managed_launch`].
pub fn is_managed_executable(executable: &Path) -> bool {
    executable.starts_with(ManagedStorage::production().root())
}

pub(crate) fn is_managed_executable_in(storage: &ManagedStorage, executable: &Path) -> bool {
    executable.starts_with(storage.root())
}

pub(crate) fn verify_managed_launch_in(
    storage: &ManagedStorage,
    executable: &Path,
) -> Result<(), ManagedLaunchGuardError> {
    let Some((provider_id, revision, relative)) = parse_managed_executable(storage, executable)?
    else {
        return Ok(());
    };
    let result =
        verify_active_managed_launch(storage, executable, &provider_id, &revision, &relative);
    if let Err(error) = &result {
        if let Err(record_error) = quarantine(
            storage,
            &provider_id,
            &revision.version,
            Some(&revision.digest),
            ManagedFailureStage::Launch,
            error.code.as_str(),
        ) {
            return Err(guard(
                error.code,
                format!(
                    "{}; durable quarantine evidence could not be saved: {record_error}",
                    error.message
                ),
            ));
        }
    }
    result
}

fn verify_active_managed_launch(
    storage: &ManagedStorage,
    executable: &Path,
    provider_id: &str,
    revision: &ManagedRevision,
    relative: &Path,
) -> Result<(), ManagedLaunchGuardError> {
    let state_path = storage.state_path(provider_id).map_err(guard_state)?;
    let state = read_state(&state_path, provider_id).map_err(guard_state)?;
    let active = state.active.ok_or_else(|| {
        guard(
            ManagedLaunchGuardCode::RevisionInactive,
            format!("managed provider {provider_id} is removed"),
        )
    })?;
    if &active.revision != revision {
        return Err(guard(
            ManagedLaunchGuardCode::RevisionInactive,
            format!("managed provider {provider_id} revision is no longer active"),
        ));
    }
    if !active.enabled {
        return Err(guard(
            ManagedLaunchGuardCode::ProviderDisabled,
            format!("managed provider {provider_id} is disabled"),
        ));
    }
    verify_launch_receipt(storage, executable, provider_id, revision, relative)
}

fn verify_launch_receipt(
    storage: &ManagedStorage,
    executable: &Path,
    provider_id: &str,
    revision: &ManagedRevision,
    relative: &Path,
) -> Result<(), ManagedLaunchGuardError> {
    let payload = storage
        .payload_dir(provider_id, revision)
        .map_err(guard_receipt)?;
    let receipt =
        read_receipt(&receipt_path(&payload).map_err(guard_receipt)?).map_err(guard_receipt)?;
    if Path::new(&receipt.executable) != relative {
        return Err(guard(
            ManagedLaunchGuardCode::ReceiptInvalid,
            "managed executable does not match its immutable receipt",
        ));
    }
    let canonical_payload = std::fs::canonicalize(&payload).map_err(|error| {
        guard(
            ManagedLaunchGuardCode::PayloadTampered,
            format!("resolve managed payload: {error}"),
        )
    })?;
    let canonical_executable = std::fs::canonicalize(executable).map_err(|error| {
        guard(
            ManagedLaunchGuardCode::PayloadTampered,
            format!("resolve managed executable: {error}"),
        )
    })?;
    if !canonical_executable.starts_with(&canonical_payload) {
        return Err(guard(
            ManagedLaunchGuardCode::PayloadTampered,
            "managed executable resolves outside its immutable payload",
        ));
    }
    verify_payload_manifest(&payload, &receipt.payload_files).map_err(guard_tampered)?;
    let actual = hash_regular_file(executable).map_err(guard_tampered)?;
    if actual != receipt.executable_sha256 {
        return Err(guard(
            ManagedLaunchGuardCode::PayloadTampered,
            format!("managed executable for {provider_id} failed its receipt hash"),
        ));
    }
    verify_receipt_trust(&receipt, &pinned_index_trust_store()).map_err(|error| {
        guard(
            ManagedLaunchGuardCode::TrustInvalid,
            format!("managed receipt trust verification failed: {error}"),
        )
    })?;
    check_cached_blocklist(storage, &receipt)
}

fn check_cached_blocklist(
    storage: &ManagedStorage,
    receipt: &ManagedPackageReceipt,
) -> Result<(), ManagedLaunchGuardError> {
    let blocklist = load_enforced_blocklist(
        &storage.blocklist_cache_path(),
        &pinned_index_trust_store(),
        chrono::Utc::now(),
    )
    .map_err(|error| guard(ManagedLaunchGuardCode::BlocklistInvalid, error.message))?;
    let Some(blocklist) = blocklist else {
        return Ok(());
    };
    let blocked = blocklist
        .blocked_reason(
            &receipt.agent.id,
            &receipt.agent.version,
            &receipt.archive_sha256,
        )
        .map_err(|error| guard(ManagedLaunchGuardCode::BlocklistInvalid, error.message))?;
    if let Some(reason) = blocked {
        return Err(guard(
            ManagedLaunchGuardCode::ProviderBlocked,
            format!("managed provider {} is blocked: {reason}", receipt.agent.id),
        ));
    }
    Ok(())
}

fn parse_managed_executable(
    storage: &ManagedStorage,
    executable: &Path,
) -> Result<Option<(String, ManagedRevision, PathBuf)>, ManagedLaunchGuardError> {
    let Ok(relative) = executable.strip_prefix(storage.root()) else {
        return Ok(None);
    };
    let components: Vec<_> = relative.components().collect();
    if components.len() < 5 || components[3].as_os_str() != "payload" {
        return Err(guard(
            ManagedLaunchGuardCode::ReceiptInvalid,
            "managed executable path has an invalid storage layout",
        ));
    }
    let string = |index: usize| {
        components[index]
            .as_os_str()
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| {
                guard(
                    ManagedLaunchGuardCode::ReceiptInvalid,
                    "managed path is not UTF-8",
                )
            })
    };
    let provider_id = string(0)?;
    let revision = ManagedRevision {
        version: string(1)?,
        digest: string(2)?,
    };
    let executable_relative = components[4..].iter().collect();
    Ok(Some((provider_id, revision, executable_relative)))
}

fn guard(code: ManagedLaunchGuardCode, message: impl Into<String>) -> ManagedLaunchGuardError {
    ManagedLaunchGuardError {
        code,
        message: message.into(),
    }
}

fn guard_state(error: AppError) -> ManagedLaunchGuardError {
    guard(ManagedLaunchGuardCode::StateInvalid, error.to_string())
}

fn guard_receipt(error: AppError) -> ManagedLaunchGuardError {
    guard(ManagedLaunchGuardCode::ReceiptInvalid, error.to_string())
}

fn guard_tampered(error: AppError) -> ManagedLaunchGuardError {
    guard(ManagedLaunchGuardCode::PayloadTampered, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::history::{
        write_state, ManagedActiveRevision, ManagedHistoryAction, ManagedProviderState,
    };
    use crate::domain::agents::providers::installed::managed::quarantine::records;

    #[test]
    fn local_executables_are_outside_the_managed_guard() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(directory.path().join("managed"));
        assert!(verify_managed_launch_in(&storage, &directory.path().join("local-agent")).is_ok());
    }

    #[test]
    fn launch_refusal_is_recorded_without_provider_output() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(directory.path().join("managed"));
        let revision = ManagedRevision {
            version: "1.2.3".into(),
            digest: "a".repeat(64),
        };
        let payload = storage.payload_dir("acme-agent", &revision).unwrap();
        std::fs::create_dir_all(payload.join("bin")).unwrap();
        let executable = payload.join("bin/acme-agent");
        std::fs::write(&executable, b"agent").unwrap();
        let mut state = ManagedProviderState::empty("acme-agent");
        state.transition(
            ManagedHistoryAction::Installed,
            Some(ManagedActiveRevision {
                revision,
                enabled: false,
            }),
        );
        write_state(&storage.state_path("acme-agent").unwrap(), &state).unwrap();

        let error = verify_managed_launch_in(&storage, &executable).unwrap_err();
        assert_eq!(error.code, ManagedLaunchGuardCode::ProviderDisabled);
        let quarantines = records(&storage, "acme-agent").unwrap();
        assert_eq!(quarantines.len(), 1);
        assert_eq!(quarantines[0].stage, ManagedFailureStage::Launch);
        assert_eq!(quarantines[0].code, "MANAGED_PROVIDER_DISABLED");
    }
}
