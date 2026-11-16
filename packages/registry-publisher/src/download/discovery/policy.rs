use crate::PublisherError;
use url::Url;

pub(super) fn validate_url(value: &str) -> Result<Url, PublisherError> {
    let parsed = Url::parse(value)
        .map_err(|_| PublisherError::new("archive download: invalid discovery URL"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("raw.githubusercontent.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(not_permitted());
    }
    let parts = parsed.path().split('/').collect::<Vec<_>>();
    if parts.len() != 7 || !parts[0].is_empty() || parts[3..=4] != ["refs", "heads"] {
        return Err(not_permitted());
    }
    let repository = format!("{}/{}", parts[1], parts[2]);
    // Only the catalog and the three revocation policies are discovery objects.
    let canonical = cadencr_registry_core::discovery_object_url(&repository, parts[5], parts[6])
        .map_err(|_| not_permitted())?;
    if canonical != value {
        return Err(PublisherError::new(
            "archive download: discovery URL is not canonical",
        ));
    }
    Ok(parsed)
}

fn not_permitted() -> PublisherError {
    PublisherError::new("archive download: discovery URL is not permitted")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_policy_is_exact() {
        let canonical =
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json";
        assert_eq!(validate_url(canonical).unwrap().as_str(), canonical);
        for file in [
            "managed-blocklist.json",
            "managed-theme-blocklist.json",
            "managed-tab-blocklist.json",
        ] {
            let policy = format!(
                "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/{file}"
            );
            assert_eq!(validate_url(&policy).unwrap().as_str(), policy);
        }
        for value in [
            "http://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json?token=x",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/a/b/managed-index.json",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/other.json",
            "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-blocklist.json/x",
            "https://github.com/acme/registry/releases/download/v1/provider.tgz",
        ] {
            assert!(validate_url(value).is_err(), "{value}");
        }
        assert!(super::super::super::validate_url(canonical, true).is_err());
    }
}
