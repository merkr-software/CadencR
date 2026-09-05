//! Immutable managed payload placement and atomic desired-state activation.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::history::{
    read_state, write_state, ManagedActiveRevision, ManagedHistoryAction, ManagedProviderState,
};
use super::receipt::{
    read_receipt, receipt_path, write_receipt, ManagedPackageReceipt, ManagedRevision,
};
use super::trust::ManagedTrustStore;
use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
use crate::domain::agents::providers::installed::installation::HostInstallation;
use crate::domain::agents::providers::installed::lifecycle::{
    descriptor_path, ensure_descriptor_id_available, lifecycle_lock,
};
use crate::error::AppError;
use crate::shared::{atomic_file, fs_durability};
use axum::http::StatusCode;

mod guard;
mod storage;
mod verification;
pub use guard::is_managed_executable;
pub(crate) use guard::{is_managed_executable_in, verify_managed_launch_in};
use storage::create_secure_dir;
pub use storage::ManagedStorage;
use verification::{
    verify_existing_revision, verify_receipt_identity, verify_receipt_payload, verify_receipt_trust,
};

pub const MANAGED_PROVIDER_NOT_INSTALLED: &str = "MANAGED_PROVIDER_NOT_INSTALLED";

/// Place a fully verified staging revision under its immutable identity.
///
/// `staging_revision` must contain `payload/`; the receipt is written beside it
/// before the directory is atomically renamed into `<id>/<version>/<digest>/`.
pub fn commit_staged_revision(
    storage: &ManagedStorage,
    staging_revision: &Path,
    receipt: &ManagedPackageReceipt,
) -> Result<PathBuf, AppError> {
    let revision = receipt.revision();
    let destination = storage.revision_dir(&receipt.agent.id, &revision)?;
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::Internal("managed revision has no parent".into()))?;
    create_secure_dir(parent)?;
    write_receipt(&staging_revision.join("receipt.json"), receipt)?;
    if let Err(error) = std::fs::rename(staging_revision, &destination) {
        if !destination.exists() {
            return Err(AppError::Internal(format!(
                "commit managed revision {}: {error}",
                destination.display()
            )));
        }
        verify_existing_revision(&destination, receipt)?;
        std::fs::remove_dir_all(staging_revision).map_err(|cleanup_error| {
            AppError::Internal(format!(
                "remove duplicate managed staging revision {} after commit collision: {cleanup_error}",
                staging_revision.display()
            ))
        })?;
        return Ok(destination.join("payload"));
    }
    fs_durability::sync_directory(parent)
        .map_err(|error| AppError::Internal(format!("sync managed revision parent: {error}")))?;
    Ok(destination.join("payload"))
}

pub async fn activate_revision(
    storage: &ManagedStorage,
    descriptors: &Path,
    receipt: &ManagedPackageReceipt,
    action: ManagedHistoryAction,
    enabled: bool,
    expected_active: Option<&ManagedActiveRevision>,
) -> Result<ManagedProviderState, AppError> {
    let _guard = lifecycle_lock().lock().await;
    let state = read_state(&storage.state_path(&receipt.agent.id)?, &receipt.agent.id)?;
    if state.active.as_ref() != expected_active {
        return Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_INSTALL_STATE_CHANGED",
            "managed provider activation changed while package admission was running",
        ));
    }
    activate_revision_locked(storage, descriptors, receipt, action, enabled)
}

fn activate_revision_locked(
    storage: &ManagedStorage,
    descriptors: &Path,
    receipt: &ManagedPackageReceipt,
    action: ManagedHistoryAction,
    enabled: bool,
) -> Result<ManagedProviderState, AppError> {
    let state_path = storage.state_path(&receipt.agent.id)?;
    let mut state = read_state(&state_path, &receipt.agent.id)?;
    if action == ManagedHistoryAction::Installed {
        ensure_descriptor_id_available(
            descriptors,
            &receipt.agent.id,
            &super::super::super::registry::builtin_provider_identifiers(),
        )?;
    }
    state.transition(
        action,
        Some(ManagedActiveRevision {
            revision: receipt.revision(),
            enabled,
        }),
    );
    persist_authoritative_state(storage, descriptors, &state_path, &state)?;
    Ok(state)
}

