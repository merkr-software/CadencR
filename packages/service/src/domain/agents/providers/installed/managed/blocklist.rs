//! Signed, cached kill-switch policy for managed provider packages.

use std::fmt;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt as _;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

use super::trust::ManagedTrustStore;
use super::{canonical_json, ManagedIndexSignature};

pub const MANAGED_BLOCKLIST_SCHEMA_VERSION: u32 = 1;
pub const MAX_BLOCKLIST_BYTES: usize = 1024 * 1024;
const BLOCKLIST_REFRESH_TIMEOUT: Duration = Duration::from_secs(15);

mod cache;
pub use cache::{load_cached_blocklist, load_enforced_blocklist};

/// Release-owned kill-switch source compiled into the service binary. The
/// renderer cannot override this URL or supply trust keys.
pub fn pinned_blocklist_url() -> Option<&'static str> {
    option_env!("CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL").filter(|value| !value.trim().is_empty())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedManagedProviderBlocklist {
    pub signed: ManagedProviderBlocklist,
    pub signature: ManagedIndexSignature,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedProviderBlocklist {
    pub schema_version: u32,
    pub generated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub entries: Vec<ManagedBlocklistEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedBlocklistEntry {
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_requirement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    pub reason: String,
}

impl ManagedProviderBlocklist {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&canonical_json(serde_json::to_value(self)?))
    }

    fn validate(&self, now: DateTime<Utc>) -> Result<(), ManagedBlocklistError> {
        if self.schema_version != MANAGED_BLOCKLIST_SCHEMA_VERSION {
            return Err(invalid(format!(
                "managed blocklist schema_version {} is unsupported",
                self.schema_version
            )));
        }
        if self.expires_at <= self.generated_at {
            return Err(invalid("blocklist expires_at must follow generated_at"));
        }
        if self.generated_at > now {
            return Err(invalid("blocklist generated_at is in the future"));
        }
        if now >= self.expires_at {
            return Err(ManagedBlocklistError::new(
                ManagedBlocklistErrorCode::ExpiredBlocklist,
                format!(
                    "cached managed-provider blocklist expired at {}",
                    self.expires_at
                ),
            ));
        }
        let mut previous: Option<(&str, &str, &str)> = None;
        for entry in &self.entries {
            entry.validate()?;
            let identity = (
                entry.provider_id.as_str(),
                entry.version_requirement.as_deref().unwrap_or(""),
                entry.archive_sha256.as_deref().unwrap_or(""),
            );
            if previous.is_some_and(|prior| prior >= identity) {
                return Err(invalid(
                    "blocklist entries must be unique and sorted by provider, version, and digest",
                ));
            }
            previous = Some(identity);
        }
        Ok(())
    }
}

impl ManagedBlocklistEntry {
    fn validate(&self) -> Result<(), ManagedBlocklistError> {
        crate::domain::agents::providers::installed::descriptor::validate_provider_id(
            &self.provider_id,
        )
        .map_err(|error| invalid(error.message))?;
        if let Some(requirement) = self.version_requirement.as_deref() {
            VersionReq::parse(requirement).map_err(|error| {
                invalid(format!("invalid blocklist version requirement: {error}"))
            })?;
        }
        if let Some(digest) = self.archive_sha256.as_deref() {
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid(
                    "blocklist archive_sha256 must be 64 hex characters",
                ));
            }
        }
        if self.reason.trim().is_empty() || self.reason.len() > 1024 {
            return Err(invalid("blocklist reason must contain 1-1024 bytes"));
        }
        Ok(())
    }

    fn matches(&self, provider_id: &str, version: &Version, digest: &str) -> bool {
        self.provider_id == provider_id
            && self
                .version_requirement
                .as_deref()
                .is_none_or(|requirement| {
                    VersionReq::parse(requirement)
                        .expect("verified blocklist version requirement")
                        .matches(version)
                })
            && self
                .archive_sha256
                .as_deref()
                .is_none_or(|blocked| blocked.eq_ignore_ascii_case(digest))
    }
}

#[derive(Debug, Clone)]
pub struct VerifiedManagedBlocklist {
    blocklist: ManagedProviderBlocklist,
    signer_key_id: String,
}

