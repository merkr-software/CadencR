use super::conflict;
use crate::error::AppError;

pub(super) fn validate_sha(value: &str) -> Result<(), AppError> {
    if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(conflict(
            "PUBLICATION_REGISTRY_REMOTE_IDENTITY_MISMATCH",
            "registry commit identity is invalid",
        ));
    }
    Ok(())
}

pub(super) fn validate_login(value: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > 39
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_REMOTE_IDENTITY_MISMATCH",
            "GitHub account login is invalid",
        ));
    }
    Ok(())
}

pub(super) fn segment(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
