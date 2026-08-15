//! Descriptor lifecycle operations with explicit restart semantics.
//!
//! Mutations update the durable descriptor files only. The process-wide
//! provider registry intentionally remains immutable, so active sessions and
//! adapter handles cannot change underneath a running turn. Every response
//! reports both the current and next-boot activation state.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::http::StatusCode;

use crate::domain::agents::providers::installed::descriptor::{
    validate_provider_id, ProviderDescriptor,
};
use crate::domain::agents::providers::installed::installation::HostInstallation;
use crate::domain::agents::providers::installed::rejection::{DescriptorError, RejectionCode};
use crate::error::AppError;
use crate::shared::{atomic_file, trash};

use super::super::registry::{builtin_provider_identifiers, provider_identifier_key};
use super::{load_descriptors, loader::parse_descriptor};

pub const PROVIDER_ALREADY_INSTALLED: &str = "PROVIDER_ALREADY_INSTALLED";
pub const PROVIDER_NOT_INSTALLED: &str = "PROVIDER_NOT_INSTALLED";

pub fn descriptor_path(directory: &Path, provider_id: &str) -> Result<PathBuf, AppError> {
    validate_provider_id(provider_id).map_err(descriptor_error)?;
    Ok(directory.join(format!("{provider_id}.json")))
}

pub async fn install_descriptor(
    directory: &Path,
    descriptor: ProviderDescriptor,
    active_provider_ids: &[String],
) -> Result<(), AppError> {
    let _guard = lifecycle_lock().lock().await;
    descriptor.validate().map_err(descriptor_error)?;
    let provider_id = descriptor.agent.id.as_str();
    let path = descriptor_path(directory, provider_id)?;
    ensure_descriptor_id_available(directory, provider_id, active_provider_ids)?;
    HostInstallation::from_descriptor(descriptor.clone(), &path).map_err(descriptor_error)?;
    write_descriptor(&path, &descriptor)
}

/// Refuse a reserved or already-claimed identity before a multi-resource
/// developer workflow creates a project. Installation checks again while
/// holding its lifecycle lock, so this is an early validation seam rather than
/// a replacement for the authoritative write-time check.
pub fn ensure_descriptor_id_available(
    directory: &Path,
    provider_id: &str,
    active_provider_ids: &[String],
) -> Result<(), AppError> {
    let path = descriptor_path(directory, provider_id)?;
    ensure_id_available(directory, provider_id, &path, active_provider_ids)
}

pub async fn set_descriptor_enabled(
    directory: &Path,
    provider_id: &str,
    enabled: bool,
) -> Result<bool, AppError> {
    let _guard = lifecycle_lock().lock().await;
    let path = descriptor_path(directory, provider_id)?;
    let mut descriptor = read_descriptor(&path, provider_id)?;
    if enabled {
        ensure_descriptor_activatable(directory, &path, provider_id)?;
    }
    if descriptor.installation.enabled == enabled {
        return Ok(false);
    }
    descriptor.installation.enabled = enabled;
    descriptor.validate().map_err(descriptor_error)?;
    HostInstallation::from_descriptor(descriptor.clone(), &path).map_err(descriptor_error)?;
    write_descriptor(&path, &descriptor)?;
    Ok(true)
}

pub async fn remove_descriptor(directory: &Path, provider_id: &str) -> Result<(), AppError> {
    let _guard = lifecycle_lock().lock().await;
    let path = descriptor_path(directory, provider_id)?;
    // Parse and validate before moving anything. A malformed file remains
    // inspectable through diagnostics instead of being removable through a
    // provider id it did not validly claim.
    read_descriptor(&path, provider_id)?;
    trash::move_to_trash(&path).await
}

fn lifecycle_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn ensure_id_available(
    directory: &Path,
    provider_id: &str,
    path: &Path,
    active_provider_ids: &[String],
) -> Result<(), AppError> {
    let provider_key = provider_identifier_key(provider_id);
    let builtin_identifiers = builtin_provider_identifiers();
    if path.exists()
        || builtin_identifiers
            .iter()
            .any(|reserved| provider_identifier_key(reserved) == provider_key)
        || active_provider_ids
            .iter()
            .any(|active| provider_identifier_key(active) == provider_key)
    {
        return Err(already_installed(provider_id));
    }
    let outcome = load_descriptors(directory);
    let claimed =
        outcome.installations.iter().any(|installation| {
            provider_identifier_key(installation.provider_id()) == provider_key
        }) || outcome
            .rejections
            .iter()
            .filter_map(|rejection| rejection.provider_id.as_deref())
            .any(|rejected| provider_identifier_key(rejected) == provider_key);
    if claimed {
        return Err(already_installed(provider_id));
    }
    Ok(())
}

fn ensure_descriptor_activatable(
    directory: &Path,
    path: &Path,
    provider_id: &str,
) -> Result<(), AppError> {
    let outcome = load_descriptors(directory);
    if outcome.installations.iter().any(|installation| {
        installation.source_path() == path && installation.provider_id() == provider_id
    }) {
        return Ok(());
    }
    if let Some(rejection) = outcome
        .rejections
        .iter()
        .find(|rejection| rejection.source_path == path)
    {
        let status = if rejection.code == RejectionCode::DuplicateProviderId {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        return Err(AppError::coded(
            status,
            rejection.code.as_str(),
            rejection.message.clone(),
        ));
    }
    Err(AppError::coded(
        StatusCode::BAD_REQUEST,
        RejectionCode::DescriptorUnreadable.as_str(),
        format!("could not verify whether provider {provider_id:?} can be activated"),
    ))
}

fn read_descriptor(path: &Path, provider_id: &str) -> Result<ProviderDescriptor, AppError> {
    let raw = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => AppError::coded(
            StatusCode::NOT_FOUND,
            PROVIDER_NOT_INSTALLED,
            format!("provider {provider_id:?} is not installed"),
        ),
        _ => AppError::coded(
            StatusCode::BAD_REQUEST,
            RejectionCode::DescriptorUnreadable.as_str(),
            format!("could not read descriptor for {provider_id:?}: {error}"),
        ),
    })?;
    parse_descriptor(path, &raw)
        .map(|loaded| loaded.descriptor)
        .map_err(|rejection| {
            AppError::coded(
                StatusCode::BAD_REQUEST,
                rejection.code.as_str(),
                rejection.message,
            )
        })
}