impl VerifiedManagedBlocklist {
    pub fn signer_key_id(&self) -> &str {
        &self.signer_key_id
    }

    pub fn expires_at(&self) -> DateTime<Utc> {
        self.blocklist.expires_at
    }

    pub fn blocked_reason(
        &self,
        provider_id: &str,
        provider_version: &str,
        archive_sha256: &str,
    ) -> Result<Option<&str>, ManagedBlocklistError> {
        let version = Version::parse(provider_version)
            .map_err(|error| invalid(format!("installed provider version is invalid: {error}")))?;
        Ok(self
            .blocklist
            .entries
            .iter()
            .find(|entry| entry.matches(provider_id, &version, archive_sha256))
            .map(|entry| entry.reason.as_str()))
    }
}

impl ManagedTrustStore {
    pub fn verify_blocklist(
        &self,
        envelope: SignedManagedProviderBlocklist,
        now: DateTime<Utc>,
    ) -> Result<VerifiedManagedBlocklist, ManagedBlocklistError> {
        envelope.signed.validate(now)?;
        let bytes = envelope.signed.signing_bytes().map_err(|error| {
            invalid(format!(
                "managed blocklist could not be canonicalized: {error}"
            ))
        })?;
        let signer_key_id = self
            .verify_bytes(&bytes, &envelope.signature)
            .map_err(|error| ManagedBlocklistError::new(error.code.as_str(), error.message))?;
        Ok(VerifiedManagedBlocklist {
            blocklist: envelope.signed,
            signer_key_id,
        })
    }
}

pub async fn refresh_blocklist(
    client: &reqwest::Client,
    url: &str,
    cache_path: &Path,
    trust_store: &ManagedTrustStore,
) -> Result<VerifiedManagedBlocklist, ManagedBlocklistError> {
    tokio::time::timeout(
        BLOCKLIST_REFRESH_TIMEOUT,
        refresh_blocklist_inner(client, url, cache_path, trust_store),
    )
    .await
    .map_err(|_| download_failed("blocklist refresh timed out after 15 seconds"))?
}

