use axum::http::StatusCode;

use super::{ManagedMutation, ManagedProviderService};
use crate::domain::agents::providers::installed::descriptor::validate_provider_id;
use crate::domain::agents::providers::installed::descriptor::AcpAgentEntry;
use crate::domain::agents::providers::installed::managed::conformance::{
    verify_managed_provider, ManagedConformanceRequest,
};
use crate::domain::agents::providers::installed::managed::history::{
    read_state, ManagedActiveRevision, ManagedHistoryAction,
};
use crate::domain::agents::providers::installed::managed::installer::activate_revision;
use crate::domain::agents::providers::installed::managed::quarantine::ManagedFailureStage;
use crate::domain::agents::providers::installed::managed::receipt::{
    ManagedPackageReceipt, ManagedRevision,
};
use crate::domain::agents::providers::installed::managed::ResolvedManagedProviderPackage;
use crate::domain::agents::providers::installed::managed::SignedManagedProviderIndex;
use crate::error::AppError;
use admission::AdmissionRequest;
use errors::{
    check_blocklist, check_blocklist_receipt, conformance_code, failure, failure_from_app,
};

mod admission;
mod blocking;
mod errors;

#[derive(Debug, Clone, Copy)]
pub(super) enum IngestKind {
    Install,
    Update,
}

struct ResolvedAdmission {
    package: ResolvedManagedProviderPackage,
    agent: AcpAgentEntry,
    signer_key_id: String,
}

pub(super) async fn ingest(
    service: &ManagedProviderService,
    provider_id: &str,
    version: &str,
    index: SignedManagedProviderIndex,
    kind: IngestKind,
) -> Result<ManagedMutation, AppError> {
    validate_request_identity(provider_id, version)?;
    let (expected_active, enabled) = lifecycle_precondition(service, provider_id, kind)?;
    let resolved = resolve_admission(service, provider_id, version, &index)?;
    check_blocklist(service, &resolved.package)?;
    let receipt = admission::admit(
        service,
        AdmissionRequest {
            package: &resolved.package,
            agent: resolved.agent,
            signed_index: index,
            signer_key_id: &resolved.signer_key_id,
        },
    )
    .await?;
    let action = match kind {
        IngestKind::Install => ManagedHistoryAction::Installed,
        IngestKind::Update => ManagedHistoryAction::Updated,
    };
    let state = activate_revision(
        &service.storage,
        &service.descriptors,
        &receipt,
        action,
        enabled,
        expected_active.as_ref(),
    )
    .await
    .map_err(|error| {
        failure_from_app(
            service,
            provider_id,
            version,
            Some(&resolved.package.archive_sha256),
            ManagedFailureStage::Activation,
            "MANAGED_ACTIVATION_FAILED",
            error,
        )
    })?;
    Ok(ManagedMutation {
        state,
        receipt: Some(receipt),
    })
}

fn resolve_admission(
    service: &ManagedProviderService,
    provider_id: &str,
    version: &str,
    index: &SignedManagedProviderIndex,
) -> Result<ResolvedAdmission, AppError> {
    let verified = service
        .trust_store
        .verify_index(index.clone())
        .map_err(|error| {
            failure(
                service,
                provider_id,
                version,
                None,
                ManagedFailureStage::Trust,
                error.code.as_str(),
                error.message,
            )
        })?;
    let package = verified
        .resolve_current_platform(provider_id, version, env!("CARGO_PKG_VERSION"))
        .map_err(|error| {
            failure(
                service,
                provider_id,
                version,
                None,
                ManagedFailureStage::Compatibility,
                error.code.as_str(),
                error.message,
            )
        })?;
    let agent = verified
        .index()
        .packages
        .iter()
        .find(|candidate| candidate.agent.id == provider_id && candidate.agent.version == version)
        .expect("verified exact package resolution")
        .agent
        .clone();
    Ok(ResolvedAdmission {
        package,
        agent,
        signer_key_id: verified.signer_key_id().to_string(),
    })
}