fn write_descriptor(path: &Path, descriptor: &ProviderDescriptor) -> Result<(), AppError> {
    let mut json = serde_json::to_string_pretty(descriptor)
        .map_err(|error| AppError::Internal(format!("failed to serialize descriptor: {error}")))?;
    json.push('\n');
    atomic_file::write_atomic_private(path, &json)
}

fn descriptor_error(error: DescriptorError) -> AppError {
    AppError::coded(StatusCode::BAD_REQUEST, error.code.as_str(), error.message)
}

fn already_installed(provider_id: &str) -> AppError {
    AppError::coded(
        StatusCode::CONFLICT,
        PROVIDER_ALREADY_INSTALLED,
        format!("provider {provider_id:?} is already installed or reserved"),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        install_descriptor, remove_descriptor, set_descriptor_enabled, PROVIDER_ALREADY_INSTALLED,
        PROVIDER_NOT_INSTALLED,
    };
    use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
    use crate::error::AppError;
    use serde_json::json;

    fn descriptor(id: &str, command: &str) -> ProviderDescriptor {
        serde_json::from_value(json!({
            "schema_version": 1,
            "agent": {
                "id": id,
                "name": "Acme Agent",
                "version": "1.0.0",
                "description": "An ACP agent"
            },
            "installation": { "executable": { "command": command } }
        }))
        .unwrap()
    }

    fn coded(error: AppError) -> (&'static str, String) {
        let AppError::Coded { code, message, .. } = error else {
            panic!("expected coded error")
        };
        (code, message)
    }

    #[tokio::test]
    async fn installs_and_toggles_a_descriptor_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("agent");
        std::fs::write(&binary, "agent").unwrap();
        let descriptor = descriptor("acme-agent", binary.to_str().unwrap());

        install_descriptor(dir.path(), descriptor, &[])
            .await
            .unwrap();
        let path = dir.path().join("acme-agent.json");
        assert!(path.exists());
        assert!(set_descriptor_enabled(dir.path(), "acme-agent", false)
            .await
            .unwrap());
        assert!(!set_descriptor_enabled(dir.path(), "acme-agent", false)
            .await
            .unwrap());
        let saved: ProviderDescriptor =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(!saved.installation.enabled);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("acme-agent.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn rejects_reserved_and_duplicate_ids() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("agent");
        let command = executable.to_str().unwrap();
        for reserved in ["cursor", "claude", "openai"] {
            let mut candidate = descriptor(reserved, command);
            if reserved == "openai" {
                candidate.installation.enabled = false;
            }
            let error = install_descriptor(dir.path(), candidate, &[])
                .await
                .unwrap_err();
            assert_eq!(coded(error).0, PROVIDER_ALREADY_INSTALLED, "{reserved}");
        }

        install_descriptor(dir.path(), descriptor("acme-agent", command), &[])
            .await
            .unwrap();
        let error = install_descriptor(dir.path(), descriptor("acme-agent", command), &[])
            .await
            .unwrap_err();
        assert_eq!(coded(error).0, PROVIDER_ALREADY_INSTALLED);
    }

    #[tokio::test]
    async fn enabling_a_loader_rejected_descriptor_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut candidate = descriptor("claude", dir.path().join("agent").to_str().unwrap());
        candidate.installation.enabled = false;
        let path = dir.path().join("claude.json");
        std::fs::write(&path, serde_json::to_string_pretty(&candidate).unwrap()).unwrap();

        let error = set_descriptor_enabled(dir.path(), "claude", true)
            .await
            .unwrap_err();
        assert_eq!(coded(error).0, "DUPLICATE_PROVIDER_ID");
        let saved: ProviderDescriptor =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(!saved.installation.enabled);
    }

    #[tokio::test]
    async fn invalid_path_ids_never_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let error = set_descriptor_enabled(dir.path(), "../escape", true)
            .await
            .unwrap_err();
        assert_eq!(coded(error).0, "DESCRIPTOR_SCHEMA_VIOLATION");
        assert!(!dir.path().parent().unwrap().join("escape.json").exists());
    }

    #[tokio::test]
    async fn active_runtime_ids_stay_reserved_after_their_file_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("agent");
        let active_ids = vec!["acme-agent".to_string()];
        let error = install_descriptor(
            dir.path(),
            descriptor("acme-agent", command.to_str().unwrap()),
            &active_ids,
        )
        .await
        .unwrap_err();
        assert_eq!(coded(error).0, PROVIDER_ALREADY_INSTALLED);
        assert!(!dir.path().join("acme-agent.json").exists());
    }

    #[tokio::test]
    async fn removal_is_recoverable_in_production_and_missing_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let command = dir.path().join("agent");
        install_descriptor(
            dir.path(),
            descriptor("acme-agent", command.to_str().unwrap()),
            &[],
        )
        .await
        .unwrap();
        remove_descriptor(dir.path(), "acme-agent").await.unwrap();
        assert!(!dir.path().join("acme-agent.json").exists());
        let error = remove_descriptor(dir.path(), "acme-agent")
            .await
            .unwrap_err();
        assert_eq!(coded(error).0, PROVIDER_NOT_INSTALLED);
    }
}