async fn refresh_blocklist_inner(
    client: &reqwest::Client,
    url: &str,
    cache_path: &Path,
    trust_store: &ManagedTrustStore,
) -> Result<VerifiedManagedBlocklist, ManagedBlocklistError> {
    let url = reqwest::Url::parse(url)
        .map_err(|error| download_failed(format!("blocklist URL is invalid: {error}")))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(download_failed("blocklist URL must be absolute HTTPS"));
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| download_failed(format!("blocklist download failed: {error}")))?
        .error_for_status()
        .map_err(|error| download_failed(format!("blocklist download failed: {error}")))?;
    if response.url().scheme() != "https" {
        return Err(download_failed("blocklist redirect resolved outside HTTPS"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BLOCKLIST_BYTES as u64)
    {
        return Err(ManagedBlocklistError::new(
            ManagedBlocklistErrorCode::BlocklistTooLarge,
            "downloaded managed-provider blocklist exceeds 1 MiB",
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|error| download_failed(format!("blocklist download failed: {error}")))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_BLOCKLIST_BYTES {
            return Err(ManagedBlocklistError::new(
                ManagedBlocklistErrorCode::BlocklistTooLarge,
                "downloaded managed-provider blocklist exceeds 1 MiB",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: SignedManagedProviderBlocklist = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("downloaded blocklist is invalid: {error}")))?;
    cache::persist_verified_blocklist(cache_path, trust_store, envelope, Utc::now())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedBlocklistErrorCode {
    InvalidBlocklist,
    ExpiredBlocklist,
    BlocklistTooLarge,
    BlocklistDownloadFailed,
    BlocklistUnavailable,
    Trust(&'static str),
}

impl ManagedBlocklistErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidBlocklist => "MANAGED_BLOCKLIST_INVALID",
            Self::ExpiredBlocklist => "MANAGED_BLOCKLIST_EXPIRED",
            Self::BlocklistTooLarge => "MANAGED_BLOCKLIST_TOO_LARGE",
            Self::BlocklistDownloadFailed => "MANAGED_BLOCKLIST_DOWNLOAD_FAILED",
            Self::BlocklistUnavailable => "MANAGED_BLOCKLIST_UNAVAILABLE",
            Self::Trust(code) => code,
        }
    }
}

impl From<&'static str> for ManagedBlocklistErrorCode {
    fn from(code: &'static str) -> Self {
        Self::Trust(code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedBlocklistError {
    pub code: ManagedBlocklistErrorCode,
    pub message: String,
}

impl ManagedBlocklistError {
    fn new(code: impl Into<ManagedBlocklistErrorCode>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ManagedBlocklistError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ManagedBlocklistError {}

fn invalid(message: impl Into<String>) -> ManagedBlocklistError {
    ManagedBlocklistError::new(ManagedBlocklistErrorCode::InvalidBlocklist, message)
}

fn download_failed(message: impl Into<String>) -> ManagedBlocklistError {
    ManagedBlocklistError::new(ManagedBlocklistErrorCode::BlocklistDownloadFailed, message)
}

fn unavailable(message: impl Into<String>) -> ManagedBlocklistError {
    ManagedBlocklistError::new(ManagedBlocklistErrorCode::BlocklistUnavailable, message)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use chrono::TimeZone as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;

    fn verified_blocklist() -> VerifiedManagedBlocklist {
        let signing_key = SigningKey::from_bytes(&[9; 32]);
        let trust_store = ManagedTrustStore::new([TrustedIndexKey::new(
            "blocklist-test",
            signing_key.verifying_key().to_bytes(),
        )
        .expect("test key")]);
        let signed = ManagedProviderBlocklist {
            schema_version: 1,
            generated_at: Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap(),
            expires_at: Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap(),
            entries: vec![ManagedBlocklistEntry {
                provider_id: "acme-agent".into(),
                version_requirement: Some(">=1.2.0, <2.0.0".into()),
                archive_sha256: Some("aa".repeat(32)),
                reason: "publisher revoked compromised artifact".into(),
            }],
        };
        let bytes = signed.signing_bytes().expect("signing bytes");
        let envelope = SignedManagedProviderBlocklist {
            signed,
            signature: ManagedIndexSignature {
                algorithm: super::super::ManagedSignatureAlgorithm::Ed25519,
                key_id: "blocklist-test".into(),
                value: base64::engine::general_purpose::STANDARD
                    .encode(signing_key.sign(&bytes).to_bytes()),
            },
        };
        trust_store
            .verify_blocklist(
                envelope,
                Utc.with_ymd_and_hms(2026, 8, 25, 0, 0, 0).unwrap(),
            )
            .expect("valid blocklist")
    }

    #[test]
    fn matches_provider_version_and_artifact_together() {
        let blocklist = verified_blocklist();
        assert!(blocklist
            .blocked_reason("acme-agent", "1.2.3", &"aa".repeat(32))
            .unwrap()
            .is_some());
        assert!(blocklist
            .blocked_reason("acme-agent", "2.0.0", &"aa".repeat(32))
            .unwrap()
            .is_none());
        assert!(blocklist
            .blocked_reason("acme-agent", "1.2.3", &"bb".repeat(32))
            .unwrap()
            .is_none());
    }

    #[test]
    fn rejects_expired_policy_before_matching() {
        let signing_key = SigningKey::from_bytes(&[9; 32]);
        let trust_store = ManagedTrustStore::new([TrustedIndexKey::new(
            "blocklist-test",
            signing_key.verifying_key().to_bytes(),
        )
        .expect("test key")]);
        let signed = ManagedProviderBlocklist {
            schema_version: 1,
            generated_at: Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap(),
            expires_at: Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap(),
            entries: Vec::new(),
        };
        let bytes = signed.signing_bytes().unwrap();
        let envelope = SignedManagedProviderBlocklist {
            signed,
            signature: ManagedIndexSignature {
                algorithm: super::super::ManagedSignatureAlgorithm::Ed25519,
                key_id: "blocklist-test".into(),
                value: base64::engine::general_purpose::STANDARD
                    .encode(signing_key.sign(&bytes).to_bytes()),
            },
        };
        let error = trust_store
            .verify_blocklist(
                envelope,
                Utc.with_ymd_and_hms(2026, 8, 25, 0, 0, 0).unwrap(),
            )
            .expect_err("expired blocklist must fail");
        assert_eq!(error.code, ManagedBlocklistErrorCode::ExpiredBlocklist);
    }
}
