use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::diagnostics::Diagnostics;

pub(crate) fn reject_unknown(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
    errors: &mut Diagnostics,
) {
    for key in object.keys() {
        if errors.is_full() {
            break;
        }
        if !allowed.contains(&key.as_str()) {
            errors.push(format!("{label}.{key} is not allowed"));
        }
    }
}
pub(crate) fn object<'a>(
    value: &'a Value,
    label: &str,
    errors: &mut Diagnostics,
) -> Option<&'a Map<String, Value>> {
    value.as_object().or_else(|| {
        errors.push(format!("{label} must be an object"));
        None
    })
}
pub(crate) fn valid_identifier(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub(crate) fn valid_provider_id(value: &str) -> bool {
    // The portable ACP provider-id grammar belongs to plugin-core. Registry
    // publication applies additional policy (reserved ids, provenance, and
    // immutable ownership) separately rather than widening this primitive.
    cadencr_plugin_core::validate_provider_id(value).is_ok()
}
pub(crate) fn valid_semver(value: &str) -> bool {
    semver::Version::parse(value).is_ok()
}
pub(crate) fn valid_https(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
}
pub(crate) fn valid_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}
pub(crate) fn valid_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.contains(['\\', '\0'])
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}
pub(crate) fn credential_name(value: &str) -> bool {
    let text = value
        .bytes()
        .filter(|b| b.is_ascii_alphanumeric())
        .map(|b| b.to_ascii_lowercase())
        .map(char::from)
        .collect::<String>();
    const EXACT: &[&str] = &[
        "accesstoken",
        "apikey",
        "auth",
        "authentication",
        "authmethod",
        "authmethods",
        "authorization",
        "clientsecret",
        "credential",
        "credentials",
        "password",
        "passwd",
        "privatekey",
        "refreshtoken",
        "secret",
        "token",
    ];
    EXACT.contains(&text.as_str())
        || [
            "apikey",
            "credential",
            "password",
            "privatekey",
            "secret",
            "token",
        ]
        .iter()
        .any(|suffix| text == *suffix || text.ends_with(suffix))
}
pub(crate) fn normalized_provider_id(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}
pub(crate) fn identity(value: &Value) -> Option<(&str, &str)> {
    Some((
        value.pointer("/agent/id")?.as_str()?,
        value.pointer("/agent/version")?.as_str()?,
    ))
}
pub(crate) fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    match (semver::Version::parse(left), semver::Version::parse(right)) {
        (Ok(mut left), Ok(mut right)) => {
            left.build = semver::BuildMetadata::EMPTY;
            right.build = semver::BuildMetadata::EMPTY;
            left.cmp(&right)
        }
        _ => left.cmp(right),
    }
}
pub(crate) fn reserved_provider_ids() -> HashSet<&'static str> {
    [
        "anthropic",
        "claude",
        "claudecode",
        "codex",
        "codexcli",
        "cursor",
        "open",
        "openai",
        "opencode",
    ]
    .into_iter()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation_uses_parsed_absolute_urls() {
        assert!(valid_url("urn:example:provider"));
        assert!(valid_url("mailto:provider@example.com"));
        assert!(!valid_url("relative/path"));
        assert!(valid_https("https://example.com/archive.tgz"));
        assert!(!valid_https("https://[invalid/archive.tgz"));
        assert!(!valid_https("mailto:provider@example.com"));
    }

    #[test]
    fn credential_detection_includes_every_javascript_exact_name() {
        for name in [
            "accesstoken",
            "apikey",
            "auth",
            "authentication",
            "authmethod",
            "authmethods",
            "authorization",
            "clientsecret",
            "credential",
            "credentials",
            "password",
            "passwd",
            "privatekey",
            "refreshtoken",
            "secret",
            "token",
        ] {
            assert!(credential_name(name), "missed {name}");
        }
        assert!(credential_name("MY_CLIENT_SECRET"));
        assert!(!credential_name("author"));
    }
}
