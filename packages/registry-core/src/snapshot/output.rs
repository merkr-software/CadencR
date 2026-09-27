use chrono::Utc;
use sha2::{Digest as _, Sha256};

use super::CatalogSnapshot;
use crate::error::RegistryError;
use crate::index::validate_fresh_window;

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl CatalogSnapshot {
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
