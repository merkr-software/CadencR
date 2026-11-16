//! Strict, domain-bound managed-provider revocation payloads. Unlike the
//! theme and tab feeds this document carries no `kind`: its shape is the
//! closed `{schema_version, generated_at, expires_at, entries}` the desktop
//! service parses, so a theme or tab policy is never accepted as one.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::blocklist::{
    validate_entries, validate_window, BlocklistEntry, MAX_BLOCKLIST_BYTES, MAX_ENTRIES,
    SIGNED_OVERHEAD_BYTES,
};
use crate::{canonical_json_bytes, PreparedSigningPayload, RegistryError};

/// Largest canonical payload. The service refuses to download more than
/// [`MAX_BLOCKLIST_BYTES`] in total, signature included, so the payload leaves
/// room for the envelope: nothing signable here is unreadable by the app.
const MAX_PAYLOAD_BYTES: usize = MAX_BLOCKLIST_BYTES - SIGNED_OVERHEAD_BYTES;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderBlocklist {
    schema_version: u32,
    generated_at: String,
    expires_at: String,
    entries: Vec<ProviderBlocklistEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderBlocklistEntry {
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version_requirement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archive_sha256: Option<String>,
    reason: String,
}

impl BlocklistEntry for ProviderBlocklistEntry {
    const SUBJECT: &'static str = "provider";
    const UNSUPPORTED: &'static str = "unsupported managed provider blocklist schema";
    const INVALID_DIGEST: &'static str = "revocation archive_sha256 must be lowercase SHA-256";

    fn valid_id(&self) -> bool {
        cadencr_plugin_core::validate_provider_id(&self.provider_id).is_ok()
    }
    fn version_requirement(&self) -> Option<&str> {
        self.version_requirement.as_deref()
    }
    fn digests(&self) -> Vec<&str> {
        self.archive_sha256.as_deref().into_iter().collect()
    }
    fn reason(&self) -> &str {
        &self.reason
    }
    fn identity(&self) -> Vec<&str> {
        vec![
            &self.provider_id,
            self.version_requirement.as_deref().unwrap_or(""),
            self.archive_sha256.as_deref().unwrap_or(""),
        ]
    }
}

/// Validate `value` as the provider revocation policy and retain its
/// canonical bytes, never a typed projection.
///
/// The desktop service signs and verifies a typed re-serialization of the
/// document, so a payload whose canonical bytes differ from that
/// re-serialization (an explicit `null`, say) is refused here: it would
/// verify in the registry and fail on every client.
pub(crate) fn prepare_provider_blocklist(
    value: &Value,
    allow_expired: bool,
    now: DateTime<Utc>,
) -> Result<PreparedSigningPayload, RegistryError> {
    let label = "provider blocklist";
    let canonical = canonical_json_bytes(value);
    if canonical.len() > MAX_PAYLOAD_BYTES {
        return Err(RegistryError::single(format!(
            "{label} exceeds the {MAX_PAYLOAD_BYTES} byte limit that keeps its signed form under 1 MiB"
        )));
    }
    let policy: ProviderBlocklist = serde_json::from_value(value.clone())
        .map_err(|error| RegistryError::single(format!("invalid {label}: {error}")))?;
    if policy.schema_version != 1 || policy.entries.len() > MAX_ENTRIES {
        return Err(RegistryError::single(ProviderBlocklistEntry::UNSUPPORTED));
    }
    let reserialized = serde_json::to_value(&policy)
        .map_err(|error| RegistryError::single(format!("invalid {label}: {error}")))?;
    if canonical_json_bytes(&reserialized) != canonical {
        return Err(RegistryError::single(format!(
            "{label} must omit absent optional fields instead of setting them to null"
        )));
    }
    validate_window(
        &policy.generated_at,
        &policy.expires_at,
        allow_expired,
        now,
        label,
    )?;
    validate_entries(&policy.entries, label)?;
    Ok(PreparedSigningPayload {
        canonical,
        generated_at: policy.generated_at,
        expires_at: policy.expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(entries: Value) -> (Value, DateTime<Utc>) {
        let now = DateTime::parse_from_rfc3339("2026-10-11T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        (
            json!({"schema_version":1,"generated_at":"2026-10-11T11:00:00Z","expires_at":"2026-10-11T13:00:00Z","entries":entries}),
            now,
        )
    }

    #[test]
    fn accepts_the_service_document_and_keeps_its_canonical_bytes() {
        let (value, now) = payload(json!([
            {"provider_id":"alpha","reason":"global"},
            {"provider_id":"beta","archive_sha256":"a".repeat(64),"version_requirement":"<2.0.0","reason":"bad"}
        ]));
        let prepared = prepare_provider_blocklist(&value, false, now).unwrap();
        assert_eq!(prepared.canonical_payload(), canonical_json_bytes(&value));
        assert!(prepare_provider_blocklist(&payload(json!([])).0, true, now).is_ok());
    }

    #[test]
    fn rejects_other_domains_nulls_bad_fields_order_and_windows() {
        for entry in [
            json!({"theme_id":"alpha","reason":"wrong domain"}),
            json!({"tab_id":"alpha","reason":"wrong domain"}),
            json!({"provider_id":"Alpha","reason":"id"}),
            json!({"provider_id":"alpha","reason":"nulls","archive_sha256":null}),
            json!({"provider_id":"alpha","version_requirement":"bad","reason":"bad"}),
            json!({"provider_id":"alpha","archive_sha256":"A".repeat(64),"reason":"upper"}),
            json!({"provider_id":"alpha","reason":" "}),
            json!({"provider_id":"alpha","reason":"ok","extra":true}),
        ] {
            let (value, now) = payload(json!([entry]));
            assert!(
                prepare_provider_blocklist(&value, false, now).is_err(),
                "{value}"
            );
        }
        let (unsorted, now) = payload(json!([
            {"provider_id":"b","reason":"b"},{"provider_id":"a","reason":"a"}
        ]));
        assert!(prepare_provider_blocklist(&unsorted, false, now).is_err());
        for kind in ["theme-blocklist", "tab-blocklist", "provider-blocklist"] {
            let (mut tagged, now) = payload(json!([]));
            tagged["kind"] = json!(kind);
            assert!(prepare_provider_blocklist(&tagged, false, now).is_err());
        }
        let (value, now) = payload(json!([]));
        let later = now + chrono::Duration::hours(2);
        assert!(prepare_provider_blocklist(&value, false, later).is_err());
        assert!(prepare_provider_blocklist(&value, true, later).is_ok());
        let mut long = value;
        long["expires_at"] = json!("2026-10-25T11:00:01Z");
        assert!(prepare_provider_blocklist(&long, true, now).is_err());
    }

    /// A fresh provider policy whose canonical payload is exactly `size` bytes.
    fn payload_of_size(size: usize) -> Value {
        let now = Utc::now();
        let stamp = |time: DateTime<Utc>| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let build = |count: usize, extra: usize| {
            let entries: Vec<Value> = (0..count)
                .map(|index| {
                    json!({"provider_id": format!("p{index:05}"), "reason": "x".repeat(1000 + extra)})
                })
                .collect();
            json!({
                "schema_version": 1,
                "generated_at": stamp(now - chrono::Duration::minutes(1)),
                "expires_at": stamp(now + chrono::Duration::hours(1)),
                "entries": entries,
            })
        };
        let length = |value: &Value| canonical_json_bytes(value).len();
        let mut count = 1;
        while length(&build(count + 1, 0)) <= size {
            count += 1;
        }
        // Spread what is left over the reasons (each may grow by 24 bytes).
        let mut value = build(count, 0);
        let mut missing = size - length(&value);
        for entry in value["entries"].as_array_mut().unwrap() {
            let grow = missing.min(24);
            let reason = entry["reason"].as_str().unwrap().to_owned();
            entry["reason"] = json!(reason + &"x".repeat(grow));
            missing -= grow;
        }
        assert_eq!(missing, 0);
        assert_eq!(length(&value), size);
        value
    }

    #[test]
    fn a_signable_policy_always_fits_the_services_one_mib_download_limit() {
        let largest = payload_of_size(MAX_PAYLOAD_BYTES);
        assert!(prepare_provider_blocklist(&largest, false, Utc::now()).is_ok());
        let too_large = payload_of_size(MAX_PAYLOAD_BYTES + 1);
        let error = prepare_provider_blocklist(&too_large, false, Utc::now()).unwrap_err();
        assert!(error.to_string().contains("1 MiB"), "{error}");

        // The largest signable policy, with the longest key id, is still no
        // larger than the service accepts (`MAX_BLOCKLIST_BYTES` in total).
        let directory = tempfile::tempdir().unwrap();
        let keys = crate::test_keys::write(directory.path(), "release", false);
        let payload = directory.path().join("payload.json");
        std::fs::write(&payload, canonical_json_bytes(&largest)).unwrap();
        let key_id = format!("a{}", "k".repeat(127));
        let signed = crate::sign_policy(
            crate::PolicyKind::Provider,
            &payload,
            &keys.private,
            &key_id,
        )
        .unwrap();
        assert!(signed.len() <= MAX_BLOCKLIST_BYTES, "{}", signed.len());
        assert!(signed.len() <= crate::PolicyKind::Provider.max_signed_bytes());
    }
}
