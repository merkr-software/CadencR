use std::cmp::Ordering;
use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

use crate::diagnostics::Diagnostics;
use crate::error::RegistryError;
use crate::json::canonical_json;
use crate::package::{compare_versions, identity, validate_package};
use crate::tree::load_packages;

#[bon::builder]
pub fn build_index(
    packages_dir: &Path,
    generated_at: &str,
    expires_at: &str,
) -> Result<Vec<u8>, RegistryError> {
    let generated = parse_timestamp(generated_at);
    let expires = parse_timestamp(expires_at);
    let (Some(generated), Some(expires)) = (generated, expires) else {
        return Err(RegistryError::single(
            "generated_at and expires_at must be RFC 3339 UTC timestamps",
        ));
    };
    if expires <= generated {
        return Err(RegistryError::single(
            "index.expires_at must follow generated_at",
        ));
    }
    if generated > Utc::now() + Duration::minutes(5) {
        return Err(RegistryError::single(
            "index.generated_at is too far in the future",
        ));
    }
    if expires - generated > Duration::days(14) {
        return Err(RegistryError::single(
            "index validity window exceeds 14 days",
        ));
    }
    if Utc::now() >= expires {
        return Err(RegistryError::single("index has expired"));
    }
    let mut errors = Diagnostics::default();
    let mut packages = load_packages(packages_dir, &mut errors)
        .into_iter()
        .flat_map(|values| values.into_values())
        .collect::<Vec<_>>();
    for value in &packages {
        if errors.is_full() {
            break;
        }
        validate_package(value, "package", &mut errors);
    }
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    packages.sort_by(compare_packages);
    let unique = packages
        .iter()
        .filter_map(identity)
        .map(|(id, version)| format!("{id}\0{version}"))
        .collect::<std::collections::HashSet<_>>();
    if unique.len() != packages.len() {
        return Err(RegistryError::single(
            "index.packages contains duplicate id@version entries",
        ));
    }
    if packages.is_empty() {
        return Err(RegistryError::single(
            "index.packages must be a non-empty array",
        ));
    }
    let index = json!({"schema_version": 1, "generated_at": generated_at, "expires_at": expires_at, "packages": packages});
    Ok(canonical_json(&index).into_bytes())
}

fn compare_packages(left: &Value, right: &Value) -> Ordering {
    match (identity(left), identity(right)) {
        (Some((left_id, left_version)), Some((right_id, right_version))) => left_id
            .cmp(right_id)
            .then_with(|| compare_versions(left_version, right_version)),
        _ => Ordering::Equal,
    }
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    let bytes = value.as_bytes();
    let punctuation = |index, expected| bytes.get(index) == Some(&expected);
    if bytes.len() < 20
        || !punctuation(4, b'-')
        || !punctuation(7, b'-')
        || !punctuation(10, b'T')
        || !punctuation(13, b':')
        || !punctuation(16, b':')
        || bytes.last() != Some(&b'Z')
        || !bytes
            .iter()
            .take(19)
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
        || (bytes.len() > 20
            && (bytes[19] != b'.'
                || bytes[20..bytes.len() - 1].is_empty()
                || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit)))
    {
        return None;
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(id: &str, version: &str) -> Value {
        json!({
            "agent": {
                "id": id, "name": id, "version": version, "description": "test",
                "distribution": {"binary": {"linux-x86_64": {
                    "archive": "https://example.com/provider.tgz", "cmd": "bin/provider",
                    "sha256": "a".repeat(64)
                }}}
            },
            "host": {"publisher": "acme", "compatibility": {"min_app_version": "1.0.0"},
                "assets": {"icon": "icon.png"}}
        })
    }

    fn window() -> (String, String) {
        let generated = Utc::now() - Duration::minutes(1);
        let expires = generated + Duration::days(1);
        (
            generated.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            expires.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        )
    }

    fn write_package(directory: &Path, name: &str, value: &Value) {
        std::fs::write(directory.join(name), serde_json::to_vec(value).unwrap()).unwrap();
    }

    #[test]
    fn deterministic_bytes_sort_packages_and_object_keys() {
        let root = tempfile::tempdir().unwrap();
        write_package(root.path(), "z.json", &package("zeta", "1.0.0"));
        write_package(root.path(), "a.json", &package("alpha", "2.0.0"));
        let (generated, expires) = window();
        let first = build_index()
            .packages_dir(root.path())
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap();
        let second = build_index()
            .packages_dir(root.path())
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap();
        assert_eq!(first, second);
        let decoded: Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(decoded["packages"][0]["agent"]["id"], "alpha");
        assert!(String::from_utf8(first)
            .unwrap()
            .starts_with("{\"expires_at\":"));
    }

    #[test]
    fn rejects_duplicate_identity() {
        let root = tempfile::tempdir().unwrap();
        let value = package("alpha", "1.0.0");
        write_package(root.path(), "one.json", &value);
        write_package(root.path(), "two.json", &value);
        let (generated, expires) = window();
        let error = build_index()
            .packages_dir(root.path())
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap_err();
        assert!(error.to_string().contains("duplicate id@version"));
    }

    #[test]
    fn rejects_reversed_and_excessive_windows() {
        let root = tempfile::tempdir().unwrap();
        write_package(root.path(), "one.json", &package("alpha", "1.0.0"));
        let generated = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let reversed = (Utc::now() - Duration::days(1))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let error = build_index()
            .packages_dir(root.path())
            .generated_at(&generated)
            .expires_at(&reversed)
            .call()
            .unwrap_err();
        assert!(error.to_string().contains("must follow"));
        let excessive = (Utc::now() + Duration::days(15))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let error = build_index()
            .packages_dir(root.path())
            .generated_at(&generated)
            .expires_at(&excessive)
            .call()
            .unwrap_err();
        assert!(error.to_string().contains("exceeds 14 days"));
    }
}
