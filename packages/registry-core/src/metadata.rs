//! Read-only local diagnostics. These never establish signature trust or publication authority.
use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::{safe_io::read_bounded_regular, RegistryError};

fn read(path: &Path, limit: u64) -> Result<Value, RegistryError> {
    let bytes = read_bounded_regular(path, limit)
        .map_err(|error| RegistryError::single(format!("{}: {error}", path.display())))?;
    crate::parse_json_bytes(&bytes).map_err(|error| RegistryError::single(error.to_string()))
}

/// Validate supported package/catalog shapes; signed envelopes are NOT authenticated.
pub fn validate_metadata_file(path: &Path) -> Result<(), RegistryError> {
    let value = read(path, crate::MAX_CATALOG_BYTES as u64)?;
    if value.get("signed").is_some() || value.get("signature").is_some() {
        crate::signing::validate_envelope_shape(&value)
    } else if value.get("schema_version").is_some() {
        crate::index::validate_index(&value, Utc::now(), false)
    } else {
        let mut errors = crate::diagnostics::Diagnostics::default();
        crate::package::validate_package(&value, "package", &mut errors);
        if errors.is_empty() {
            Ok(())
        } else {
            Err(RegistryError::from_messages(errors.into_messages()))
        }
    }
}

pub fn validate_submission_file(path: &Path) -> Result<(), RegistryError> {
    crate::validate_submission(&read(path, 1024 * 1024)?)
}

/// Scheduling only: intentionally does not authenticate signatures or validate catalog contents.
#[bon::builder]
pub fn check_metadata_expiry(
    path: &Path,
    #[builder(default = Utc::now())] now: DateTime<Utc>,
    #[builder(default = 72)] warning_hours: u16,
) -> Result<Value, RegistryError> {
    if !(1..=336).contains(&warning_hours) {
        return Err(RegistryError::single(
            "warning hours must be between 1 and 336",
        ));
    }
    let value = read(path, crate::MAX_CATALOG_BYTES as u64)?;
    let payload = value.get("signed").filter(|v| v.is_object());
    if payload.is_none() || !value.get("signature").is_some_and(Value::is_object) {
        return Err(RegistryError::single(
            "metadata requires signed and signature objects",
        ));
    }
    let payload = payload.expect("checked payload");
    let generated = timestamp(&payload["generated_at"])?;
    let expires = timestamp(&payload["expires_at"])?;
    if expires <= generated || generated > now {
        return Err(RegistryError::single("invalid metadata validity interval"));
    }
    let remaining_hours = (expires - now).num_milliseconds() as f64 / 3_600_000.0;
    let status = if remaining_hours <= 0.0 {
        "expired"
    } else if remaining_hours <= f64::from(warning_hours) {
        "renewal-due"
    } else {
        "healthy"
    };
    Ok(json!({"file":path, "expires_at":payload["expires_at"],
        "remaining_hours":remaining_hours,"status":status,"authenticated":false}))
}