pub(super) async fn rollback(
    service: &ManagedProviderService,
    provider_id: &str,
    revision: &ManagedRevision,
) -> Result<ManagedMutation, AppError> {
    validate_request_identity(provider_id, &revision.version)?;
    let state = read_state(&service.storage.state_path(provider_id)?, provider_id)?;
    let expected_active = state
        .active
        .as_ref()
        .ok_or_else(|| {
            AppError::coded(
                StatusCode::NOT_FOUND,
                "MANAGED_PROVIDER_NOT_INSTALLED",
                format!("managed provider {provider_id:?} is not installed"),
            )
        })?
        .clone();
    let payload = service.storage.payload_dir(provider_id, revision)?;
    let receipt = blocking::rollback_candidate(
        service.storage.clone(),
        provider_id.to_string(),
        revision.clone(),
        service.trust_store.clone(),
    )
    .await?;
    check_blocklist_receipt(service, &receipt)?;
    verify_rollback_conformance(service, provider_id, revision, &payload, &receipt).await?;
    let (state, receipt) =
        crate::domain::agents::providers::installed::managed::installer::rollback(
            &service.storage,
            &service.descriptors,
            provider_id,
            revision,
            &expected_active,
            &service.trust_store,
        )
        .await
        .map_err(|error| {
            failure_from_app(
                service,
                provider_id,
                &revision.version,
                Some(&revision.digest),
                ManagedFailureStage::Rollback,
                "MANAGED_ROLLBACK_FAILED",
                error,
            )
        })?;
    Ok(ManagedMutation {
        state,
        receipt: Some(receipt),
    })
}

async fn verify_rollback_conformance(
    service: &ManagedProviderService,
    provider_id: &str,
    revision: &ManagedRevision,
    payload: &std::path::Path,
    receipt: &ManagedPackageReceipt,
) -> Result<(), AppError> {
    let manifest_before = blocking::manifest(payload.to_path_buf()).await?;
    let workspace = tempfile::tempdir()
        .map_err(|error| AppError::Internal(format!("create rollback workspace: {error}")))?;
    let conformance = verify_managed_provider(
        ManagedConformanceRequest::builder()
            .executable(payload.join(&receipt.executable))
            .args(receipt.args.clone())
            .env(receipt.env.clone())
            .cwd(workspace.path().to_path_buf())
            .expected_provider_version(revision.version.clone())
            .build(),
    )
    .await;
    let cleanup = workspace.close().map_err(|error| {
        AppError::Internal(format!("remove rollback conformance workspace: {error}"))
    });
    let _report = match (conformance, cleanup) {
        (Ok(report), Ok(())) => report,
        (Err(error), Ok(())) => {
            let code = conformance_code(error.code);
            return Err(failure(
                service,
                provider_id,
                &revision.version,
                Some(&revision.digest),
                ManagedFailureStage::Conformance,
                code,
                error.message,
            ));
        }
        (Ok(_), Err(error)) => {
            return Err(failure_from_app(
                service,
                provider_id,
                &revision.version,
                Some(&revision.digest),
                ManagedFailureStage::Conformance,
                "MANAGED_CONFORMANCE_CLEANUP_FAILED",
                error,
            ))
        }
        (Err(error), Err(cleanup)) => {
            let code = conformance_code(error.code);
            return Err(failure(
                service,
                provider_id,
                &revision.version,
                Some(&revision.digest),
                ManagedFailureStage::Conformance,
                code,
                format!("{}; additionally {cleanup}", error.message),
            ));
        }
    };
    if blocking::manifest(payload.to_path_buf()).await? != manifest_before {
        return Err(failure(
            service,
            provider_id,
            &revision.version,
            Some(&revision.digest),
            ManagedFailureStage::Payload,
            "MANAGED_PAYLOAD_MUTATED_DURING_CONFORMANCE",
            "managed provider changed package bytes during rollback conformance".into(),
        ));
    }
    Ok(())
}

fn validate_request_identity(provider_id: &str, version: &str) -> Result<(), AppError> {
    validate_provider_id(provider_id).map_err(|error| {
        AppError::coded(StatusCode::BAD_REQUEST, error.code.as_str(), error.message)
    })?;
    semver::Version::parse(version).map_err(|error| {
        AppError::coded(
            StatusCode::BAD_REQUEST,
            "MANAGED_VERSION_INVALID",
            format!("provider version must be exact semantic version: {error}"),
        )
    })?;
    Ok(())
}

fn lifecycle_precondition(
    service: &ManagedProviderService,
    provider_id: &str,
    kind: IngestKind,
) -> Result<(Option<ManagedActiveRevision>, bool), AppError> {
    let state = read_state(&service.storage.state_path(provider_id)?, provider_id)?;
    match (kind, state.active.is_some()) {
        (IngestKind::Install, true) => Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_PROVIDER_ALREADY_INSTALLED",
            format!("managed provider {provider_id:?} is already installed"),
        )),
        (IngestKind::Update, false) => Err(AppError::coded(
            StatusCode::NOT_FOUND,
            "MANAGED_PROVIDER_NOT_INSTALLED",
            format!("managed provider {provider_id:?} is not installed"),
        )),
        _ => Ok((
            state.active.clone(),
            state.active.map(|active| active.enabled).unwrap_or(true),
        )),
    }
}