pub async fn set_enabled(
    storage: &ManagedStorage,
    descriptors: &Path,
    provider_id: &str,
    enabled: bool,
) -> Result<ManagedProviderState, AppError> {
    let _guard = lifecycle_lock().lock().await;
    let path = storage.state_path(provider_id)?;
    let mut state = read_state(&path, provider_id)?;
    let mut active = state
        .active
        .clone()
        .ok_or_else(|| not_installed(provider_id))?;
    if active.enabled == enabled {
        return Ok(state);
    }
    active.enabled = enabled;
    state.transition(
        if enabled {
            ManagedHistoryAction::Enabled
        } else {
            ManagedHistoryAction::Disabled
        },
        Some(active),
    );
    persist_authoritative_state(storage, descriptors, &path, &state)?;
    Ok(state)
}

pub async fn remove(
    storage: &ManagedStorage,
    descriptors: &Path,
    provider_id: &str,
) -> Result<ManagedProviderState, AppError> {
    let _guard = lifecycle_lock().lock().await;
    let path = storage.state_path(provider_id)?;
    let mut state = read_state(&path, provider_id)?;
    if state.active.is_none() {
        return Err(not_installed(provider_id));
    }
    state.transition(ManagedHistoryAction::Removed, None);
    persist_authoritative_state(storage, descriptors, &path, &state)?;
    Ok(state)
}

pub async fn rollback(
    storage: &ManagedStorage,
    descriptors: &Path,
    provider_id: &str,
    revision: &ManagedRevision,
    expected_active: &ManagedActiveRevision,
    trust_store: &ManagedTrustStore,
) -> Result<(ManagedProviderState, ManagedPackageReceipt), AppError> {
    let _guard = lifecycle_lock().lock().await;
    let receipt = verify_rollback_candidate(storage, provider_id, revision, trust_store)?;
    let current = read_state(&storage.state_path(provider_id)?, provider_id)?;
    if current.active.as_ref() != Some(expected_active) {
        return Err(AppError::coded(
            StatusCode::CONFLICT,
            "MANAGED_INSTALL_STATE_CHANGED",
            "managed provider activation changed while rollback verification was running",
        ));
    }
    let enabled = current
        .active
        .as_ref()
        .ok_or_else(|| not_installed(provider_id))?
        .enabled;
    let state = activate_revision_locked(
        storage,
        descriptors,
        &receipt,
        ManagedHistoryAction::RolledBack,
        enabled,
    )?;
    Ok((state, receipt))
}

pub fn verify_rollback_candidate(
    storage: &ManagedStorage,
    provider_id: &str,
    revision: &ManagedRevision,
    trust_store: &ManagedTrustStore,
) -> Result<ManagedPackageReceipt, AppError> {
    let payload = storage.payload_dir(provider_id, revision)?;
    let receipt = read_receipt(&receipt_path(&payload)?)?;
    verify_receipt_identity(&receipt, provider_id, revision)?;
    verify_receipt_trust(&receipt, trust_store)?;
    verify_receipt_payload(&payload, &receipt)?;
    Ok(receipt)
}

pub fn reconcile_descriptors(storage: &ManagedStorage, descriptors: &Path) -> HashSet<String> {
    let mut failed = HashSet::new();
    for provider_id in storage.provider_ids() {
        let result = storage
            .state_path(&provider_id)
            .and_then(|path| read_state(&path, &provider_id))
            .and_then(|state| prepare_descriptor_sync(storage, descriptors, &state))
            .and_then(apply_descriptor_sync);
        if let Err(error) = result {
            tracing::error!(provider_id, %error, "managed provider descriptor reconciliation failed");
            failed.insert(provider_id);
        }
    }
    failed
}

enum DescriptorSync {
    Write {
        path: PathBuf,
        json: String,
    },
    Retire {
        storage: ManagedStorage,
        path: PathBuf,
        provider_id: String,
    },
}

pub(super) struct VerifiedDescriptorProjection {
    pub path: PathBuf,
    pub descriptor: ProviderDescriptor,
    pub executable: PathBuf,
}

