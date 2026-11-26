use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::domain::settings_store::file;
use crate::error::AppError;

use super::CodexProfile;

pub(super) fn read_config_and_revision(
    profile: &CodexProfile,
) -> Result<(Option<Value>, String), AppError> {
    let mut digest = Sha256::new();
    digest.update(profile.id.as_bytes());
    digest.update([0]);
    digest.update(profile.name.as_bytes());
    if let Some(path) = profile.config_path.as_deref() {
        digest.update(path.as_os_str().as_encoded_bytes());
    }
    let sorted_env = profile
        .env
        .iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    digest.update(
        serde_json::to_vec(&sorted_env).map_err(|error| AppError::internal(error.to_string()))?,
    );
    digest.update(
        serde_json::to_vec(&profile.env_unset)
            .map_err(|error| AppError::internal(error.to_string()))?,
    );
    let config = match profile.config_path.as_deref() {
        Some(path) => {
            let read_error = |error: std::io::Error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    AppError::BadRequest(format!("config file '{}' does not exist", path.display()))
                } else {
                    file::read_failed(path, error)
                }
            };
            let mut config = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(path)
                .map_err(read_error)?;
            let metadata = config.metadata().map_err(read_error)?;
            if !metadata.is_file() {
                return Err(file::read_failed(path, "not a regular file"));
            }
            let mut source = String::new();
            config.read_to_string(&mut source).map_err(read_error)?;
            let parsed = source.parse::<toml::Value>().map_err(|_| {
                AppError::BadRequest(format!("invalid TOML in Codex config '{}'", path.display()))
            })?;
            digest.update(source.as_bytes());
            Some(
                serde_json::to_value(parsed)
                    .map_err(|error| AppError::internal(error.to_string()))?,
            )
        }
        None => None,
    };
    let revision = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((config, revision))
}
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
