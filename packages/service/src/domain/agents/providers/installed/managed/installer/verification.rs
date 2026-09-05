use std::path::Path;

use axum::http::StatusCode;

use super::super::receipt::{
    hash_regular_file, read_receipt, signed_payload_sha256, verify_payload_manifest,
    ManagedPackageReceipt, ManagedRevision,
};
use super::super::trust::ManagedTrustStore;
use crate::error::AppError;

pub(super) fn verify_existing_revision(
    revision_dir: &Path,
    expected: &ManagedPackageReceipt,
) -> Result<(), AppError> {
    let actual = read_receipt(&revision_dir.join("receipt.json"))?;
    verify_receipt_identity(&actual, &expected.agent.id, &expected.revision())?;
    if actual.executable_sha256 != expected.executable_sha256
        || actual.payload_files != expected.payload_files
        || immutable_metadata(&actual)? != immutable_metadata(expected)?
    {
        return Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_IMMUTABLE_REVISION_CONFLICT",
            "managed revision directory already exists with different verified metadata",
        ));
    }
    verify_receipt_payload(&revision_dir.join("payload"), &actual)
}

fn immutable_metadata(receipt: &ManagedPackageReceipt) -> Result<serde_json::Value, AppError> {
    // An index is a changing catalog, not the identity of one immutable revision.
    // Preserve the original receipt while allowing unrelated registry updates.
    let package = receipt
        .signed_index
        .signed
        .packages
        .iter()
        .find(|package| {
            package.agent.id == receipt.agent.id && package.agent.version == receipt.agent.version
        })
        .ok_or_else(|| invalid_receipt("retained index does not contain the receipt package"))?;
    serde_json::to_value((
        &receipt.agent,
        &receipt.publisher,
        &receipt.platform,
        &receipt.archive_url,
        &receipt.archive_sha256,
        &receipt.executable,
        &receipt.args,
        &receipt.env,
        &receipt.assets,
        package,
    ))
    .map_err(|error| AppError::Internal(format!("serialize immutable package metadata: {error}")))
}

pub(super) fn verify_receipt_identity(
    receipt: &ManagedPackageReceipt,
    provider_id: &str,
    revision: &ManagedRevision,
) -> Result<(), AppError> {
    if receipt.agent.id == provider_id && receipt.revision() == *revision {
        Ok(())
    } else {
        Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_RECEIPT_INVALID",
            "managed receipt identity does not match its storage path",
        ))
    }
}

pub(super) fn verify_receipt_payload(
    payload: &Path,
    receipt: &ManagedPackageReceipt,
) -> Result<(), AppError> {
    verify_payload_manifest(payload, &receipt.payload_files)?;
    for asset in [
        Some(receipt.assets.icon.as_str()),
        receipt.assets.readme.as_deref(),
        receipt.assets.license.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !receipt.payload_files.iter().any(|file| file.path == asset) {
            return Err(AppError::coded(
                StatusCode::CONFLICT,
                "MANAGED_RECEIPT_INVALID",
                format!("managed package asset {asset:?} is absent from its payload manifest"),
            ));
        }
    }
    let executable = payload.join(&receipt.executable);
    if hash_regular_file(&executable)? == receipt.executable_sha256 {
        Ok(())
    } else {
        Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_PAYLOAD_TAMPERED",
            format!(
                "managed executable {} failed integrity verification",
                executable.display()
            ),
        ))
    }
}

pub(super) fn verify_receipt_trust(
    receipt: &ManagedPackageReceipt,
    trust_store: &ManagedTrustStore,
) -> Result<(), AppError> {
    let signing_bytes = receipt
        .signed_index
        .signed
        .signing_bytes()
        .map_err(|error| AppError::Internal(format!("canonicalize retained index: {error}")))?;
    if signed_payload_sha256(&signing_bytes) != receipt.trust.signed_payload_sha256 {
        return Err(invalid_receipt(
            "retained signed provider index differs from the receipt",
        ));
    }
    let verified = trust_store
        .verify_index(receipt.signed_index.clone())
        .map_err(|error| {
            AppError::coded(StatusCode::CONFLICT, error.code.as_str(), error.message)
        })?;
    if verified.signer_key_id() != receipt.trust.index_key_id {
        return Err(invalid_receipt(
            "retained provider index signer differs from the receipt",
        ));
    }
    let package = verified
        .resolve_current_platform(
            &receipt.agent.id,
            &receipt.agent.version,
            env!("CARGO_PKG_VERSION"),
        )
        .map_err(|error| {
            AppError::coded(StatusCode::CONFLICT, error.code.as_str(), error.message)
        })?;
    let signed_package = verified
        .index()
        .packages
        .iter()
        .find(|candidate| {
            candidate.agent.id == receipt.agent.id
                && candidate.agent.version == receipt.agent.version
        })
        .ok_or_else(|| invalid_receipt("retained index no longer contains the receipt package"))?;
    let signed_agent = serde_json::to_value(&signed_package.agent)
        .map_err(|error| AppError::Internal(format!("serialize signed provider entry: {error}")))?;
    let receipt_agent = serde_json::to_value(&receipt.agent).map_err(|error| {
        AppError::Internal(format!("serialize receipt provider entry: {error}"))
    })?;
    if signed_agent != receipt_agent
        || package.publisher != receipt.publisher
        || package.platform != receipt.platform
        || package.assets != receipt.assets
        || package.archive != receipt.archive_url
        || package.archive_sha256 != receipt.archive_sha256
        || package.executable != receipt.executable
        || package.args != receipt.args
        || package.env != receipt.env
    {
        return Err(invalid_receipt(
            "retained signed package differs from activated receipt metadata",
        ));
    }
    Ok(())
}

fn invalid_receipt(message: &'static str) -> AppError {
    AppError::coded(StatusCode::CONFLICT, "MANAGED_RECEIPT_INVALID", message)
}