/// Verify the exact descriptor projection that the next startup scan consumes.
/// Trust and blocklist enforcement remain launch-time checks and are intentionally
/// not part of this inexpensive registration-readiness check.
pub(super) fn verify_descriptor_projection(
    storage: &ManagedStorage,
    descriptors: &Path,
    state: &ManagedProviderState,
) -> Result<Option<VerifiedDescriptorProjection>, AppError> {
    let path = descriptor_path(descriptors, &state.provider_id)?;
    let Some(active) = state.active.as_ref().filter(|active| active.enabled) else {
        return Ok(None);
    };
    let payload = storage.payload_dir(&state.provider_id, &active.revision)?;
    let receipt = read_receipt(&receipt_path(&payload)?)?;
    verify_receipt_identity(&receipt, &state.provider_id, &active.revision)?;
    verify_receipt_payload(&payload, &receipt)?;
    let descriptor = receipt.descriptor(&payload, active.enabled);
    descriptor.validate().map_err(|error| {
        AppError::coded(StatusCode::CONFLICT, error.code.as_str(), error.message)
    })?;
    let installation =
        HostInstallation::from_descriptor(descriptor.clone(), &path).map_err(|error| {
            AppError::coded(StatusCode::CONFLICT, error.code.as_str(), error.message)
        })?;
    Ok(Some(VerifiedDescriptorProjection {
        path,
        descriptor,
        executable: installation.executable().command.clone(),
    }))
}

fn persist_authoritative_state(
    storage: &ManagedStorage,
    descriptors: &Path,
    state_path: &Path,
    state: &ManagedProviderState,
) -> Result<(), AppError> {
    // `state.json` is the sole activation pointer. The descriptor is a derived
    // compatibility projection for the startup loader: validate and serialize
    // it before committing state, then repair any I/O failure on startup.
    let projection = prepare_descriptor_sync(storage, descriptors, state)?;
    write_state(state_path, state)?;
    if let Err(error) = apply_descriptor_sync(projection) {
        let (version, digest) = projection_failure_identity(state);
        if let Err(record_error) = super::quarantine::append(
            storage,
            &state.provider_id,
            version,
            digest,
            super::quarantine::ManagedFailureStage::Activation,
            "MANAGED_DESCRIPTOR_RECONCILIATION_REQUIRED",
        ) {
            return Err(AppError::coded(
                StatusCode::CONFLICT,
                "MANAGED_DESCRIPTOR_RECONCILIATION_REQUIRED",
                format!(
                    "authoritative managed-provider state was committed, but its startup descriptor requires reconciliation: {error}; durable diagnostic could not be saved: {record_error}"
                ),
            ));
        }
        tracing::warn!(
            provider_id = state.provider_id,
            %error,
            "managed provider state committed; durable reconciliation diagnostic recorded"
        );
    }
    Ok(())
}

fn projection_failure_identity(state: &ManagedProviderState) -> (&str, Option<&str>) {
    if let Some(active) = &state.active {
        return (&active.revision.version, Some(&active.revision.digest));
    }
    let history = state.history.last();
    (
        history
            .and_then(|entry| entry.previous_version.as_deref())
            .unwrap_or("0.0.0"),
        history.and_then(|entry| entry.previous_digest.as_deref()),
    )
}

fn prepare_descriptor_sync(
    storage: &ManagedStorage,
    descriptors: &Path,
    state: &ManagedProviderState,
) -> Result<DescriptorSync, AppError> {
    let Some(projection) = verify_descriptor_projection(storage, descriptors, state)? else {
        return Ok(DescriptorSync::Retire {
            storage: storage.clone(),
            path: descriptor_path(descriptors, &state.provider_id)?,
            provider_id: state.provider_id.clone(),
        });
    };
    let mut json = serde_json::to_string_pretty(&projection.descriptor)
        .map_err(|error| AppError::Internal(format!("serialize managed descriptor: {error}")))?;
    json.push('\n');
    Ok(DescriptorSync::Write {
        path: projection.path,
        json,
    })
}

fn apply_descriptor_sync(projection: DescriptorSync) -> Result<(), AppError> {
    match projection {
        DescriptorSync::Write { path, json } => atomic_file::write_atomic_private(&path, &json),
        DescriptorSync::Retire {
            storage,
            path,
            provider_id,
        } => retire_managed_descriptor(&storage, &path, &provider_id),
    }
}

