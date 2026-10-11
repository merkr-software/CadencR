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
    #[builder(default = 1)] schema_version: u64,
    generated_at: &str,
    expires_at: &str,
) -> Result<Vec<u8>, RegistryError> {
    let metadata = json!({"generated_at": generated_at, "expires_at": expires_at});
    let mut errors = Diagnostics::default();
    validate_window(
        metadata.as_object().expect("JSON object"),
        Utc::now(),
        false,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    let mut errors = Diagnostics::default();
    let mut packages = load_packages(packages_dir, &mut errors)
        .into_iter()
        .flat_map(|values| values.into_values())
        .collect::<Vec<_>>();
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    // Only unsigned directory assembly adapts immutable legacy documents in memory.
    // Signed payload validation and authenticated upgrade policy never call this path.
    if schema_version == 2 {
        for package in &mut packages {
            if package.get("kind").is_none() {
                validate_package(package, "legacy provider package", &mut errors);
                if !errors.is_empty() {
                    return Err(RegistryError::from_messages(errors.into_messages()));
                }
                *package = json!({"kind": "provider", "package": package});
            }
        }
    }
    packages.sort_by(compare_packages);
    let index = json!({"schema_version": schema_version, "generated_at": generated_at, "expires_at": expires_at, "packages": packages});
    validate_index(&index, Utc::now(), false)?;
    Ok(canonical_json(&index).into_bytes())
}

pub(crate) fn validate_index(
    index: &Value,
    now: DateTime<Utc>,
    allow_expired: bool,
) -> Result<(), RegistryError> {
    let Some(object) = index.as_object() else {
        return Err(RegistryError::single("index must be an object"));
    };
    let mut errors = Diagnostics::default();
    crate::package::reject_unknown(
        object,
        &["schema_version", "generated_at", "expires_at", "packages"],
        "index",
        &mut errors,
    );
    let schema = object.get("schema_version").and_then(Value::as_u64);
    if !matches!(schema, Some(1 | 2)) {
        errors.push("index.schema_version must equal 1 or 2".into());
    }
    validate_window(object, now, allow_expired, &mut errors);
    let Some(packages) = object.get("packages").and_then(Value::as_array) else {
        errors.push("index.packages must be a non-empty array".into());
        return Err(RegistryError::from_messages(errors.into_messages()));
    };
    if packages.is_empty() {
        errors.push("index.packages must be a non-empty array".into());
    }
    for (position, package) in packages.iter().enumerate() {
        if errors.is_full() {
            break;
        }
        if schema == Some(2) {
            crate::marketplace::validate(
                package,
                &format!("index.packages[{position}]"),
                &mut errors,
            );
        } else {
            if package.get("kind").is_some() {
                errors.push("schema1 packages must be legacy provider packages".into());
            }
            validate_package(package, &format!("index.packages[{position}]"), &mut errors);
        }
    }
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    if schema == Some(2) {
        crate::catalog::validate_catalog_identities_with_label(packages, "repository")?;
    }
    let identities = packages.iter().filter_map(identity).collect::<Vec<_>>();
    if identities
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != identities.len()
    {
        errors.push("index.packages contains duplicate id@version entries".into());
    }
    if packages
        .windows(2)
        .any(|pair| compare_packages(&pair[0], &pair[1]).is_gt())
    {
        errors.push("index.packages must be sorted by provider id and semantic version".into());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(RegistryError::from_messages(errors.into_messages()))
    }
}

fn validate_window(
    object: &serde_json::Map<String, Value>,
    now: DateTime<Utc>,
    allow_expired: bool,
    errors: &mut Diagnostics,
) {
    let generated = object
        .get("generated_at")
        .and_then(Value::as_str)
        .and_then(parse_timestamp);
    let expires = object
        .get("expires_at")
        .and_then(Value::as_str)
        .and_then(parse_timestamp);
    if generated.is_none() {
        errors.push("index.generated_at must be an RFC 3339 timestamp".into());
    }
    if expires.is_none() {
        errors.push("index.expires_at must be an RFC 3339 timestamp".into());
    }
    let (Some(generated), Some(expires)) = (generated, expires) else {
        return;
    };
    if expires <= generated {
        errors.push("index.expires_at must follow generated_at".into());
    }
    if generated > now + Duration::minutes(5) {
        errors.push("index.generated_at is too far in the future".into());
    }
    if expires - generated > Duration::days(14) {
        errors.push("index validity window exceeds 14 days".into());
    }
    if !allow_expired && now >= expires {
        errors.push("index has expired".into());
    }
}

pub(crate) fn validate_fresh_window(
    generated_at: &str,
    expires_at: &str,
    now: DateTime<Utc>,
) -> Result<(), RegistryError> {
    let object = serde_json::Map::from_iter([
        ("generated_at".into(), Value::String(generated_at.into())),
        ("expires_at".into(), Value::String(expires_at.into())),
    ]);
    let mut errors = Diagnostics::default();
    validate_window(&object, now, false, &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(RegistryError::from_messages(errors.into_messages()))
    }
}

pub(crate) fn compare_packages(left: &Value, right: &Value) -> Ordering {
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
    fn mixed_directory_wraps_valid_legacy_providers_losslessly_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        let mut provider = package("alpha", "1.0.0");
        provider["agent"]["x-custom-extension"] = json!({"nested":[1,"kept"]});
        let theme = json!({"kind":"theme","package":{"theme":{"id":"midnight","name":"Midnight","description":"Dark theme","version":"1.0.0","repository":"https://github.com/acme/themes","license":"MIT","document_version":1,"distribution":{"archive":"https://github.com/acme/themes/releases/download/v1/theme.tar.gz","sha256":"a".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"}}}});
        write_package(root.path(), "legacy.json", &provider);
        write_package(root.path(), "theme.json", &theme);
        let original = std::fs::read(root.path().join("legacy.json")).unwrap();
        let generated =
            (Utc::now() - Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let expires =
            (Utc::now() + Duration::days(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let bytes = build_index()
            .packages_dir(root.path())
            .schema_version(2)
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap();
        let index: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            index["packages"][0],
            json!({"kind":"provider","package":provider})
        );
        assert_eq!(index["packages"][1], theme);
        assert_eq!(
            std::fs::read(root.path().join("legacy.json")).unwrap(),
            original
        );
        assert!(build_index()
            .packages_dir(root.path())
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .is_err());
        provider["host"]["publisher"] = Value::Null;
        write_package(root.path(), "legacy.json", &provider);
        assert!(build_index()
            .packages_dir(root.path())
            .schema_version(2)
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .is_err());
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
