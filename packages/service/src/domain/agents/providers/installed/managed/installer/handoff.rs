//! Namespace authorization never implies saved-session compatibility.
use super::{read_receipt, ManagedPackageReceipt, ManagedProviderState, ManagedStorage};
use crate::error::AppError;

pub(super) fn require_separate_installation(
    storage: &ManagedStorage,
    state: &ManagedProviderState,
    successor: &ManagedPackageReceipt,
) -> Result<(), AppError> {
    verify_admission_owner(
        storage,
        &state.provider_id,
        state.active.as_ref(),
        &successor.publisher,
        successor.agent.repository.as_deref(),
    )
}

pub(crate) fn verify_admission_owner(
    storage: &ManagedStorage,
    provider_id: &str,
    active: Option<&super::ManagedActiveRevision>,
    publisher: &str,
    repository: Option<&str>,
) -> Result<(), AppError> {
    let Some(active) = active else { return Ok(()) };
    let previous = read_receipt(
        &storage
            .revision_dir(provider_id, &active.revision)?
            .join("receipt.json"),
    )?;
    check_owners(&previous, publisher, repository)
}

fn check_owners(
    previous: &ManagedPackageReceipt,
    publisher: &str,
    repository: Option<&str>,
) -> Result<(), AppError> {
    if previous.publisher != publisher || previous.agent.repository.as_deref() != repository {
        return Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "MANAGED_PROVIDER_HANDOFF_REQUIRES_REMOVAL",
            "This provider changed publisher or source. Explicitly remove the installed provider before installing its successor. Saved conversations and native sessions are retained; compatibility is unverified. Start a new conversation with the successor.",
        ));
    }
    Ok(())
}

/// Read the immutable owner proof without changing installed or conversation state.
pub(crate) fn session_receipt(
    executable: &std::path::Path,
) -> Result<Option<ManagedPackageReceipt>, AppError> {
    let storage = ManagedStorage::production();
    let parsed = super::guard::parse_managed_executable(&storage, executable)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some((id, revision, relative)) = parsed else {
        return Ok(None);
    };
    let receipt = read_receipt(&storage.revision_dir(&id, &revision)?.join("receipt.json"))?;
    super::verify_receipt_identity(&receipt, &id, &revision)?;
    super::verify_receipt_trust(&receipt, &super::super::trust::pinned_index_trust_store())?;
    if std::path::Path::new(&receipt.executable) != relative {
        return Err(AppError::Internal(
            "managed session executable differs from its owner proof".into(),
        ));
    }
    Ok(Some(receipt))
}