fn retire_managed_descriptor(
    storage: &ManagedStorage,
    descriptor: &Path,
    provider_id: &str,
) -> Result<(), AppError> {
    let raw = match std::fs::read(descriptor) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(AppError::Internal(format!(
                "read managed descriptor: {error}"
            )))
        }
    };
    let existing: ProviderDescriptor = serde_json::from_slice(&raw)
        .map_err(|error| AppError::Internal(format!("parse managed descriptor: {error}")))?;
    let command = existing
        .installation
        .executable
        .as_ref()
        .map(|executable| Path::new(&executable.command));
    if !command.is_some_and(|command| command.starts_with(storage.root())) {
        return Ok(());
    }
    let retired = storage
        .provider_dir(provider_id)?
        .join(format!("descriptor-retired-{}.json", uuid::Uuid::new_v4()));
    std::fs::rename(descriptor, retired)
        .map_err(|error| AppError::Internal(format!("retire managed descriptor: {error}")))
}

fn not_installed(provider_id: &str) -> AppError {
    AppError::coded(
        StatusCode::NOT_FOUND,
        MANAGED_PROVIDER_NOT_INSTALLED,
        format!("managed provider {provider_id:?} is not installed"),
    )
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;
    use crate::domain::agents::providers::installed::managed::conformance::ManagedProbeOutcome;
    use crate::domain::agents::providers::installed::managed::quarantine::records;
    use crate::domain::agents::providers::installed::managed::receipt::{
        hash_regular_file, installed_now, payload_manifest, signed_payload_sha256,
        ManagedConformanceReceipt, ManagedTrustReceipt, MANAGED_RECEIPT_SCHEMA_VERSION,
    };
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;
    use crate::domain::agents::providers::installed::managed::SignedManagedProviderIndex;

    fn uncommitted_receipt() -> (tempfile::TempDir, ManagedPackageReceipt) {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("revision");
        let payload = staging.join("payload");
        std::fs::create_dir_all(payload.join("assets")).unwrap();
        std::fs::create_dir_all(payload.join("bin")).unwrap();
        std::fs::write(payload.join("bin/acme-agent"), b"agent").unwrap();
        std::fs::write(payload.join("assets/icon.svg"), b"<svg/>").unwrap();
        std::fs::write(payload.join("README.md"), b"readme").unwrap();
        std::fs::write(payload.join("LICENSE"), b"license").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(
                payload.join("bin/acme-agent"),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        let mut index: SignedManagedProviderIndex = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        let signing_key = SigningKey::from_bytes(&[23; 32]);
        let signing_bytes = index.signed.signing_bytes().unwrap();
        index.signature.key_id = "managed-installer-test".into();
        index.signature.value = base64::engine::general_purpose::STANDARD
            .encode(signing_key.sign(&signing_bytes).to_bytes());
        let package = index
            .resolve_current_platform("acme-agent", "1.2.3", env!("CARGO_PKG_VERSION"))
            .unwrap();
        let agent = index.signed.packages[0].agent.clone();
        let receipt = ManagedPackageReceipt::builder()
            .schema_version(MANAGED_RECEIPT_SCHEMA_VERSION)
            .agent(agent)
            .publisher(package.publisher)
            .platform(package.platform)
            .archive_url(package.archive)
            .archive_sha256(package.archive_sha256)
            .archive_size(5)
            .archive_file_count(4)
            .archive_uncompressed_bytes(32)
            .executable(package.executable)
            .executable_sha256(hash_regular_file(&payload.join("bin/acme-agent")).unwrap())
            .payload_files(payload_manifest(&payload).unwrap())
            .args(package.args)
            .env(package.env)
            .assets(package.assets)
            .installed_at(installed_now())
            .trust(ManagedTrustReceipt {
                index_key_id: "managed-installer-test".into(),
                signed_payload_sha256: signed_payload_sha256(&signing_bytes),
            })
            .conformance(ManagedConformanceReceipt {
                verified_at: installed_now(),
                version: ManagedProbeOutcome::Passed,
                verified_version: "1.2.3".into(),
                model_config_id: "model".into(),
                model_ids: vec!["acme-1".into()],
                model_count: 1,
                default_model: "acme-1".into(),
                resume: ManagedProbeOutcome::NotAdvertised,
                load: ManagedProbeOutcome::NotAdvertised,
                close: ManagedProbeOutcome::Passed,
                prompt: ManagedProbeOutcome::Unprobed,
                os_sandbox_applied: false,
            })
            .signed_index(index)
            .build();
        (directory, receipt)
    }

    fn staged_receipt(storage: &ManagedStorage) -> (tempfile::TempDir, ManagedPackageReceipt) {
        let (directory, receipt) = uncommitted_receipt();
        commit_staged_revision(storage, &directory.path().join("revision"), &receipt).unwrap();
        (directory, receipt)
    }

    fn test_trust_store() -> ManagedTrustStore {
        let signing_key = SigningKey::from_bytes(&[23; 32]);
        ManagedTrustStore::new([TrustedIndexKey::new(
            "managed-installer-test",
            signing_key.verifying_key().to_bytes(),
        )
        .unwrap()])
    }

    #[test]
    fn concurrent_identical_revision_commits_converge() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let (first_staging, first_receipt) = uncommitted_receipt();
        let (second_staging, second_receipt) = uncommitted_receipt();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let first = {
            let storage = storage.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                commit_staged_revision(
                    &storage,
                    &first_staging.path().join("revision"),
                    &first_receipt,
                )
            })
        };
        let second = {
            let storage = storage.clone();
            std::thread::spawn(move || {
                barrier.wait();
                commit_staged_revision(
                    &storage,
                    &second_staging.path().join("revision"),
                    &second_receipt,
                )
            })
        };

        let first_payload = first.join().unwrap().unwrap();
        let second_payload = second.join().unwrap().unwrap();
        assert_eq!(first_payload, second_payload);
        assert_eq!(
            std::fs::read(first_payload.join("bin/acme-agent")).unwrap(),
            b"agent"
        );
    }

    #[test]
    fn existing_revision_accepts_an_unrelated_signed_catalog_update() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let (_staging, receipt) = staged_receipt(&storage);
        let mut refreshed = receipt.clone();
        let mut unrelated = refreshed.signed_index.signed.packages[0].clone();
        unrelated.agent.id = "z-other-agent".into();
        refreshed.signed_index.signed.packages.push(unrelated);
        let bytes = refreshed.signed_index.signed.signing_bytes().unwrap();
        refreshed.signed_index.signature.value = base64::engine::general_purpose::STANDARD
            .encode(SigningKey::from_bytes(&[23; 32]).sign(&bytes).to_bytes());
        refreshed.trust.signed_payload_sha256 = signed_payload_sha256(&bytes);
        verify_receipt_trust(&receipt, &test_trust_store()).unwrap();
        verify_receipt_trust(&refreshed, &test_trust_store()).unwrap();
        assert_ne!(
            receipt.trust.signed_payload_sha256,
            refreshed.trust.signed_payload_sha256
        );
        let revision = storage
            .revision_dir("acme-agent", &receipt.revision())
            .unwrap();
        verify_existing_revision(&revision, &refreshed).unwrap();
        // The previously signed receipt is retained, not replaced by the catalog refresh.
        assert_eq!(
            read_receipt(&revision.join("receipt.json"))
                .unwrap()
                .trust
                .signed_payload_sha256,
            receipt.trust.signed_payload_sha256
        );
    }

    #[test]
    fn existing_revision_rejects_changed_launch_metadata() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let (_staging, receipt) = staged_receipt(&storage);
        let revision = storage
            .revision_dir("acme-agent", &receipt.revision())
            .unwrap();
        let mut changed = receipt.clone();
        changed.args.push("--different-behavior".into());
        assert!(verify_existing_revision(&revision, &changed).is_err());
        let mut changed = receipt;
        changed.signed_index.signed.packages[0]
            .host
            .compatibility
            .max_app_version = Some("0.99.0".into());
        assert!(verify_existing_revision(&revision, &changed).is_err());
    }

    #[tokio::test]
    async fn committed_state_recovers_from_descriptor_projection_failure() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let (_staging, receipt) = staged_receipt(&storage);
        let descriptors = root.path().join("descriptors");
        std::fs::write(&descriptors, b"not a directory").unwrap();

        let state = activate_revision(
            &storage,
            &descriptors,
            &receipt,
            ManagedHistoryAction::Installed,
            true,
            None,
        )
        .await
        .unwrap();
        assert_eq!(state.active.unwrap().revision, receipt.revision());
        assert_eq!(
            read_state(&storage.state_path("acme-agent").unwrap(), "acme-agent")
                .unwrap()
                .active
                .unwrap()
                .revision,
            receipt.revision()
        );
        let quarantines = records(&storage, "acme-agent").unwrap();
        assert_eq!(quarantines.len(), 1);
        assert_eq!(
            quarantines[0].code,
            "MANAGED_DESCRIPTOR_RECONCILIATION_REQUIRED"
        );

        std::fs::remove_file(&descriptors).unwrap();
        std::fs::create_dir(&descriptors).unwrap();
        reconcile_descriptors(&storage, &descriptors);
        assert!(descriptors.join("acme-agent.json").is_file());
    }

    #[tokio::test]
    async fn damaged_payload_and_missing_receipt_can_still_be_disabled() {
        for remove_receipt in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let storage = ManagedStorage::new(root.path().join("managed"));
            let (_staging, receipt) = staged_receipt(&storage);
            let descriptors = root.path().join("descriptors");
            activate_revision(
                &storage,
                &descriptors,
                &receipt,
                ManagedHistoryAction::Installed,
                true,
                None,
            )
            .await
            .unwrap();
            let payload = storage
                .payload_dir("acme-agent", &receipt.revision())
                .unwrap();
            if remove_receipt {
                std::fs::remove_file(receipt_path(&payload).unwrap()).unwrap();
            } else {
                std::fs::write(payload.join(&receipt.executable), b"tampered").unwrap();
            }
            let active_state =
                read_state(&storage.state_path("acme-agent").unwrap(), "acme-agent").unwrap();
            assert!(
                verify_descriptor_projection(&storage, &descriptors, &active_state).is_err(),
                "registration readiness must reject damaged immutable payloads"
            );
            let disabled = set_enabled(&storage, &descriptors, "acme-agent", false)
                .await
                .unwrap();
            assert!(!disabled.active.unwrap().enabled);
            assert!(!descriptors.join("acme-agent.json").exists());
            assert!(
                !read_state(&storage.state_path("acme-agent").unwrap(), "acme-agent")
                    .unwrap()
                    .active
                    .unwrap()
                    .enabled
            );
        }
    }

    #[tokio::test]
    async fn inventory_reports_only_startup_ready_active_revisions() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let descriptors = root.path().join("descriptors");
        let (_staging, receipt) = staged_receipt(&storage);
        activate_revision(
            &storage,
            &descriptors,
            &receipt,
            ManagedHistoryAction::Installed,
            true,
            None,
        )
        .await
        .unwrap();
        let service = super::super::service::ManagedProviderService::builder()
            .client(reqwest::Client::new())
            .storage(storage.clone())
            .descriptors(descriptors)
            .trust_store(test_trust_store())
            .build();

        let pristine = service.inventory_entry("acme-agent").await.unwrap();
        assert!(pristine.enabled_after_restart);
        assert!(pristine.active_after_restart);

        let payload = storage
            .payload_dir("acme-agent", &receipt.revision())
            .unwrap();
        std::fs::write(payload.join(&receipt.executable), b"tampered").unwrap();
        let tampered = service.inventory_entry("acme-agent").await.unwrap();
        assert!(tampered.enabled_after_restart);
        assert!(!tampered.active_after_restart);
        assert_eq!(
            tampered.error_code.as_deref(),
            Some("MANAGED_PAYLOAD_TAMPERED")
        );
    }

    #[tokio::test]
    async fn activation_compare_and_swap_rejects_a_stale_admission() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let (_staging, receipt) = staged_receipt(&storage);
        let descriptors = root.path().join("descriptors");
        activate_revision(
            &storage,
            &descriptors,
            &receipt,
            ManagedHistoryAction::Installed,
            true,
            None,
        )
        .await
        .unwrap();

        let error = activate_revision(
            &storage,
            &descriptors,
            &receipt,
            ManagedHistoryAction::Updated,
            true,
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: "MANAGED_INSTALL_STATE_CHANGED",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn rollback_compare_and_swap_detects_an_enablement_race() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().join("managed"));
        let (_staging, receipt) = staged_receipt(&storage);
        let descriptors = root.path().join("descriptors");
        let installed = activate_revision(
            &storage,
            &descriptors,
            &receipt,
            ManagedHistoryAction::Installed,
            true,
            None,
        )
        .await
        .unwrap();
        let expected = installed.active.unwrap();
        set_enabled(&storage, &descriptors, "acme-agent", false)
            .await
            .unwrap();

        let error = rollback(
            &storage,
            &descriptors,
            "acme-agent",
            &receipt.revision(),
            &expected,
            &test_trust_store(),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: "MANAGED_INSTALL_STATE_CHANGED",
                ..
            }
        ));
        assert!(
            !read_state(&storage.state_path("acme-agent").unwrap(), "acme-agent")
                .unwrap()
                .active
                .unwrap()
                .enabled
        );
    }
}
