//! Renewal of a signed revocation policy: the same entries, a new window,
//! a fresh signature. Nothing here can add, drop or edit an entry.
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use crate::blocklist::timestamp;
use crate::policy::{authenticate_policy, AuthenticatedPolicy};
use crate::safe_io::KEY_LIMIT;
use crate::signing::{parse_public_key, read_file, sign_canonical_payload};
use crate::{canonical_json_bytes, validate_signing_key_id, PolicyKind, RegistryError};

/// Inputs for [`renew_policy`]. Nothing is read from the environment.
#[derive(bon::Builder)]
pub struct RenewPolicyRequest<'a> {
    pub kind: PolicyKind,
    /// The signed policy to renew; authenticated with `public_key`.
    pub current: &'a Path,
    pub public_key: &'a Path,
    pub key_id: &'a str,
    pub private_key: &'a Path,
    /// Canonical UTC whole-second RFC 3339 expiry of the renewed policy.
    pub expires_at: &'a str,
}

/// Renew `request.current` and return the signed bytes, verified again
/// against the pinned public key.
pub fn renew_policy(request: RenewPolicyRequest<'_>) -> Result<Vec<u8>, RegistryError> {
    renew_policy_at(&request, Utc::now())
}

pub(crate) fn renew_policy_at(
    request: &RenewPolicyRequest<'_>,
    now: DateTime<Utc>,
) -> Result<Vec<u8>, RegistryError> {
    let kind = request.kind;
    validate_signing_key_id(request.key_id)?;
    let current_bytes = read_file(
        request.current,
        kind.max_signed_bytes() as u64,
        "current policy",
    )?;
    let public_pem = read_file(request.public_key, KEY_LIMIT, "public key")?;
    // Authentic but expired is renewable: the baseline only has to be ours.
    let current =
        authenticate_policy(kind, &current_bytes, &public_pem, request.key_id, true, now)?;
    let generated_at = whole_seconds(now)?;
    let expires_at = timestamp(request.expires_at, "new expiry")?;
    if generated_at <= current.generated_at() {
        return Err(RegistryError::single(
            "current policy was not generated before now; refusing to renew",
        ));
    }
    if expires_at <= current.expires_at() {
        return Err(RegistryError::single(
            "new expiry must be later than the current policy's expiry",
        ));
    }
    let mut signed = current.signed().clone();
    signed["generated_at"] = Value::String(format(generated_at));
    signed["expires_at"] = Value::String(format(expires_at));
    // Window length, future dating and expiry are judged by the domain rules.
    let prepared = kind.prepare(&signed, false, now)?;
    let pinned = parse_public_key(&public_pem)?;
    let bytes = sign_canonical_payload(
        prepared.canonical_payload(),
        request.private_key,
        request.key_id,
        Some(&pinned),
    )?;
    let renewed = authenticate_policy(kind, &bytes, &public_pem, request.key_id, false, now)?;
    require_only_window_changed(&current, &renewed)?;
    Ok(bytes)
}

/// The signed output differs from the baseline in its window and nothing
/// else.
fn require_only_window_changed(
    current: &AuthenticatedPolicy,
    renewed: &AuthenticatedPolicy,
) -> Result<(), RegistryError> {
    let strip = |policy: &AuthenticatedPolicy| {
        let mut signed = policy.signed().clone();
        signed["generated_at"] = Value::Null;
        signed["expires_at"] = Value::Null;
        canonical_json_bytes(&signed)
    };
    if strip(current) != strip(renewed)
        || renewed.generated_at() <= current.generated_at()
        || renewed.expires_at() <= current.expires_at()
    {
        return Err(RegistryError::single(
            "renewed policy differs from the current policy beyond its window",
        ));
    }
    Ok(())
}

fn whole_seconds(now: DateTime<Utc>) -> Result<DateTime<Utc>, RegistryError> {
    DateTime::from_timestamp(now.timestamp(), 0)
        .ok_or_else(|| RegistryError::single("clock is outside the supported range"))
}

