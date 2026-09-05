use axum::http::StatusCode;

use super::super::ManagedProviderService;
use crate::domain::agents::providers::installed::managed::blocklist::load_enforced_blocklist;
use crate::domain::agents::providers::installed::managed::conformance::ManagedConformanceErrorCode;
use crate::domain::agents::providers::installed::managed::download::{
    ArtifactError, ArtifactErrorCode,
};
use crate::domain::agents::providers::installed::managed::quarantine::{
    append as quarantine, ManagedFailureStage,
};
use crate::domain::agents::providers::installed::managed::receipt::ManagedPackageReceipt;
use crate::domain::agents::providers::installed::managed::ResolvedManagedProviderPackage;
use crate::error::AppError;

pub(super) fn failure(
    service: &ManagedProviderService,
    id: &str,
    version: &str,
    digest: Option<&str>,
    stage: ManagedFailureStage,
    code: &'static str,
    message: String,
) -> AppError {
    match quarantine(&service.storage, id, version, digest, stage, code) {
        Ok(_) => AppError::coded(StatusCode::CONFLICT, code, message),
        Err(error) => AppError::coded(
            StatusCode::CONFLICT,
            code,
            format!("{message}; durable quarantine evidence could not be saved: {error}"),
        ),
    }
}

pub(super) fn failure_from_app(
    service: &ManagedProviderService,
    id: &str,
    version: &str,
    digest: Option<&str>,
    stage: ManagedFailureStage,
    code: &'static str,
    primary: AppError,
) -> AppError {
    let primary = match primary {
        coded @ AppError::Coded { .. } => coded,
        error => AppError::coded(StatusCode::CONFLICT, code, error.to_string()),
    };
    match quarantine(&service.storage, id, version, digest, stage, code) {
        Ok(_) => primary,
        Err(error) => append_context(
            primary,
            format!("durable quarantine evidence could not be saved: {error}"),
        ),
    }
}

pub(super) fn artifact_failure(
    service: &ManagedProviderService,
    package: &ResolvedManagedProviderPackage,
    stage: ManagedFailureStage,
    error: ArtifactError,
) -> AppError {
    let code = artifact_code(error.code);
    failure(
        service,
        &package.provider_id,
        &package.provider_version,
        Some(&package.archive_sha256),
        stage,
        code,
        error.message,
    )
}

pub(super) fn check_blocklist(
    service: &ManagedProviderService,
    package: &ResolvedManagedProviderPackage,
) -> Result<(), AppError> {
    check_blocked(
        service,
        &package.provider_id,
        &package.provider_version,
        &package.archive_sha256,
    )
}

pub(super) fn check_blocklist_receipt(
    service: &ManagedProviderService,
    receipt: &ManagedPackageReceipt,
) -> Result<(), AppError> {
    check_blocked(
        service,
        &receipt.agent.id,
        &receipt.agent.version,
        &receipt.archive_sha256,
    )
}

fn check_blocked(
    service: &ManagedProviderService,
    id: &str,
    version: &str,
    digest: &str,
) -> Result<(), AppError> {
    let cached = load_enforced_blocklist(
        &service.storage.blocklist_cache_path(),
        &service.trust_store,
        chrono::Utc::now(),
    )
    .map_err(|error| AppError::coded(StatusCode::CONFLICT, error.code.as_str(), error.message))?;
    if let Some(blocklist) = cached {
        let reason = blocklist
            .blocked_reason(id, version, digest)
            .map_err(|error| {
                AppError::coded(StatusCode::CONFLICT, error.code.as_str(), error.message)
            })?;
        if let Some(reason) = reason {
            return Err(failure(
                service,
                id,
                version,
                Some(digest),
                ManagedFailureStage::Blocklist,
                "MANAGED_PROVIDER_BLOCKED",
                format!("managed provider {id} is blocked: {reason}"),
            ));
        }
    }
    Ok(())
}

pub(super) fn conformance_code(code: ManagedConformanceErrorCode) -> &'static str {
    match code {
        ManagedConformanceErrorCode::ProcessPolicyRejected => "MANAGED_PROCESS_POLICY_REJECTED",
        ManagedConformanceErrorCode::VersionFailed => "MANAGED_VERSION_PROBE_FAILED",
        ManagedConformanceErrorCode::ModelDiscoveryFailed => "MANAGED_MODEL_DISCOVERY_FAILED",
        ManagedConformanceErrorCode::InitializeFailed => "MANAGED_INITIALIZE_FAILED",
        ManagedConformanceErrorCode::SessionNewFailed => "MANAGED_SESSION_NEW_FAILED",
        ManagedConformanceErrorCode::ModelContractMismatch => "MANAGED_MODEL_CONTRACT_MISMATCH",
        ManagedConformanceErrorCode::ConfigurationFailed => "MANAGED_CONFIGURATION_FAILED",
        ManagedConformanceErrorCode::RestoreFailed => "MANAGED_RESTORE_FAILED",
        ManagedConformanceErrorCode::CleanupFailed => "MANAGED_CLEANUP_FAILED",
        ManagedConformanceErrorCode::TimedOut => "MANAGED_CONFORMANCE_TIMED_OUT",
    }
}

