use super::Error as AppError;

pub(super) fn validate_repository(value: &str) -> Result<(), AppError> {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return Err(AppError::BadRequest(
            "GitHub repository must be owner/repository".into(),
        ));
    }
    validate_segment(owner, "repository owner")?;
    validate_segment(repo, "repository name")
}

pub(super) fn validate_segment(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(AppError::BadRequest(format!("invalid {label}")));
    }
    Ok(())
}

pub(super) fn validate_tag(tag: &str) -> Result<(), AppError> {
    if tag.len() > 255
        || tag.starts_with("refs/")
        || tag.split('/').any(|part| {
            validate_segment(part, "release tag").is_err()
                || part.starts_with('.')
                || part.ends_with('.')
                || part.ends_with(".lock")
                || part.contains("..")
        })
    {
        return Err(AppError::BadRequest("invalid release tag".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaced_tags_are_distinct_from_asset_names_and_unsafe_refs_are_rejected() {
        let tag = "plugins/theme-graphite/v0.1.0";
        assert!(validate_tag(tag).is_ok());
        assert!(validate_segment(tag, "asset").is_err());
        assert!(validate_tag("v1.0.0").is_ok());
        for tag in [
            "",
            "/v1",
            "v1/",
            "plugins//v1",
            "refs/tags/v1",
            "../v1",
            "a..b",
            ".hidden/v1",
            "a.lock/v1",
            "a./v1",
            "a/@{x}",
            "a/%2Fv1",
            "a%252Fv1",
            "a/\\v1",
            "a/v1?query",
            "a/v1#fragment",
            "a/v1:bad",
            "a/v1\n",
            "a/v1 ",
        ] {
            assert!(validate_tag(tag).is_err(), "accepted {tag:?}");
        }
    }
}
