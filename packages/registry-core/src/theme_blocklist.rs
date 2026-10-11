//! Strict, domain-bound declarative-theme revocation payloads.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::{canonical_json_bytes, valid_theme_id, PreparedSigningPayload, RegistryError};

/// Canonical signed payload budget; envelope overhead is separate.
pub const MAX_THEME_BLOCKLIST_BYTES: usize = 1024 * 1024;
pub const MAX_SIGNED_THEME_BLOCKLIST_BYTES: usize = MAX_THEME_BLOCKLIST_BYTES + 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeBlocklist {
    pub schema_version: u32,
    pub kind: String,
    pub generated_at: String,
    pub expires_at: String,
    pub entries: Vec<ThemeBlocklistEntry>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeBlocklistEntry {
    pub theme_id: String,
    pub version_requirement: Option<String>,
    pub archive_sha256: Option<String>,
    pub reason: String,
}
pub struct PreparedThemeBlocklist {
    pub signing: PreparedSigningPayload,
    pub policy: ThemeBlocklist,
}
/// Retains canonical bytes of the supplied value, never a typed projection.
pub fn prepare_theme_blocklist(
    value: &Value,
    allow_expired: bool,
    now: DateTime<Utc>,
) -> Result<PreparedThemeBlocklist, RegistryError> {
    let canonical = canonical_json_bytes(value);
    if canonical.len() > MAX_THEME_BLOCKLIST_BYTES {
        return Err(invalid("theme blocklist exceeds 1 MiB"));
    }
    let policy: ThemeBlocklist = serde_json::from_value(value.clone())
        .map_err(|error| invalid(format!("invalid theme blocklist: {error}")))?;
    if policy.schema_version != 1 || policy.kind != "theme-blocklist" || policy.entries.len() > 4096
    {
        return Err(invalid(
            "unsupported declarative theme blocklist schema or kind",
        ));
    }
    let generated_at = timestamp(&policy.generated_at)?;
    let expires_at = timestamp(&policy.expires_at)?;
    if generated_at > now
        || expires_at <= generated_at
        || expires_at - generated_at > chrono::Duration::days(14)
        || (!allow_expired && expires_at <= now)
    {
        return Err(invalid(
            "theme blocklist window is invalid, future-dated, or expired",
        ));
    }
    let mut previous = None;
    for entry in &policy.entries {
        validate_entry(entry)?;
        let identity = (
            entry.theme_id.as_str(),
            entry.version_requirement.as_deref().unwrap_or(""),
            entry.archive_sha256.as_deref().unwrap_or(""),
        );
        if previous.is_some_and(|prior| prior >= identity) {
            return Err(invalid(
                "theme blocklist entries must be unique and sorted by identity",
            ));
        }
        previous = Some(identity);
    }
    let signing = PreparedSigningPayload {
        canonical,
        generated_at: policy.generated_at.clone(),
        expires_at: policy.expires_at.clone(),
    };
    Ok(PreparedThemeBlocklist { signing, policy })
}
fn timestamp(value: &str) -> Result<DateTime<Utc>, RegistryError> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid("theme blocklist timestamp is invalid"))?
        .with_timezone(&Utc);
    if value.len() != 20 || parsed.to_rfc3339_opts(SecondsFormat::Secs, true) != value {
        return Err(invalid(
            "theme blocklist timestamps require canonical UTC whole seconds",
        ));
    }
    Ok(parsed)
}
fn validate_entry(entry: &ThemeBlocklistEntry) -> Result<(), RegistryError> {
    if !valid_theme_id(&entry.theme_id) {
        return Err(invalid("invalid revocation theme_id"));
    }
    if let Some(requirement) = &entry.version_requirement {
        semver::VersionReq::parse(requirement)
            .map_err(|_| invalid("invalid revocation version requirement"))?;
    }
    if let Some(digest) = &entry.archive_sha256 {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(invalid(
                "revocation archive_sha256 must be lowercase SHA-256",
            ));
        }
    }
    if entry.reason.trim().is_empty()
        || entry.reason.len() > 1024
        || entry.reason.chars().any(char::is_control)
    {
        return Err(invalid("revocation reason must be bounded visible text"));
    }
    Ok(())
}
impl ThemeBlocklist {
    pub fn blocked_reason(
        &self,
        id: &str,
        version: &str,
        digest: &str,
    ) -> Result<Option<&str>, RegistryError> {
        let version =
            semver::Version::parse(version).map_err(|_| invalid("theme version is invalid"))?;
        for entry in &self.entries {
            let matches_version = entry
                .version_requirement
                .as_deref()
                .map(semver::VersionReq::parse)
                .transpose()
                .map_err(|_| invalid("revocation version requirement is invalid"))?
                .is_none_or(|requirement| requirement.matches(&version));
            if entry.theme_id == id
                && matches_version
                && entry
                    .archive_sha256
                    .as_deref()
                    .is_none_or(|blocked| blocked == digest)
            {
                return Ok(Some(&entry.reason));
            }
        }
        Ok(None)
    }
}
fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
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
            json!({"schema_version":1,"kind":"theme-blocklist","generated_at":"2026-10-11T11:00:00Z","expires_at":"2026-10-11T13:00:00Z","entries":entries}),
            now,
        )
    }
    #[test]
    fn validity_window_is_bounded_at_fourteen_days_including_expired_history() {
        let (mut value, now) = payload(json!([]));
        let generated = timestamp(value["generated_at"].as_str().unwrap()).unwrap();
        value["expires_at"] = (generated + chrono::Duration::days(14))
            .to_rfc3339_opts(SecondsFormat::Secs, true)
            .into();
        assert!(prepare_theme_blocklist(&value, false, now).is_ok());
        value["expires_at"] =
            (generated + chrono::Duration::days(14) + chrono::Duration::seconds(1))
                .to_rfc3339_opts(SecondsFormat::Secs, true)
                .into();
        assert!(prepare_theme_blocklist(&value, false, now).is_err());
        assert!(prepare_theme_blocklist(&value, true, now + chrono::Duration::days(30)).is_err());
    }

    #[test]
    fn global_version_digest_and_long_theme_identity_share_one_policy() {
        let id = "a".repeat(128);
        let (value, now) = payload(json!([
            {"theme_id":id,"reason":"global"},
            {"theme_id":"digest","archive_sha256":"a".repeat(64),"reason":"digest"},
            {"theme_id":"versions","version_requirement":">=1.0.0, <2.0.0","reason":"version"}
        ]));
        let prepared = prepare_theme_blocklist(&value, false, now).unwrap();
        assert_eq!(
            prepared.signing.canonical_payload(),
            canonical_json_bytes(&value)
        );
        assert_eq!(
            prepared.policy.blocked_reason(&id, "1.0.0", "b").unwrap(),
            Some("global")
        );
        assert_eq!(
            prepared
                .policy
                .blocked_reason("digest", "3.0.0", &"a".repeat(64))
                .unwrap(),
            Some("digest")
        );
        assert!(prepared
            .policy
            .blocked_reason("digest", "3.0.0", &"b".repeat(64))
            .unwrap()
            .is_none());
        assert_eq!(
            prepared
                .policy
                .blocked_reason("versions", "1.5.0", "b")
                .unwrap(),
            Some("version")
        );
        assert!(prepared
            .policy
            .blocked_reason("versions", "2.0.0", "b")
            .unwrap()
            .is_none());
    }
    #[test]
    fn rejects_provider_alias_unknown_fields_invalid_scope_and_expiry() {
        for entry in [
            json!({"provider_id":"theme","reason":"wrong domain"}),
            json!({"theme_id":"a".repeat(129),"reason":"long"}),
            json!({"theme_id":"theme","version_requirement":"bad","reason":"bad"}),
            json!({"theme_id":"theme","archive_sha256":"bad","reason":"bad"}),
        ] {
            let (value, now) = payload(json!([entry]));
            assert!(prepare_theme_blocklist(&value, false, now).is_err());
        }
        let (value, now) = payload(json!([]));
        assert!(prepare_theme_blocklist(&value, false, now + chrono::Duration::hours(2)).is_err());
        assert!(prepare_theme_blocklist(&value, true, now + chrono::Duration::hours(2)).is_ok());
        let mut unknown = value;
        unknown["provider_id"] = "bad".into();
        assert!(prepare_theme_blocklist(&unknown, false, now).is_err());
    }
}
