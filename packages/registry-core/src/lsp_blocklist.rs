//! Strict, domain-bound language-server revocation payloads: a feed of its own
//! (`kind: "lsp-blocklist"`), signed with the same key as the other feeds.
//! An entry can name a whole language server, a version range, one target archive or one
//! launch entry.
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::blocklist::{
    prepare_blocklist, Blocklist, BlocklistEntry, PreparedBlocklist, MAX_BLOCKLIST_BYTES,
    SIGNED_OVERHEAD_BYTES,
};
use crate::RegistryError;

/// Canonical signed payload budget; envelope overhead is separate.
pub const MAX_LSP_BLOCKLIST_BYTES: usize = MAX_BLOCKLIST_BYTES;
pub const MAX_SIGNED_LSP_BLOCKLIST_BYTES: usize = MAX_LSP_BLOCKLIST_BYTES + SIGNED_OVERHEAD_BYTES;

pub type LspBlocklist = Blocklist<LspBlocklistEntry>;
pub type PreparedLspBlocklist = PreparedBlocklist<LspBlocklistEntry>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspBlocklistEntry {
    pub lsp_id: String,
    pub version_requirement: Option<String>,
    /// One target archive (`lsp.distribution.binary.<p>.sha256`).
    pub archive_sha256: Option<String>,
    /// A launch entry (`lsp.distribution.binary.<p>.entry_sha256`).
    pub entry_sha256: Option<String>,
    pub reason: String,
}

impl BlocklistEntry for LspBlocklistEntry {
    const SUBJECT: &'static str = "lsp";
    const UNSUPPORTED: &'static str = "unsupported custom lsp blocklist schema or kind";
    const INVALID_DIGEST: &'static str =
        "revocation archive_sha256 and entry_sha256 must be lowercase SHA-256";

    fn valid_id(&self) -> bool {
        crate::valid_theme_id(&self.lsp_id)
    }
    fn version_requirement(&self) -> Option<&str> {
        self.version_requirement.as_deref()
    }
    fn digests(&self) -> Vec<&str> {
        [&self.archive_sha256, &self.entry_sha256]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect()
    }
    fn reason(&self) -> &str {
        &self.reason
    }
    fn identity(&self) -> Vec<&str> {
        vec![
            &self.lsp_id,
            self.version_requirement.as_deref().unwrap_or(""),
            self.archive_sha256.as_deref().unwrap_or(""),
            self.entry_sha256.as_deref().unwrap_or(""),
        ]
    }
}

/// Retains canonical bytes of the supplied value, never a typed projection.
pub fn prepare_lsp_blocklist(
    value: &Value,
    allow_expired: bool,
    now: DateTime<Utc>,
) -> Result<PreparedLspBlocklist, RegistryError> {
    prepare_blocklist(value, allow_expired, now)
}

impl LspBlocklist {
    /// The reason the first matching entry gives. An entry matches when every
    /// field it sets matches; an `entry_sha256` entry never matches a lsp
    /// without a launch entry (`entry_sha256: None`). `Err` when `version` is
    /// not semver.
    pub fn blocked_reason(
        &self,
        id: &str,
        version: &str,
        archive_sha256: &str,
        entry_sha256: Option<&str>,
    ) -> Result<Option<&str>, RegistryError> {
        Ok(self
            .admitting(version)?
            .find(|entry| {
                entry.lsp_id == id
                    && entry
                        .archive_sha256
                        .as_deref()
                        .is_none_or(|blocked| blocked == archive_sha256)
                    && entry
                        .entry_sha256
                        .as_deref()
                        .is_none_or(|blocked| entry_sha256 == Some(blocked))
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
            json!({"schema_version":1,"kind":"lsp-blocklist","generated_at":"2026-10-11T11:00:00Z","expires_at":"2026-10-11T13:00:00Z","entries":entries}),
            now,
        )
    }

    #[test]
    fn entries_match_by_id_version_archive_and_entry() {
        let (value, now) = payload(json!([
            {"lsp_id":"binary","entry_sha256":"e".repeat(64),"reason":"bad binary"},
            {"lsp_id":"global","reason":"global"},
            {"lsp_id":"web","archive_sha256":"a".repeat(64),"reason":"bad web"},
            {"lsp_id":"web","version_requirement":">=2.0.0","reason":"v2"}
        ]));
        let prepared = prepare_lsp_blocklist(&value, false, now).unwrap();
        assert_eq!(
            prepared.signing.canonical_payload(),
            canonical_json_bytes(&value)
        );
        let policy = prepared.policy;
        let any = "b".repeat(64);
        assert_eq!(
            policy
                .blocked_reason("global", "1.0.0", &any, None)
                .unwrap(),
            Some("global")
        );
        let entry = "e".repeat(64);
        assert_eq!(
            policy
                .blocked_reason("binary", "1.0.0", &any, Some(&entry))
                .unwrap(),
            Some("bad binary")
        );
        assert!(policy
            .blocked_reason("binary", "1.0.0", &any, Some(&any))
            .unwrap()
            .is_none());
        assert!(policy
            .blocked_reason("binary", "1.0.0", &any, None)
            .unwrap()
            .is_none());
        assert_eq!(
            policy
                .blocked_reason("web", "1.0.0", &"a".repeat(64), None)
                .unwrap(),
            Some("bad web")
        );
        assert!(policy
            .blocked_reason("web", "1.5.0", &any, None)
            .unwrap()
            .is_none());
        assert_eq!(
            policy.blocked_reason("web", "2.1.0", &any, None).unwrap(),
            Some("v2")
        );
    }

    #[test]
    fn rejects_other_domains_bad_fields_order_and_windows() {
        for entry in [
            json!({"theme_id":"lsp","reason":"wrong domain"}),
            json!({"lsp_id":"Bad_Id","reason":"id"}),
            json!({"lsp_id":"lsp","version_requirement":"bad","reason":"bad"}),
            json!({"lsp_id":"lsp","entry_sha256":"E".repeat(64),"reason":"upper"}),
            json!({"lsp_id":"lsp","archive_sha256":"short","reason":"short"}),
            json!({"lsp_id":"lsp","reason":" "}),
            json!({"lsp_id":"lsp","reason":"ok","extra":true}),
        ] {
            let (value, now) = payload(json!([entry]));
            assert!(
                prepare_lsp_blocklist(&value, false, now).is_err(),
                "{value}"
            );
        }
        let (unsorted, now) = payload(json!([
            {"lsp_id":"b","reason":"b"},{"lsp_id":"a","reason":"a"}
        ]));
        assert!(prepare_lsp_blocklist(&unsorted, false, now).is_err());
        let (duplicate, now) = payload(json!([
            {"lsp_id":"a","reason":"a"},{"lsp_id":"a","reason":"again"}
        ]));
        assert!(prepare_lsp_blocklist(&duplicate, false, now).is_err());
        let (mut theme, now) = payload(json!([]));
        theme["kind"] = json!("theme-blocklist");
        assert!(prepare_lsp_blocklist(&theme, false, now).is_err());
        let (value, now) = payload(json!([]));
        let later = now + chrono::Duration::hours(2);
        assert!(prepare_lsp_blocklist(&value, false, later).is_err());
        assert!(prepare_lsp_blocklist(&value, true, later).is_ok());
        let mut long = value;
        long["expires_at"] = json!("2026-10-25T11:00:01Z");
        assert!(prepare_lsp_blocklist(&long, true, now).is_err());
    }
}
