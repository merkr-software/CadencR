use chrono::Utc;
use sha2::{Digest as _, Sha256};

use super::{required_timestamp, signed, CatalogSnapshot, CATALOG_LIMIT};
use crate::error::RegistryError;
use crate::index::validate_fresh_window;
use crate::json::canonical_json_bytes;
use serde_json::Value;

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn assemble_snapshot(
    envelope: Value,
    canonical_payload: Vec<u8>,
    previous_sha256: Option<String>,
    repository: &str,
    registry_commit: &str,
) -> Result<CatalogSnapshot, RegistryError> {
    let signed = signed(&envelope);
    let generated_at = required_timestamp(signed, "generated_at")?.to_owned();
    let expires_at = required_timestamp(signed, "expires_at")?.to_owned();
    let mut canonical_envelope = canonical_json_bytes(&envelope);
    canonical_envelope.push(b'\n');
    if canonical_envelope.len() as u64 > CATALOG_LIMIT {
        return Err(RegistryError::single("catalog snapshot exceeds 32 MiB"));
    }
    let sha256 = digest(&canonical_envelope);
    let tag = if signed["schema_version"] == 2 {
        format!("marketplace-v2-{sha256}")
    } else {
        format!("catalog-{sha256}")
    };
    let prior = previous_sha256.as_deref().unwrap_or("bootstrap");
    let body = format!("cadencr-registry-catalog-v1\ncatalog-sha256:{sha256}\nregistry-commit:{registry_commit}\nprevious-sha256:{prior}");
    let expected_url =
        format!("https://github.com/{repository}/releases/download/{tag}/managed-index.json");
    Ok(CatalogSnapshot {
        schema_version: signed["schema_version"].as_u64().expect("verified schema"),
        canonical_payload,
        canonical_envelope,
        sha256,
        tag,
        body,
        expected_url,
        discovery_bootstrap: previous_sha256.is_none(),
        previous_sha256,
        generated_at,
        expires_at,
        repository: repository.into(),
        registry_commit: registry_commit.into(),
    })
}

impl CatalogSnapshot {
    /// A new isolated schema-2 namespace may bootstrap after authenticated schema-1 continuity.
    pub fn discovery_bootstrap(&self) -> bool {
        self.discovery_bootstrap
    }
    pub fn schema_version(&self) -> u64 {
        self.schema_version
    }
    pub fn canonical_payload(&self) -> &[u8] {
        &self.canonical_payload
    }
    pub fn canonical_envelope(&self) -> &[u8] {
        &self.canonical_envelope
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn size(&self) -> usize {
        self.canonical_envelope.len()
    }
    pub fn tag(&self) -> &str {
        &self.tag
    }
    pub fn body(&self) -> &str {
        &self.body
    }
    pub fn expected_url(&self) -> &str {
        &self.expected_url
    }
    pub fn previous_sha256(&self) -> Option<&str> {
        self.previous_sha256.as_deref()
    }
    pub fn generated_at(&self) -> &str {
        &self.generated_at
    }
    pub fn expires_at(&self) -> &str {
        &self.expires_at
    }
    pub fn repository(&self) -> &str {
        &self.repository
    }
    pub fn registry_commit(&self) -> &str {
        &self.registry_commit
    }

    /// Recheck only the time-dependent window after slow publication I/O.
    pub fn revalidate_freshness(&self) -> Result<(), RegistryError> {
        self.revalidate_freshness_at(Utc::now())
    }

    fn revalidate_freshness_at(&self, now: chrono::DateTime<Utc>) -> Result<(), RegistryError> {
        validate_fresh_window(&self.generated_at, &self.expires_at, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> CatalogSnapshot {
        CatalogSnapshot {
            schema_version: 1,
            discovery_bootstrap: true,
            canonical_payload: vec![],
            canonical_envelope: vec![],
            sha256: String::new(),
            tag: String::new(),
            body: String::new(),
            expected_url: String::new(),
            previous_sha256: None,
            generated_at: "2026-09-27T11:00:00Z".into(),
            expires_at: "2026-09-27T12:00:00Z".into(),
            repository: String::new(),
            registry_commit: String::new(),
        }
    }

    #[test]
    fn freshness_accepts_just_before_expiry_and_rejects_expiry_or_later() {
        let snapshot = snapshot();
        let at = |value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .unwrap()
                .with_timezone(&Utc)
        };
        snapshot
            .revalidate_freshness_at(at("2026-09-27T11:59:59Z"))
            .unwrap();
        for now in ["2026-09-27T12:00:00Z", "2026-09-27T12:00:01Z"] {
            assert_eq!(
                snapshot
                    .revalidate_freshness_at(at(now))
                    .unwrap_err()
                    .to_string(),
                "index has expired"
            );
        }
    }
}
