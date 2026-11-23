//! Bring a managed provider's runtime descriptor in line with its state:
//! write the verified projection, or retire a descriptor Cadencr installed.

use std::path::{Path, PathBuf};

use super::{descriptor_path, verify_descriptor_projection, ManagedProviderState, ManagedStorage};
use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
use crate::error::AppError;
use crate::shared::atomic_file;

pub(super) enum DescriptorSync {
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

pub(super) fn prepare_descriptor_sync(
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
        .map_err(|error| AppError::internal(format!("serialize managed descriptor: {error}")))?;
    json.push('\n');
    Ok(DescriptorSync::Write {
        path: projection.path,
        json,
    })
}

pub(super) fn apply_descriptor_sync(projection: DescriptorSync) -> Result<(), AppError> {
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
            return Err(AppError::internal(format!(
                "read managed descriptor: {error}"
            )))
        }
    };
    let existing: ProviderDescriptor = serde_json::from_slice(&raw)
        .map_err(|error| AppError::internal(format!("parse managed descriptor: {error}")))?;
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
        .map_err(|error| AppError::internal(format!("retire managed descriptor: {error}")))
}
