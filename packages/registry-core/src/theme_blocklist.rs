//! Strict, domain-bound declarative-theme revocation payloads.
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::blocklist::{
    prepare_blocklist, Blocklist, BlocklistEntry, PreparedBlocklist, MAX_BLOCKLIST_BYTES,
    SIGNED_OVERHEAD_BYTES,
};
use crate::{valid_theme_id, RegistryError};

/// Canonical signed payload budget; envelope overhead is separate.
pub const MAX_THEME_BLOCKLIST_BYTES: usize = MAX_BLOCKLIST_BYTES;
pub const MAX_SIGNED_THEME_BLOCKLIST_BYTES: usize =
    MAX_THEME_BLOCKLIST_BYTES + SIGNED_OVERHEAD_BYTES;

pub type ThemeBlocklist = Blocklist<ThemeBlocklistEntry>;
pub type PreparedThemeBlocklist = PreparedBlocklist<ThemeBlocklistEntry>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeBlocklistEntry {
    pub theme_id: String,
    pub version_requirement: Option<String>,
    pub archive_sha256: Option<String>,
    pub reason: String,
}

impl BlocklistEntry for ThemeBlocklistEntry {
    const SUBJECT: &'static str = "theme";
    const UNSUPPORTED: &'static str = "unsupported declarative theme blocklist schema or kind";
    const INVALID_DIGEST: &'static str = "revocation archive_sha256 must be lowercase SHA-256";

    fn valid_id(&self) -> bool {
        valid_theme_id(&self.theme_id)
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
            &self.theme_id,
            self.version_requirement.as_deref().unwrap_or(""),
            self.archive_sha256.as_deref().unwrap_or(""),
        ]
    }
}

/// Retains canonical bytes of the supplied value, never a typed projection.
pub fn prepare_theme_blocklist(
    value: &Value,
    allow_expired: bool,
    now: DateTime<Utc>,
) -> Result<PreparedThemeBlocklist, RegistryError> {
    prepare_blocklist(value, allow_expired, now)
}

impl ThemeBlocklist {
    /// The reason the first entry matching the theme gives; `Err` when
    /// `version` is not semver.
    pub fn blocked_reason(
        &self,
        id: &str,
        version: &str,
        digest: &str,
    ) -> Result<Option<&str>, RegistryError> {
        Ok(self
            .admitting(version)?
            .find(|entry| {
                entry.theme_id == id
                    && entry
                        .archive_sha256
                        .as_deref()
                        .is_none_or(|blocked| blocked == digest)
            })
            .map(|entry| entry.reason.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_json_bytes;
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
