use crate::PublisherError;

pub(super) const MAX_JSON_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

pub(super) fn configuration(repository: &str, token: &str) -> Result<(), PublisherError> {
    if !cadencr_registry_core::valid_publication_repository(repository) {
        return Err(error("GitHub repository is invalid"));
    }
    if token.is_empty() || token.bytes().any(|byte| matches!(byte, b'\r' | b'\n')) {
        return Err(error("GitHub token is invalid"));
    }
    Ok(())
}

pub(super) fn id(value: u64, label: &str) -> Result<(), PublisherError> {
    if value == 0 || value > 9_007_199_254_740_991 {
        return Err(error(format!("GitHub {label} is invalid")));
    }
    Ok(())
}

pub(super) fn text(value: &str, label: &str) -> Result<(), PublisherError> {
    if value.is_empty() || value.bytes().any(|byte| matches!(byte, b'\r' | b'\n')) {
        return Err(error(format!("GitHub {label} is invalid")));
    }
    Ok(())
}

pub(super) fn error(message: impl Into<String>) -> PublisherError {
    PublisherError::new(message)
}
