use serde_json::Value;

use crate::diagnostics::Diagnostics;
use crate::package::{
    identity, normalized_provider_id, reject_unknown, reserved_provider_ids, validate_package,
};

pub(crate) fn validate_submission(value: &Value, errors: &mut Diagnostics) {
    if errors.is_full() {
        return;
    }
    let Some(object) = value.as_object() else {
        errors.push("submission must be an object".into());
        return;
    };
    reject_unknown(
        object,
        &["schema_version", "package", "source", "changelog"],
        "submission",
        errors,
    );
    if value.get("schema_version") != Some(&Value::from(1)) {
        errors.push("submission.schema_version must equal 1".into());
    }
    let package = value.get("package").unwrap_or(&Value::Null);
    validate_package(package, "submission.package", errors);
    validate_marketplace_package(package, errors);
    validate_source(value.get("source"), package, errors);
    if !value
        .get("changelog")
        .and_then(Value::as_str)
        .is_some_and(|text| {
            !ecmascript_trim(text).is_empty() && utf16_len(text) <= 16_384 && !text.contains('\0')
        })
    {
        errors.push(
            "submission.changelog must be a non-empty string of at most 16384 characters".into(),
        );
    }
    let package_repository = package.pointer("/agent/repository").and_then(Value::as_str);
    let source_repository = value.pointer("/source/repository").and_then(Value::as_str);
    if package_repository.is_some()
        && source_repository.is_some()
        && package_repository != source_repository
    {
        errors.push(
            "submission.package.agent.repository must equal submission.source.repository".into(),
        );
    }
}

fn validate_marketplace_package(package: &Value, errors: &mut Diagnostics) {
    let Some(agent) = package.get("agent").and_then(Value::as_object) else {
        return;
    };
    if !agent.get("repository").is_some_and(Value::is_string) {
        errors.push("submission.package.agent.repository is required".into());
    }
    if agent
        .get("license")
        .and_then(Value::as_str)
        .is_none_or(|value| ecmascript_trim(value).is_empty())
    {
        errors.push("submission.package.agent.license must be a non-empty declared license".into());
    }
    if identity(package).is_some_and(|(id, _)| {
        reserved_provider_ids().contains(normalized_provider_id(id).as_str())
    }) {
        errors.push("submission.package.agent.id is reserved by a built-in provider".into());
    }
    if let Some(assets) = package.pointer("/host/assets").and_then(Value::as_object) {
        for key in ["readme", "license"] {
            if assets
                .get(key)
                .and_then(Value::as_str)
                .is_none_or(|value| ecmascript_trim(value).is_empty())
            {
                errors.push(format!("submission.package.host.assets.{key} is required"));
            }
        }
    }
    for runner in ["npx", "uvx"] {
        if package
            .pointer(&format!("/agent/distribution/{runner}"))
            .is_some()
        {
            errors.push(format!(
                "submission.package.agent.distribution.{runner} is not supported by marketplace v1"
            ));
        }
    }
}

fn validate_source(source: Option<&Value>, package: &Value, errors: &mut Diagnostics) {
    let Some(source) = source.and_then(Value::as_object) else {
        errors.push("submission.source must be an object".into());
        return;
    };
    reject_unknown(
        source,
        &["repository", "commit", "tag"],
        "submission.source",
        errors,
    );
    let repository = source.get("repository").and_then(Value::as_str);
    let tag = source.get("tag").and_then(Value::as_str);
    if !repository.is_some_and(canonical_github_repository) {
        errors.push(
            "submission.source.repository must be a canonical HTTPS GitHub owner/repository URL"
                .into(),
        );
    }
    if !source
        .get("commit")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            value.len() == 40
                && value
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
    {
        errors.push(
            "submission.source.commit must be a 40-character lowercase hexadecimal commit".into(),
        );
    }
    if !tag.is_some_and(valid_git_tag) {
        errors.push("submission.source.tag must be a safe non-empty git tag".into());
    }
    let (Some(repository), Some(tag)) = (
        repository.filter(|v| canonical_github_repository(v)),
        tag.filter(|v| valid_git_tag(v)),
    ) else {
        return;
    };
    if let Some(binary) = package
        .pointer("/agent/distribution/binary")
        .and_then(Value::as_object)
    {
        for (platform, target) in binary {
            if let Some(archive) = target.get("archive").and_then(Value::as_str) {
                validate_archive(
                    archive,
                    repository,
                    tag,
                    &format!("submission.package.agent.distribution.binary.{platform}"),
                    errors,
                );
            }
        }
    }
}

