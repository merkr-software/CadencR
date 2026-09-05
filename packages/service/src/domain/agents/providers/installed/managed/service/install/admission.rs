use std::path::Path;

use axum::http::StatusCode;

use super::super::ManagedProviderService;
use super::errors::{
    append_context, artifact_failure, conformance_code, failure, failure_from_app,
};
use crate::domain::agents::providers::installed::descriptor::AcpAgentEntry;
use crate::domain::agents::providers::installed::managed::archive::extract_verified;
use crate::domain::agents::providers::installed::managed::conformance::{
    verify_managed_provider, ManagedConformanceReport, ManagedConformanceRequest,
};
use crate::domain::agents::providers::installed::managed::download::download_verified;
use crate::domain::agents::providers::installed::managed::quarantine::ManagedFailureStage;
use crate::domain::agents::providers::installed::managed::receipt::{
    installed_now, signed_payload_sha256, ManagedConformanceReceipt, ManagedPackageReceipt,
    ManagedPayloadFile, ManagedTrustReceipt, MANAGED_RECEIPT_SCHEMA_VERSION,
};
use crate::domain::agents::providers::installed::managed::{
    ResolvedManagedProviderPackage, SignedManagedProviderIndex,
};
use crate::error::AppError;

pub(super) struct AdmissionRequest<'a> {
    pub(super) package: &'a ResolvedManagedProviderPackage,
    pub(super) agent: AcpAgentEntry,
    pub(super) signed_index: SignedManagedProviderIndex,
    pub(super) signer_key_id: &'a str,
}

pub(super) async fn admit(
    service: &ManagedProviderService,
    request: AdmissionRequest<'_>,
) -> Result<ManagedPackageReceipt, AppError> {
    let staging = service.storage.create_staging_dir().map_err(|error| {
        failure_from_app(
            service,
            &request.package.provider_id,
            &request.package.provider_version,
            Some(&request.package.archive_sha256),
            ManagedFailureStage::Payload,
            "MANAGED_STAGING_CREATE_FAILED",
            error,
        )
    })?;
    let result = admit_staged(service, &request, &staging).await;
    let cleanup = std::fs::remove_dir_all(&staging)
        .map_err(|error| AppError::Internal(format!("remove managed staging: {error}")));
    match (result, cleanup) {
        (Ok(receipt), Ok(())) => Ok(receipt),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(cleanup_failure(service, &request, error)),
        (Err(error), Err(cleanup)) => Err(cleanup_failure(
            service,
            &request,
            append_context(error, cleanup.to_string()),
        )),
    }
}

async fn admit_staged(
    service: &ManagedProviderService,
    request: &AdmissionRequest<'_>,
    staging: &Path,
) -> Result<ManagedPackageReceipt, AppError> {
    let package = request.package;
    let artifact = download_verified(
        &service.client,
        &package.archive,
        &package.archive_sha256,
        &staging.join("artifact.download"),
    )
    .await
    .map_err(|error| artifact_failure(service, package, ManagedFailureStage::Download, error))?;
    let archive_size = artifact.size();
    let archive_sha256 = artifact.sha256().to_string();
    let revision_staging = staging.join("revision");
    let payload = revision_staging.join("payload");
    let executable = package.executable.clone();
    let extracted =
        tokio::task::spawn_blocking(move || extract_verified(&artifact, &payload, &executable))
            .await
            .map_err(|error| {
                AppError::Internal(format!("managed extraction task failed: {error}"))
            })?
            .map_err(|error| {
                artifact_failure(service, package, ManagedFailureStage::Extraction, error)
            })?;
    let archive_file_count = u32::try_from(extracted.file_count())
        .map_err(|_| AppError::Internal("managed archive file count overflowed u32".into()))
        .map_err(|error| {
            payload_failure(service, package, "MANAGED_ARCHIVE_METADATA_INVALID", error)
        })?;
    let manifest_before = super::blocking::manifest(extracted.package_root().to_path_buf())
        .await
        .map_err(|error| {
            failure(
                service,
                &package.provider_id,
                &package.provider_version,
                Some(&package.archive_sha256),
                ManagedFailureStage::Payload,
                "MANAGED_PAYLOAD_INVALID",
                error.to_string(),
            )
        })?;
    ensure_assets_present(package, &manifest_before)
        .map_err(|error| payload_failure(service, package, "MANAGED_ASSET_MISSING", error))?;
    let report = run_conformance(service, staging, package, extracted.executable()).await?;
    let manifest_after = super::blocking::manifest(extracted.package_root().to_path_buf())
        .await
        .map_err(|error| payload_failure(service, package, "MANAGED_PAYLOAD_INVALID", error))?;
    if manifest_after != manifest_before {
        return Err(failure(
            service,
            &package.provider_id,
            &package.provider_version,
            Some(&package.archive_sha256),
            ManagedFailureStage::Payload,
            "MANAGED_PAYLOAD_MUTATED_DURING_CONFORMANCE",
            "managed provider changed package bytes during conformance".into(),
        ));
    }
    let executable_sha256 = super::blocking::hash_file(extracted.executable().to_path_buf())
        .await
        .map_err(|error| {
            payload_failure(service, package, "MANAGED_RECEIPT_BUILD_FAILED", error)
        })?;
    let receipt = build_receipt(ReceiptInput {
        package,
        agent: request.agent.clone(),
        signed_index: request.signed_index.clone(),
        signer_key_id: request.signer_key_id,
        archive_size,
        archive_file_count,
        archive_uncompressed_bytes: extracted.uncompressed_bytes(),
        archive_sha256,
        payload_files: manifest_after,
        report,
        executable_sha256,
    })
    .map_err(|error| payload_failure(service, package, "MANAGED_RECEIPT_BUILD_FAILED", error))?;
    super::blocking::commit_revision(service.storage.clone(), revision_staging, receipt.clone())
        .await
        .map_err(|error| {
            payload_failure(service, package, "MANAGED_REVISION_COMMIT_FAILED", error)
        })?;
    Ok(receipt)
}