fn format(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_keys::{write, Keys};
    use serde_json::json;
    use tempfile::TempDir;

    const KEY_ID: &str = "release-2026";

    fn keys(directory: &TempDir, name: &str, other: bool) -> Keys {
        write(directory.path(), name, other)
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-11T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn payload(kind: PolicyKind, generated: &str, expires: &str) -> Value {
        let (id_field, extra) = match kind {
            PolicyKind::Provider => ("provider_id", None),
            PolicyKind::Theme => ("theme_id", Some("theme-blocklist")),
            PolicyKind::Tab => ("tab_id", Some("tab-blocklist")),
            PolicyKind::Lsp => ("lsp_id", Some("lsp-blocklist")),
        };
        let mut value = json!({
            "schema_version": 1, "generated_at": generated, "expires_at": expires,
            "entries": [
                {id_field: "alpha", "reason": "first"},
                {id_field: "beta", "archive_sha256": "a".repeat(64), "version_requirement": "<2.0.0", "reason": "second"}
            ]
        });
        if let Some(extra) = extra {
            value["kind"] = json!(extra);
        }
        value
    }

    fn sign(directory: &TempDir, keys: &Keys, value: &Value) -> std::path::PathBuf {
        let bytes =
            sign_canonical_payload(&canonical_json_bytes(value), &keys.private, KEY_ID, None)
                .unwrap();
        let path = directory.path().join(format!(
            "current-{}.json",
            canonical_json_bytes(value).len()
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn renew(
        kind: PolicyKind,
        current: &Path,
        keys: &Keys,
        signer: &Keys,
        expires_at: &str,
    ) -> Result<Vec<u8>, RegistryError> {
        renew_policy_at(
            &RenewPolicyRequest::builder()
                .kind(kind)
                .current(current)
                .public_key(&keys.public)
                .key_id(KEY_ID)
                .private_key(&signer.private)
                .expires_at(expires_at)
                .build(),
            now(),
        )
    }

    const KINDS: [PolicyKind; 4] = [
        PolicyKind::Provider,
        PolicyKind::Theme,
        PolicyKind::Tab,
        PolicyKind::Lsp,
    ];

    #[test]
    fn renews_each_kind_keeping_entries_and_advancing_the_window() {
        for kind in KINDS {
            let directory = tempfile::tempdir().unwrap();
            let keys = keys(&directory, "online", false);
            let current = payload(kind, "2026-10-05T12:00:00Z", "2026-10-15T12:00:00Z");
            let path = sign(&directory, &keys, &current);
            let bytes = renew(kind, &path, &keys, &keys, "2026-10-24T12:00:00Z").unwrap();
            let envelope: Value = serde_json::from_slice(&bytes).unwrap();
            let mut expected = current.clone();
            expected["generated_at"] = json!("2026-10-11T12:00:00Z");
            expected["expires_at"] = json!("2026-10-24T12:00:00Z");
            assert_eq!(envelope["signed"], expected, "{kind:?}");
            assert_eq!(envelope["signature"]["key_id"], KEY_ID);
            let renewed = authenticate_policy(
                kind,
                &bytes,
                &std::fs::read(&keys.public).unwrap(),
                KEY_ID,
                false,
                now(),
            )
            .unwrap();
            assert_eq!(renewed.signed()["entries"], current["entries"]);
        }
    }

    #[test]
    fn an_expired_but_authentic_policy_is_renewable() {
        for kind in KINDS {
            let directory = tempfile::tempdir().unwrap();
            let keys = keys(&directory, "online", false);
            let current = payload(kind, "2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z");
            let path = sign(&directory, &keys, &current);
            assert!(renew(kind, &path, &keys, &keys, "2026-10-20T00:00:00Z").is_ok());
        }
    }

    #[test]
    fn refuses_a_wrong_key_wrong_signer_and_tampered_baseline() {
        for kind in KINDS {
            let directory = tempfile::tempdir().unwrap();
            let keys = keys(&directory, "online", false);
            let other = self::keys(&directory, "other", true);
            let current = payload(kind, "2026-10-05T12:00:00Z", "2026-10-15T12:00:00Z");
            let path = sign(&directory, &keys, &current);
            let expires = "2026-10-24T12:00:00Z";
            // The pinned public key does not authenticate the baseline.
            assert!(renew(kind, &path, &other, &other, expires).is_err());
            // A signer that is not the pinned key is refused before any output.
            let error = renew(kind, &path, &keys, &other, expires).unwrap_err();
            assert!(error.to_string().contains("pinned public key"), "{error}");
            // Edited entries no longer authenticate.
            let mut envelope: Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            envelope["signed"]["entries"] = json!([]);
            std::fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
            assert!(renew(kind, &path, &keys, &keys, expires).is_err());
        }
    }

    #[test]
    fn refuses_a_baseline_from_another_domain() {
        let directory = tempfile::tempdir().unwrap();
        let keys = keys(&directory, "online", false);
        for signed_as in KINDS {
            let current = payload(signed_as, "2026-10-05T12:00:00Z", "2026-10-15T12:00:00Z");
            let path = sign(&directory, &keys, &current);
            for asked in KINDS.into_iter().filter(|asked| *asked != signed_as) {
                assert!(
                    renew(asked, &path, &keys, &keys, "2026-10-24T12:00:00Z").is_err(),
                    "{signed_as:?} renewed as {asked:?}"
                );
            }
        }
    }

    #[test]
    fn refuses_expiries_that_do_not_advance_or_exceed_the_window() {
        let directory = tempfile::tempdir().unwrap();
        let keys = keys(&directory, "online", false);
        let kind = PolicyKind::Theme;
        let current = payload(kind, "2026-10-05T12:00:00Z", "2026-10-15T12:00:00Z");
        let path = sign(&directory, &keys, &current);
        for (expires, expected) in [
            ("2026-10-15T12:00:00Z", "later than the current"),
            ("2026-10-14T12:00:00Z", "later than the current"),
            // 14 days and one second past the new generation time.
            ("2026-10-25T12:00:01Z", "window"),
            ("2026-10-24T12:00:00+00:00", "canonical"),
            ("2026-10-24T12:00:00.5Z", "canonical"),
            ("tomorrow", "timestamp is invalid"),
        ] {
            let error = renew(kind, &path, &keys, &keys, expires).unwrap_err();
            assert!(error.to_string().contains(expected), "{expires}: {error}");
        }
        assert!(renew(kind, &path, &keys, &keys, "2026-10-25T12:00:00Z").is_ok());
    }

    #[test]
    fn refuses_to_renew_a_policy_generated_in_the_future() {
        let directory = tempfile::tempdir().unwrap();
        let keys = keys(&directory, "online", false);
        let kind = PolicyKind::Provider;
        // Generated at the same second as `now`: the renewal would not be newer.
        let current = payload(kind, "2026-10-11T12:00:00Z", "2026-10-20T12:00:00Z");
        let path = sign(&directory, &keys, &current);
        let error = renew(kind, &path, &keys, &keys, "2026-10-24T12:00:00Z").unwrap_err();
        assert!(
            error.to_string().contains("not generated before now"),
            "{error}"
        );
    }
}