fn artifact_code(code: ArtifactErrorCode) -> &'static str {
    match code {
        ArtifactErrorCode::DownloadFailed => "MANAGED_ARTIFACT_DOWNLOAD_FAILED",
        ArtifactErrorCode::DownloadTooLarge => "MANAGED_ARTIFACT_TOO_LARGE",
        ArtifactErrorCode::HashMismatch => "MANAGED_ARTIFACT_HASH_MISMATCH",
        ArtifactErrorCode::UnsupportedArchive => "MANAGED_ARCHIVE_UNSUPPORTED",
        ArtifactErrorCode::UnsafeArchive => "MANAGED_ARCHIVE_UNSAFE",
        ArtifactErrorCode::ArchiveTooLarge => "MANAGED_ARCHIVE_TOO_LARGE",
        ArtifactErrorCode::TooManyEntries => "MANAGED_ARCHIVE_TOO_MANY_ENTRIES",
        ArtifactErrorCode::DuplicatePath => "MANAGED_ARCHIVE_DUPLICATE_PATH",
        ArtifactErrorCode::ExecutableOutsidePackage => "MANAGED_EXECUTABLE_OUTSIDE_PACKAGE",
        ArtifactErrorCode::ExecutableMissing => "MANAGED_EXECUTABLE_MISSING",
        ArtifactErrorCode::UnsafePermissions => "MANAGED_ARCHIVE_PERMISSIONS_UNSAFE",
        ArtifactErrorCode::Io => "MANAGED_ARTIFACT_IO_FAILED",
    }
}

pub(super) fn append_context(error: AppError, context: String) -> AppError {
    let message = |value: String| format!("{value}; {context}");
    match error {
        AppError::DatabaseError(value) => AppError::DatabaseError(message(value)),
        AppError::GitCommandError(value) => AppError::GitCommandError(message(value)),
        AppError::NotFound(value) => AppError::NotFound(message(value)),
        AppError::BadRequest(value) => AppError::BadRequest(message(value)),
        AppError::Internal(value) => AppError::Internal(message(value)),
        AppError::Conflict(value) => AppError::Conflict(message(value)),
        AppError::Coded {
            status,
            code,
            message: value,
        } => AppError::coded(status, code, message(value)),
        AppError::ServiceUnavailable(value) => AppError::ServiceUnavailable(message(value)),
        AppError::NeovimSpawnError { detail } => AppError::NeovimSpawnError {
            detail: message(detail),
        },
        error @ AppError::NeovimHandshakeTimeout => AppError::coded(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "NEOVIM_HANDSHAKE_TIMEOUT",
            message(error.to_string()),
        ),
        error @ AppError::NeovimNotRunning { .. } => AppError::coded(
            axum::http::StatusCode::NOT_FOUND,
            "NEOVIM_NOT_RUNNING",
            message(error.to_string()),
        ),
        error @ AppError::NeovimProcessNotRunning => AppError::coded(
            axum::http::StatusCode::NOT_FOUND,
            "NEOVIM_PROCESS_NOT_RUNNING",
            message(error.to_string()),
        ),
        error @ AppError::NeovimFileNotFound { .. } => AppError::coded(
            axum::http::StatusCode::NOT_FOUND,
            "NEOVIM_FILE_NOT_FOUND",
            message(error.to_string()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::history::{
        read_state, write_state, ManagedActiveRevision, ManagedHistoryAction, ManagedProviderState,
    };
    use crate::domain::agents::providers::installed::managed::installer::ManagedStorage;
    use crate::domain::agents::providers::installed::managed::quarantine::records;
    use crate::domain::agents::providers::installed::managed::receipt::ManagedRevision;
    use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;

    #[test]
    fn conformance_quarantine_does_not_change_active_revision() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(directory.path().join("managed"));
        let state_path = storage.state_path("acme-agent").unwrap();
        let mut state = ManagedProviderState::empty("acme-agent");
        state.transition(
            ManagedHistoryAction::Installed,
            Some(ManagedActiveRevision {
                revision: ManagedRevision {
                    version: "1.0.0".into(),
                    digest: "a".repeat(64),
                },
                enabled: true,
            }),
        );
        write_state(&state_path, &state).unwrap();
        let service = ManagedProviderService::builder()
            .client(reqwest::Client::new())
            .storage(storage.clone())
            .descriptors(directory.path().join("descriptors"))
            .trust_store(ManagedTrustStore::default())
            .build();

        let error = failure(
            &service,
            "acme-agent",
            "2.0.0",
            Some(&"b".repeat(64)),
            ManagedFailureStage::Conformance,
            "MANAGED_MODEL_CONTRACT_MISMATCH",
            "probe failed".into(),
        );
        assert!(matches!(error, AppError::Coded { .. }));
        assert_eq!(
            read_state(&state_path, "acme-agent")
                .unwrap()
                .active
                .unwrap()
                .revision
                .version,
            "1.0.0"
        );
        let quarantines = records(&storage, "acme-agent").unwrap();
        assert_eq!(quarantines.len(), 1);
        assert_eq!(quarantines[0].stage, ManagedFailureStage::Conformance);
    }

    #[test]
    fn quarantine_write_failure_is_included_in_the_api_error() {
        let directory = tempfile::tempdir().unwrap();
        let storage_root = directory.path().join("managed");
        std::fs::create_dir(&storage_root).unwrap();
        std::fs::write(storage_root.join("acme-agent"), b"not a directory").unwrap();
        let service = ManagedProviderService::builder()
            .client(reqwest::Client::new())
            .storage(ManagedStorage::new(storage_root))
            .descriptors(directory.path().join("descriptors"))
            .trust_store(ManagedTrustStore::default())
            .build();

        let error = failure(
            &service,
            "acme-agent",
            "1.0.0",
            None,
            ManagedFailureStage::Trust,
            "UNKNOWN_SIGNING_KEY",
            "untrusted".into(),
        );
        assert!(error
            .to_string()
            .contains("durable quarantine evidence could not be saved"));
    }
}