fn timestamp(value: &Value) -> Result<DateTime<Utc>, RegistryError> {
    let parsed = value.as_str().and_then(|text| {
        DateTime::parse_from_rfc3339(text).ok().filter(|time| {
            time.timestamp_subsec_nanos() < 1_000_000_000
                && time.format("%Y-%m-%dT%H:%M:%SZ").to_string() == text
        })
    });
    parsed
        .map(|time| time.with_timezone(&Utc))
        .ok_or_else(|| RegistryError::single("non-canonical UTC timestamp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(value: Value) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metadata.json");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        (dir, path)
    }

    #[test]
    fn reports_untrusted_expiry_at_exact_boundaries() {
        let (_dir, path) = snapshot(json!({})); // invalid input is fail-closed
        assert!(check_metadata_expiry().path(&path).call().is_err());
        let (_dir, path) = snapshot(json!({"signed":{
            "generated_at":"2026-01-01T00:00:00Z","expires_at":"2026-01-05T00:00:00Z"
        },"signature":{}}));
        for (now, expected) in [
            ("2026-01-01T00:00:00Z", "healthy"),
            ("2026-01-02T00:00:00Z", "renewal-due"),
            ("2026-01-05T00:00:00Z", "expired"),
        ] {
            let result = check_metadata_expiry()
                .path(&path)
                .now(now.parse().unwrap())
                .call()
                .unwrap();
            assert_eq!(result["status"], expected);
            assert_eq!(result["authenticated"], false);
        }
    }

    #[test]
    fn rejects_invalid_clock_window_shape_and_dates() {
        for generated in [
            "2026-02-30T00:00:00Z",
            "2026-01-01T00:00:00+00:00",
            "2027-01-01T00:00:00Z",
        ] {
            let (_dir, path) = snapshot(json!({"signed":{
                "generated_at":generated,"expires_at":"2026-01-05T00:00:00Z"
            },"signature":{}}));
            assert!(check_metadata_expiry()
                .path(&path)
                .now("2026-01-02T00:00:00Z".parse().unwrap())
                .call()
                .is_err());
            assert!(check_metadata_expiry()
                .path(&path)
                .warning_hours(0)
                .call()
                .is_err());
        }
        let (_dir, path) = snapshot(json!({"signed":[],"signature":{}}));
        assert!(check_metadata_expiry().path(&path).call().is_err());
    }

    #[test]
    fn submission_and_metadata_reuse_strict_validators() {
        let (_dir, path) = snapshot(json!({"kind":"theme","package":{}}));
        assert!(validate_metadata_file(&path).is_err());
        assert!(validate_submission_file(&path).is_err());
        let (_dir, path) = snapshot(json!({"signed":{},"signature":{}}));
        assert!(validate_metadata_file(&path).is_err());
    }

    #[test]
    fn metadata_dispatches_each_kind_once_and_rejects_nested_envelopes() {
        let provider = json!({"agent":{"id":"example-provider","name":"Example Provider",
            "version":"0.1.0","description":"Provider","license":"MIT",
            "repository":"https://github.com/acme/provider","distribution":{"binary":{
                "darwin-aarch64":{"archive":"https://github.com/acme/provider/releases/download/v1/provider.tgz",
                "cmd":"bin/provider","sha256":"a".repeat(64)}}}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.12.0"},
            "assets":{"icon":"assets/icon.svg","readme":"README.md","license":"LICENSE"}}});
        let theme = json!({"kind":"theme","package":{"theme":{"id":"midnight",
            "name":"Midnight","description":"Dark theme","version":"1.0.0",
            "repository":"https://github.com/acme/themes","license":"MIT","document_version":1,
            "distribution":{"archive":"https://github.com/acme/themes/releases/download/v1/theme.tar.gz",
            "sha256":"a".repeat(64)}},"host":{"publisher":"acme",
            "compatibility":{"min_app_version":"1.0.0"}}}});
        let mut tab = theme.clone();
        tab["kind"] = json!("tab");
        let mut descriptor = tab["package"]
            .as_object_mut()
            .unwrap()
            .remove("theme")
            .unwrap();
        descriptor
            .as_object_mut()
            .unwrap()
            .remove("document_version");
        descriptor["api_version"] = json!(1);
        tab["package"]["tab"] = descriptor;
        for value in [
            provider.clone(),
            json!({"kind":"provider","package":provider}),
            theme,
            tab,
        ] {
            let (_dir, path) = snapshot(value.clone());
            validate_metadata_file(&path).unwrap();
            if value.get("kind").is_some() {
                let (_dir, path) = snapshot(json!({"kind":"provider","package":value}));
                assert!(validate_metadata_file(&path).is_err());
            }
        }
    }

    #[test]
    fn refuses_oversized_metadata_and_submissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.json");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(crate::MAX_CATALOG_BYTES as u64 + 1).unwrap();
        assert!(check_metadata_expiry().path(&path).call().is_err());
        assert!(validate_metadata_file(&path).is_err());
        assert!(validate_submission_file(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_snapshots() {
        let (dir, path) = snapshot(json!({}));
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(path, &link).unwrap();
        assert!(check_metadata_expiry().path(&link).call().is_err());
    }
}
