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
    let archive = cadencr_registry_core::parse_github_release_archive_url(raw)
        .map_err(|error| invalid(error.to_string()))?;
    if archive.repository != format!("https://github.com/{repository}") {
        return Err(invalid("archive URL does not match package repository"));
    }
    Ok((archive.tag, archive.asset))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaced_author_tags_are_decoded_without_relaxing_origin_or_asset_policy() {
        let url = "https://github.com/merkr-software/CadencR/releases/download/plugins%2Fprovider-pi%2Fv0.4.0/provider-pi-0.4.0.tar.gz";
        assert_eq!(
            validate_archive_url(url, "merkr-software/CadencR").unwrap(),
            (
                "plugins/provider-pi/v0.4.0".into(),
                "provider-pi-0.4.0.tar.gz".into()
            )
        );
        assert!(validate_archive_url(url, "someone/else").is_err());
        for changed in [
            url.replace("%2F", "/"),
            url.replace("%2F", "%252F"),
            url.replace("provider-pi%2F", "..%2F"),
            url.replace("provider-pi-0.4.0.tar.gz", "nested%2Fpayload.tar.gz"),
            format!("{url}?token=hidden"),
        ] {
            assert!(validate_archive_url(&changed, "merkr-software/CadencR").is_err());
        }
    }
}
