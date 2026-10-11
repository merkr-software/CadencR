use super::invalid;
use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::error::AppError;

pub(super) fn single_target(
    package: &ManagedProviderPackage,
) -> Result<
    (
        String,
        &crate::domain::agents::providers::installed::descriptor::AcpBinaryTarget,
    ),
    AppError,
> {
    let binary = package
        .agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.binary.as_ref())
        .ok_or_else(|| invalid("package must declare a binary distribution"))?;
    if binary.len() != 1 {
        return Err(invalid("package must declare exactly one binary target"));
    }
    binary
        .iter()
        .next()
        .map(|(target, artifact)| (target.clone(), artifact))
        .ok_or_else(|| invalid("package binary target is missing"))
}

pub(crate) fn parse_repository(raw: Option<&str>) -> Result<String, AppError> {
    let raw = raw.ok_or_else(|| invalid("package repository is required"))?;
    validate_text("repository", raw)?;
    let url = reqwest::Url::parse(raw).map_err(|_| invalid("repository must be a URL"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "repository must be an exact public github.com HTTPS URL",
        ));
    }
    let path = url.path().trim_matches('/');
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|value| invalid_segment(value))
        || raw != format!("https://github.com/{}/{}", parts[0], parts[1])
        || raw.contains('%')
    {
        return Err(invalid(
            "repository must identify one GitHub owner/repository",
        ));
    }
    Ok(format!("{}/{}", parts[0], parts[1]))
}

pub(crate) fn validate_archive_url(
    raw: &str,
    repository: &str,
) -> Result<(String, String), AppError> {
    validate_text("archive URL", raw)?;
    let url = reqwest::Url::parse(raw).map_err(|_| invalid("archive URL is invalid"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw.to_ascii_lowercase().contains("%2f")
    {
        return Err(invalid(
            "archive URL must be an exact public github.com release URL",
        ));
    }
    let prefix = format!("/{repository}/releases/download/");
    let remainder = url
        .path()
        .strip_prefix(&prefix)
        .ok_or_else(|| invalid("archive URL does not match package repository"))?;
    let (tag, name) = remainder
        .split_once('/')
        .filter(|(tag, name)| !tag.is_empty() && !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| invalid("archive URL must contain exactly one tag and asset name"))?;
    let lower = name.to_ascii_lowercase();
    if name.len() > 128
        || name.eq_ignore_ascii_case("package.json")
        || (!lower.ends_with(".tar.gz") && !lower.ends_with(".tgz"))
        || invalid_segment(name)
        || invalid_segment(tag)
    {
        return Err(invalid("release asset name or tag is invalid"));
    }
    Ok((tag.to_string(), name.to_string()))
}

fn validate_text(label: &str, value: &str) -> Result<(), AppError> {
    if value.chars().any(char::is_control) {
        return Err(invalid(format!("{label} contains control characters")));
    }
    Ok(())
}

fn invalid_segment(value: &str) -> bool {
    value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