fn cleanup_failure(
    service: &ManagedProviderService,
    request: &AdmissionRequest<'_>,
    error: AppError,
) -> AppError {
    failure(
        service,
        &request.package.provider_id,
        &request.package.provider_version,
        Some(&request.package.archive_sha256),
        ManagedFailureStage::Payload,
        "MANAGED_STAGING_CLEANUP_FAILED",
        error.to_string(),
    )
}

fn payload_failure(
    service: &ManagedProviderService,
    package: &ResolvedManagedProviderPackage,
    code: &'static str,
    error: AppError,
) -> AppError {
    failure_from_app(
        service,
        &package.provider_id,
        &package.provider_version,
        Some(&package.archive_sha256),
        ManagedFailureStage::Payload,
        code,
        error,
    )
}

async fn run_conformance(
    service: &ManagedProviderService,
    staging: &Path,
    package: &ResolvedManagedProviderPackage,
    executable: &Path,
) -> Result<ManagedConformanceReport, AppError> {
    let workspace = staging.join("conformance-workspace");
    std::fs::create_dir(&workspace)
        .map_err(|error| AppError::Internal(format!("create conformance workspace: {error}")))
        .map_err(|error| {
            failure_from_app(
                service,
                &package.provider_id,
                &package.provider_version,
                Some(&package.archive_sha256),
                ManagedFailureStage::Conformance,
                "MANAGED_CONFORMANCE_WORKSPACE_FAILED",
                error,
            )
        })?;
    verify_managed_provider(
        ManagedConformanceRequest::builder()
            .executable(executable.to_path_buf())
            .args(package.args.clone())
            .env(package.env.clone())
            .cwd(workspace)
            .expected_provider_version(package.provider_version.clone())
            .build(),
    )
    .await
    .map_err(|error| {
        let code = conformance_code(error.code);
        failure(
            service,
            &package.provider_id,
            &package.provider_version,
            Some(&package.archive_sha256),
            ManagedFailureStage::Conformance,
            code,
            error.message,
        )
    })
}

struct ReceiptInput<'a> {
    package: &'a ResolvedManagedProviderPackage,
    agent: AcpAgentEntry,
    signed_index: SignedManagedProviderIndex,
    signer_key_id: &'a str,
    archive_size: u64,
    archive_file_count: u32,
    archive_uncompressed_bytes: u64,
    archive_sha256: String,
    payload_files: Vec<ManagedPayloadFile>,
    report: ManagedConformanceReport,
    executable_sha256: String,
}

fn build_receipt(input: ReceiptInput<'_>) -> Result<ManagedPackageReceipt, AppError> {
    let signing_bytes = input
        .signed_index
        .signed
        .signing_bytes()
        .map_err(|error| AppError::Internal(format!("canonicalize provider index: {error}")))?;
    let model_count = u32::try_from(input.report.discovered_model_count)
        .map_err(|_| AppError::Internal("managed model count overflowed u32".into()))?;
    Ok(ManagedPackageReceipt::builder()
        .schema_version(MANAGED_RECEIPT_SCHEMA_VERSION)
        .agent(input.agent)
        .publisher(input.package.publisher.clone())
        .platform(input.package.platform.clone())
        .archive_url(input.package.archive.clone())
        .archive_sha256(input.archive_sha256)
        .archive_size(input.archive_size)
        .archive_file_count(input.archive_file_count)
        .archive_uncompressed_bytes(input.archive_uncompressed_bytes)
        .executable(input.package.executable.clone())
        .executable_sha256(input.executable_sha256)
        .payload_files(input.payload_files)
        .args(input.package.args.clone())
        .env(input.package.env.clone())
        .assets(input.package.assets.clone())
        .installed_at(installed_now())
        .trust(ManagedTrustReceipt {
            index_key_id: input.signer_key_id.to_string(),
            signed_payload_sha256: signed_payload_sha256(&signing_bytes),
        })
        .conformance(conformance_receipt(input.report, model_count))
        .signed_index(input.signed_index)
        .build())
}

fn conformance_receipt(
    report: ManagedConformanceReport,
    model_count: u32,
) -> ManagedConformanceReceipt {
    ManagedConformanceReceipt {
        verified_at: installed_now(),
        version: report.version,
        verified_version: report.verified_version,
        model_config_id: report.model_config_id,
        model_ids: report.model_ids,
        model_count,
        default_model: report.default_model,
        resume: report.resume,
        load: report.load,
        close: report.close,
        prompt: report.prompt,
        os_sandbox_applied: report.os_sandbox_applied,
    }
}

fn ensure_assets_present(
    package: &ResolvedManagedProviderPackage,
    manifest: &[ManagedPayloadFile],
) -> Result<(), AppError> {
    for path in [
        Some(package.assets.icon.as_str()),
        package.assets.readme.as_deref(),
        package.assets.license.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !manifest.iter().any(|file| file.path == path) {
            return Err(AppError::coded(
                StatusCode::CONFLICT,
                "MANAGED_ASSET_MISSING",
                format!("managed package asset {path:?} is missing"),
            ));
        }
    }
    Ok(())
}
