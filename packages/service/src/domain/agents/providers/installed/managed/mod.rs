//! Versioned, signed package metadata for managed provider installations.
//!
//! This module defines and admits data from a host-trusted signed index. Its
//! lifecycle service downloads, extracts, verifies, probes, activates, and
//! guards immutable provider packages without adding provider-specific code.
//! The portable [`AcpAgentEntry`] remains lossless; Cadencr-owned compatibility
//! and package assets live in the strict host envelope beside it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::descriptor::AcpAgentEntry;

pub mod archive;
pub mod blocklist;
pub mod conformance;
pub mod download;
mod error;
pub mod history;
pub mod installer;
pub mod process_policy;
pub mod quarantine;
pub mod receipt;
pub mod routes;
pub mod service;
pub mod trust;
mod validation;

pub use error::{ManagedContractError, ManagedContractErrorCode};

/// Managed index schema understood by this build.
pub const MANAGED_INDEX_SCHEMA_VERSION: u32 = 1;

/// A detached signature over [`ManagedProviderIndex::signing_bytes`].
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SignedManagedProviderIndex {
    /// The exact payload covered by `signature`.
    pub signed: ManagedProviderIndex,
    pub signature: ManagedIndexSignature,
}

/// The deterministic payload covered by an index signature.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedProviderIndex {
    pub schema_version: u32,
    pub packages: Vec<ManagedProviderPackage>,
}

/// One versioned provider package in the signed index.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedProviderPackage {
    /// Lossless ACP Registry v1 payload.
    pub agent: AcpAgentEntry,
    /// Cadencr-only host and package policy.
    pub host: ManagedProviderHost,
}

/// Strict host metadata that must never be moved into the portable ACP entry.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedProviderHost {
    /// Stable registry publisher identity. Signature trust is resolved from the
    /// index key separately; this field records who owns the package entry.
    pub publisher: String,
    pub compatibility: ManagedAppCompatibility,
    pub assets: ManagedPackageAssets,
}

/// Inclusive Cadencr application compatibility bounds.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedAppCompatibility {
    pub min_app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_app_version: Option<String>,
}

/// Package-owned files, all relative to the extracted package root.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedPackageAssets {
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

/// Detached index signature. Cryptographic verification is intentionally a
/// caller concern; contract validation only validates this envelope's shape.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedIndexSignature {
    pub algorithm: ManagedSignatureAlgorithm,
    pub key_id: String,
    /// Standard padded base64. Ed25519 signatures decode to exactly 64 bytes.
    pub value: String,
}

/// Algorithms accepted by index schema v1.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ManagedSignatureAlgorithm {
    Ed25519,
}

/// Exact, host-compatible binary selected from a validated package entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedManagedProviderPackage {
    pub provider_id: String,
    pub provider_version: String,
    pub publisher: String,
    pub platform: String,
    pub archive: String,
    pub archive_sha256: String,
    pub executable: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub assets: ManagedPackageAssets,
}

impl SignedManagedProviderIndex {
    /// Validate the versioned index and detached-signature envelope.
    ///
    /// This does not establish trust. The managed index ingester verifies
    /// `signature` against [`ManagedProviderIndex::signing_bytes`] with a
    /// compiled or otherwise trusted public key before using the packages.
    pub fn validate_contract(&self) -> Result<(), ManagedContractError> {
        validation::validate_signed_index(self)
    }

    /// Resolve one exact provider/version for the running OS and architecture.
    pub fn resolve_current_platform(
        &self,
        provider_id: &str,
        provider_version: &str,
        app_version: &str,
    ) -> Result<ResolvedManagedProviderPackage, ManagedContractError> {
        validation::resolve_current_platform(self, provider_id, provider_version, app_version)
    }
}

impl ManagedProviderIndex {
    /// Canonical compact JSON bytes covered by the detached signature.
    ///
    /// Object keys are sorted recursively and package order is validated, so
    /// equivalent parsed inputs always produce identical signing bytes.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&canonical_json(serde_json::to_value(self)?))
    }
}

fn canonical_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(canonical_json).collect())
        }
        serde_json::Value::Object(values) => {
            let sorted: BTreeMap<_, _> = values
                .into_iter()
                .map(|(key, value)| (key, canonical_json(value)))
                .collect();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        scalar => scalar,
    }
}

#[cfg(test)]
mod tests {
    use super::{ManagedContractErrorCode, SignedManagedProviderIndex};
    use serde_json::Value;

    const VALID_INDEX: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/managed_provider_index/v1/valid.json"
    ));
    const SIGNING_BYTES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/managed_provider_index/v1/valid.signing.json"
    ));

    fn valid_index() -> SignedManagedProviderIndex {
        serde_json::from_str(VALID_INDEX).expect("managed-index fixture should deserialize")
    }

    #[test]
    fn fixture_validates_and_has_stable_signing_bytes() {
        let index = valid_index();
        index.validate_contract().expect("valid managed index");
        let bytes = index.signed.signing_bytes().expect("canonical JSON");
        assert_eq!(bytes, SIGNING_BYTES.trim_end().as_bytes());
    }

    #[test]
    fn canonical_bytes_ignore_json_object_input_order() {
        let original = valid_index();
        let mut value: Value = serde_json::from_str(VALID_INDEX).expect("fixture JSON");
        let agent = value
            .pointer_mut("/signed/packages/0/agent")
            .and_then(Value::as_object_mut)
            .expect("agent object");
        let id = agent.remove("id").expect("id");
        agent.insert("id".into(), id);
        let reordered: SignedManagedProviderIndex =
            serde_json::from_value(value).expect("reordered fixture");

        assert_eq!(
            original.signed.signing_bytes().expect("original bytes"),
            reordered.signed.signing_bytes().expect("reordered bytes")
        );
    }

    #[test]
    fn portable_registry_extensions_round_trip_losslessly() {
        let original = valid_index();
        let note = original.signed.packages[0].agent.extra["x-registry-note"].clone();
        let reparsed: SignedManagedProviderIndex = serde_json::from_slice(
            &serde_json::to_vec(&original).expect("serialize managed index"),
        )
        .expect("reparse managed index");
        assert_eq!(
            reparsed.signed.packages[0].agent.extra["x-registry-note"],
            note
        );
    }

    #[test]
    fn host_envelope_rejects_unknown_fields() {
        let mut value: Value = serde_json::from_str(VALID_INDEX).expect("fixture JSON");
        value["signed"]["packages"][0]["host"]["credentials"] = Value::String("never".into());
        let error = serde_json::from_value::<SignedManagedProviderIndex>(value)
            .expect_err("unknown host policy must fail closed");
        assert!(error.to_string().contains("unknown field `credentials`"));
    }

    #[test]
    fn package_resolution_is_exact_and_compatible() {
        let index = valid_index();
        let resolved = index
            .resolve_current_platform("acme-agent", "1.2.3", "0.12.0")
            .expect("fixture supports this build platform");
        assert_eq!(resolved.provider_id, "acme-agent");
        assert_eq!(resolved.provider_version, "1.2.3");
        assert_eq!(resolved.archive_sha256, "a".repeat(64));
        assert_eq!(resolved.executable, "bin/acme-agent");
        assert_eq!(resolved.assets.icon, "assets/icon.svg");

        let error = index
            .resolve_current_platform("acme-agent", "1.2.4", "0.12.0")
            .expect_err("version lookup must not float");
        assert_eq!(error.code, ManagedContractErrorCode::PackageNotFound);
    }
}
