use std::path::{Path, PathBuf};

use axum::http::StatusCode;

use super::super::receipt::ManagedRevision;
use crate::domain::agents::providers::installed::descriptor::validate_provider_id;
use crate::domain::settings_store;
use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct ManagedStorage {
    root: PathBuf,
}

impl ManagedStorage {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn production() -> Self {
        Self::new(settings_store::dir::sibling_dir("provider-installations"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn provider_dir(&self, provider_id: &str) -> Result<PathBuf, AppError> {
        validate_provider_id(provider_id).map_err(|error| {
            AppError::coded(StatusCode::BAD_REQUEST, error.code.as_str(), error.message)
        })?;
        Ok(self.root.join(provider_id))
    }

    pub fn state_path(&self, provider_id: &str) -> Result<PathBuf, AppError> {
        Ok(self.provider_dir(provider_id)?.join("state.json"))
    }

    pub fn revision_dir(
        &self,
        provider_id: &str,
        revision: &ManagedRevision,
    ) -> Result<PathBuf, AppError> {
        validate_revision(revision)?;
        Ok(self
            .provider_dir(provider_id)?
            .join(&revision.version)
            .join(&revision.digest))
    }

    pub fn payload_dir(
        &self,
        provider_id: &str,
        revision: &ManagedRevision,
    ) -> Result<PathBuf, AppError> {
        Ok(self.revision_dir(provider_id, revision)?.join("payload"))
    }

    pub fn create_staging_dir(&self) -> Result<PathBuf, AppError> {
        let root = self.root.join(".staging");
        create_secure_dir(&root)?;
        let staging = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&staging).map_err(|error| {
            AppError::Internal(format!("create managed staging directory: {error}"))
        })?;
        set_private_directory(&staging)?;
        Ok(staging)
    }

    pub fn blocklist_cache_path(&self) -> PathBuf {
        self.root.join("blocklist.json")
    }

    pub(crate) fn provider_ids(&self) -> Vec<String> {
        let mut ids = std::fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|id| !id.starts_with('.') && validate_provider_id(id).is_ok())
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }
}

fn validate_revision(revision: &ManagedRevision) -> Result<(), AppError> {
    semver::Version::parse(&revision.version).map_err(|error| {
        AppError::coded(
            StatusCode::BAD_REQUEST,
            "MANAGED_VERSION_INVALID",
            format!("managed provider version must be exact semantic version: {error}"),
        )
    })?;
    if revision.digest.len() != 64
        || !revision
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            "MANAGED_DIGEST_INVALID",
            "managed provider digest must be 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

pub(super) fn create_secure_dir(path: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(path)
        .map_err(|error| AppError::Internal(format!("create {}: {error}", path.display())))?;
    set_private_directory(path)
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| AppError::Internal(format!("chmod {}: {error}", path.display())))
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_paths_reject_traversal_and_non_digests() {
        let storage = ManagedStorage::new(PathBuf::from("/managed"));
        for revision in [
            ManagedRevision {
                version: "../x".into(),
                digest: "a".repeat(64),
            },
            ManagedRevision {
                version: "1.0.0".into(),
                digest: "nope".into(),
            },
        ] {
            assert!(storage.revision_dir("acme-agent", &revision).is_err());
        }
        assert!(storage
            .revision_dir(
                "../escape",
                &ManagedRevision {
                    version: "1.0.0".into(),
                    digest: "a".repeat(64),
                },
            )
            .is_err());
    }
}