fn canonical_github_repository(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://github.com/") else {
        return false;
    };
    if value.ends_with(".git") {
        return false;
    }
    let parts = rest.split('/').collect::<Vec<_>>();
    parts.len() == 2
        && !parts[0].is_empty()
        && parts[0].len() <= 39
        && parts[0].starts_with(|character: char| character.is_ascii_alphanumeric())
        && parts[0]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !parts[1].is_empty()
        && parts[1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && canonical_https_github_url(value)
}

fn valid_git_tag(value: &str) -> bool {
    !value.is_empty()
        && utf16_len(value) <= 255
        && value != "@"
        && !value.starts_with(['-', '/'])
        && !value.ends_with(['/', '.'])
        && !value.contains("..")
        && !value.contains("@{")
        && !value
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f || b"~^:?*[\\".contains(&b))
        && value
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

fn validate_archive(
    value: &str,
    repository: &str,
    tag: &str,
    label: &str,
    errors: &mut Diagnostics,
) {
    let prefix = format!(
        "{repository}/releases/download/{}/",
        encode_uri_component(tag)
    );
    if !value.starts_with(&prefix) {
        errors.push(format!("{label}.archive must be an HTTPS GitHub Release asset for submission.source repository and tag"));
        return;
    }
    let asset = &value[prefix.len()..];
    if asset.is_empty() || asset.contains('/') || has_traversal(asset) {
        errors.push(format!(
            "{label}.archive must name one safe GitHub Release asset"
        ));
        return;
    }
    if !canonical_release_url(value) {
        errors.push(format!(
            "{label}.archive must be a canonical HTTPS GitHub Release URL"
        ));
    }
}

fn canonical_https_github_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.as_str() == value
}

fn canonical_release_url(value: &str) -> bool {
    canonical_https_github_url(value) && !has_control_characters(value)
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(is_ascii_control)
        || decode_uri_component(value).is_none_or(|decoded| decoded.chars().any(is_ascii_control))
}

fn has_traversal(value: &str) -> bool {
    decode_uri_component(value).is_none_or(|decoded| {
        matches!(decoded.as_str(), "." | "..") || decoded.contains(['/', '\\'])
    })
}

fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        decoded.push(hex_value(high)? * 16 + hex_value(low)?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    encoded
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_ascii_control(character: char) -> bool {
    matches!(character, '\0'..='\u{1f}' | '\u{7f}')
}

fn ecmascript_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_repository_matches_canonical_owner_and_url_rules() {
        assert!(canonical_github_repository("https://github.com/a-/repo"));
        assert!(!canonical_github_repository("https://github.com/-a/repo"));
        assert!(!canonical_github_repository(
            "https://github.com/a/repo.git"
        ));
        assert!(!canonical_github_repository("https://github.com/a/repo%2e"));
        assert!(!canonical_github_repository("https://github.com/a/repo/"));
    }

    #[test]
    fn git_tag_limit_counts_utf16_code_units() {
        assert!(valid_git_tag(&"é".repeat(255)));
        assert!(!valid_git_tag(&"😀".repeat(128)));
    }

    #[test]
    fn archive_uses_encoded_tag_and_rejects_decoded_traversal_and_controls() {
        let repository = "https://github.com/acme/provider";
        let tag = "release (one)";
        let prefix = "https://github.com/acme/provider/releases/download/release%20(one)/";
        let mut errors = Diagnostics::default();
        validate_archive(
            &format!("{prefix}provider.tgz"),
            repository,
            tag,
            "target",
            &mut errors,
        );
        assert!(errors.is_empty());

        for asset in ["%2e%2e", "dir%2Fprovider.tgz", "bad%00name", "%ff"] {
            errors = Diagnostics::default();
            validate_archive(
                &format!("{prefix}{asset}"),
                repository,
                tag,
                "target",
                &mut errors,
            );
            assert!(!errors.is_empty(), "accepted {asset}");
        }
    }

    #[test]
    fn changelog_limit_and_blank_check_follow_javascript_strings() {
        assert_eq!(utf16_len(&"😀".repeat(8_192)), 16_384);
        assert_eq!(ecmascript_trim("\u{feff}\t text \u{3000}"), "text");
        assert_eq!(ecmascript_trim("\u{0085}"), "\u{0085}");
    }
}
