use std::io::Read as _;
use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{invalid, ManagedCatalogError, ManagedCatalogErrorCode, MAX_CATALOG_BYTES};
use crate::domain::agents::providers::installed::managed::trust::{
    ManagedTrustStore, VerifiedManagedProviderIndex,
};
#[cfg(test)]
use crate::domain::agents::providers::installed::managed::SignedManagedProviderIndex;
use crate::domain::agents::providers::installed::managed::SignedProviderCatalog;

static CACHE_WRITE_LOCK: Mutex<()> = Mutex::new(());
// The on-disk wrapper adds `cached_at` and the `index` field around an envelope
// that is itself allowed to occupy MAX_CATALOG_BYTES.
const MAX_CACHED_CATALOG_BYTES: usize = MAX_CATALOG_BYTES + 128;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachedCatalog {
    cached_at: DateTime<Utc>,
    index: SignedProviderCatalog,
}

#[derive(Debug)]
pub(super) struct LoadedCatalog {
    pub cached_at: DateTime<Utc>,
    pub verified: VerifiedManagedProviderIndex,
}

pub(super) fn load(
    path: &Path,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
) -> Result<Option<LoadedCatalog>, ManagedCatalogError> {
    let Some(cached) = read(path)? else {
        return Ok(None);
    };
    verify(cached, trust, now).map(Some)
}

pub(super) fn persist(
    path: &Path,
    trust: &ManagedTrustStore,
    index: impl Into<SignedProviderCatalog>,
    now: DateTime<Utc>,
) -> Result<VerifiedManagedProviderIndex, ManagedCatalogError> {
    let index = index.into();
    let encoded_size = serde_json::to_vec(&CachedCatalog {
        cached_at: now,
        index: index.clone(),
    })
    .map_err(|error| invalid(error.to_string()))?
    .len();
    if encoded_size > MAX_CACHED_CATALOG_BYTES {
        return Err(ManagedCatalogError::new(
            ManagedCatalogErrorCode::TooLarge,
            "serialized managed provider catalog exceeds the cache limit",
        ));
    }
    let verified = trust
        .verify_index(index.clone())
        .map_err(|error| invalid(error.message))?;
    validate_freshness(&verified, now)?;
    let _guard = CACHE_WRITE_LOCK
        .lock()
        .map_err(|_| unavailable("catalog cache lock is poisoned"))?;
    if let Some(previous) = trusted_previous(path, trust) {
        let current_bytes = verified.signing_bytes();
        let previous_bytes = previous.signing_bytes();
        let current = verified.index();
        let previous = previous.index();
        if current.generated_at < previous.generated_at {
            return Err(invalid("refusing an older signed catalog publication"));
        }
        if current.generated_at == previous.generated_at && current_bytes != previous_bytes {
            return Err(invalid(
                "conflicting signed catalogs have the same publication time",
            ));
        }
        if current.generated_at > previous.generated_at {
            let prior = cadencr_registry_core::parse_json_bytes(previous_bytes)
                .map_err(|error| invalid(error.to_string()))?;
            let next = cadencr_registry_core::parse_json_bytes(current_bytes)
                .map_err(|error| invalid(error.to_string()))?;
            cadencr_registry_core::validate_catalog_continuity(&prior, &next)
                .map_err(|error| invalid(error.to_string()))?;
        }
    }
    let json = serde_json::to_string(&CachedCatalog {
        cached_at: now,
        index,
    })
    .map_err(|error| invalid(error.to_string()))?;
    if json.len() > MAX_CACHED_CATALOG_BYTES {
        return Err(ManagedCatalogError::new(
            ManagedCatalogErrorCode::TooLarge,
            "serialized managed provider catalog exceeds the cache limit",
        ));
    }
    crate::shared::atomic_file::write_atomic_private(path, &json)
        .map_err(|error| unavailable(format!("could not cache verified catalog: {error}")))?;
    Ok(verified)
}

fn verify(
    cached: CachedCatalog,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
) -> Result<LoadedCatalog, ManagedCatalogError> {
    let verified = trust
        .verify_index(cached.index)
        .map_err(|error| invalid(error.message))?;
    validate_freshness(&verified, now)?;
    Ok(LoadedCatalog {
        cached_at: cached.cached_at,
        verified,
    })
}

pub(super) fn revalidate(
    catalog: LoadedCatalog,
    now: DateTime<Utc>,
) -> Result<LoadedCatalog, ManagedCatalogError> {
    validate_freshness(&catalog.verified, now)?;
    Ok(catalog)
}

fn validate_freshness(
    index: &VerifiedManagedProviderIndex,
    now: DateTime<Utc>,
) -> Result<(), ManagedCatalogError> {
    super::super::validation::validate_publication_window(index.index(), now).map_err(|error| {
        let code = if now >= index.index().expires_at {
            ManagedCatalogErrorCode::Expired
        } else {
            ManagedCatalogErrorCode::Invalid
        };
        ManagedCatalogError::new(code, error.message)
    })
}

fn trusted_previous(
    path: &Path,
    trust: &ManagedTrustStore,
) -> Option<VerifiedManagedProviderIndex> {
    let cached = read(path).ok().flatten()?;
    trust.verify_index(cached.index).ok()
}

fn read(path: &Path) -> Result<Option<CachedCatalog>, ManagedCatalogError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(unavailable(format!(
                "could not read catalog cache: {error}"
            )))
        }
    };
    let mut bytes = Vec::new();
    file.take(MAX_CACHED_CATALOG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| unavailable(format!("could not read catalog cache: {error}")))?;
    if bytes.len() > MAX_CACHED_CATALOG_BYTES {
        return Err(ManagedCatalogError::new(
            ManagedCatalogErrorCode::TooLarge,
            "cached managed provider catalog exceeds 1 MiB",
        ));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        invalid(format!(
            "cached managed provider catalog is invalid: {error}"
        ))
    })
}

fn unavailable(message: impl Into<String>) -> ManagedCatalogError {
    ManagedCatalogError::new(ManagedCatalogErrorCode::Unavailable, message)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use chrono::Duration;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;

    fn trust() -> ManagedTrustStore {
        ManagedTrustStore::new([TrustedIndexKey::new(
            "catalog-test",
            SigningKey::from_bytes(&[41; 32]).verifying_key().to_bytes(),
        )
        .unwrap()])
    }

    fn signed(now: DateTime<Utc>) -> SignedManagedProviderIndex {
        let mut index: SignedManagedProviderIndex = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        index.signed.generated_at = now;
        index.signed.expires_at = now + Duration::hours(2);
        index.signature.key_id = "catalog-test".into();
        index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&index.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        index
    }

    #[test]
    fn signed_growing_history_above_one_mib_reloads_and_recommends() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        let now = Utc::now();
        let mut index = signed(now);
        let mut package = index.signed.packages[0].clone();
        package.agent.description = "x".repeat(10_000);
        index.signed.packages = (0..120)
            .map(|patch| {
                let mut value = package.clone();
                value.agent.version = format!("1.0.{patch}");
                value
            })
            .collect();
        index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&index.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(serde_json::to_vec(&index).unwrap().len() > 1024 * 1024);
        persist(&path, &trust(), index, now).unwrap();
        let loaded = load(&path, &trust(), now).unwrap().unwrap();
        let response =
            super::super::ManagedCatalogResponse::verified(&loaded.verified, false, None);
        assert_eq!(
            response
                .index
                .unwrap()
                .provider_view()
                .unwrap()
                .packages
                .len(),
            120
        );
        let platform = package
            .agent
            .distribution
            .as_ref()
            .unwrap()
            .binary
            .as_ref()
            .unwrap()
            .keys()
            .next()
            .unwrap();
        assert_eq!(
            super::super::recommendation::recommended_versions(
                &loaded.verified.index().packages,
                &package.host.compatibility.min_app_version,
                Some(platform)
            )
            .get(&package.agent.id)
            .map(String::as_str),
            Some("1.0.119")
        );
    }

    #[test]
    fn cache_rejects_expired_replayed_and_conflicting_catalogs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        let now = Utc::now();
        persist(&path, &trust(), signed(now), now).unwrap();

        assert_eq!(
            persist(&path, &trust(), signed(now - Duration::minutes(1)), now)
                .unwrap_err()
                .code,
            ManagedCatalogErrorCode::Invalid
        );
        let mut conflicting = signed(now);
        conflicting.signed.packages[0].agent.name = "Conflicting".into();
        conflicting.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&conflicting.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(persist(&path, &trust(), conflicting, now).is_err());
        assert_eq!(
            load(&path, &trust(), now + Duration::hours(3))
                .unwrap_err()
                .code,
            ManagedCatalogErrorCode::Expired
        );
    }

    #[test]
    fn corrupt_cache_can_be_repaired_by_a_verified_publication() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        std::fs::write(&path, "{broken").unwrap();
        let now = Utc::now();
        persist(&path, &trust(), signed(now), now).unwrap();
        assert!(load(&path, &trust(), now).unwrap().is_some());
    }

    #[test]
    fn cache_bound_includes_the_wrapper_around_a_maximum_envelope() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        let now = Utc::now();
        let mut index = signed(now);
        index.signed.packages[0].agent.description = String::new();
        let base_len = serde_json::to_vec(&index).unwrap().len();
        index.signed.packages[0].agent.description = "x".repeat(MAX_CATALOG_BYTES - base_len);
        assert_eq!(serde_json::to_vec(&index).unwrap().len(), MAX_CATALOG_BYTES);

        index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&index.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        persist(&path, &trust(), index.clone(), now).unwrap();
        let encoded = std::fs::read(&path).unwrap();
        assert!(encoded.len() > MAX_CATALOG_BYTES);
        assert!(encoded.len() <= MAX_CACHED_CATALOG_BYTES);
        assert!(load(&path, &trust(), now).unwrap().is_some());

        index.signed.generated_at += Duration::seconds(1);
        index.signed.packages[0]
            .agent
            .description
            .push_str(&"x".repeat(256));
        index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&index.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert_eq!(
            persist(&path, &trust(), index, now).unwrap_err().code,
            ManagedCatalogErrorCode::TooLarge
        );
        assert_eq!(std::fs::read(&path).unwrap(), encoded);

        let oversized = vec![b' '; MAX_CACHED_CATALOG_BYTES + 1];
        std::fs::write(&path, oversized).unwrap();
        let error = match read(&path) {
            Err(error) => error,
            Ok(_) => panic!("oversized cache should be rejected"),
        };
        assert_eq!(error.code, ManagedCatalogErrorCode::TooLarge);
    }

    #[test]
    fn reused_verified_fallback_is_fresh_at_response_time() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.json");
        let now = Utc::now();
        persist(&path, &trust(), signed(now), now).unwrap();
        let loaded = load(&path, &trust(), now).unwrap().unwrap();

        assert_eq!(
            revalidate(loaded, now + Duration::hours(3))
                .unwrap_err()
                .code,
            ManagedCatalogErrorCode::Expired
        );
    }
    fn mixed(now: DateTime<Utc>) -> crate::domain::themes::managed::models::SignedMixedCatalog {
        let mut value = serde_json::to_value(signed(now)).unwrap();
        value["signed"]["schema_version"] = serde_json::json!(2);
        value["signed"]["generated_at"] =
            serde_json::json!(now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        value["signed"]["expires_at"] = serde_json::json!(
            (now + Duration::hours(2)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        );
        let packages = value["signed"]["packages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|package| serde_json::json!({"kind":"provider","package":package}))
            .collect::<Vec<_>>();
        value["signed"]["packages"] = serde_json::json!(packages);
        let mut index: crate::domain::themes::managed::models::SignedMixedCatalog =
            serde_json::from_value(value).unwrap();
        resign_mixed(&mut index);
        index
    }
    fn resign_mixed(index: &mut crate::domain::themes::managed::models::SignedMixedCatalog) {
        let bytes = cadencr_registry_core::canonical_json_bytes(
            &serde_json::to_value(&index.signed).unwrap(),
        );
        index.signature.value = base64::engine::general_purpose::STANDARD
            .encode(SigningKey::from_bytes(&[41; 32]).sign(&bytes).to_bytes());
    }
    #[test]
    fn mixed_cache_and_api_preserve_full_signed_payload_and_provider_extensions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("catalog.json");
        let now = Utc::now();
        let index = mixed(now);
        let original = serde_json::to_value(&index).unwrap();
        persist(&path, &trust(), index.clone(), now).unwrap();
        persist(&path, &trust(), index, now).unwrap();
        let loaded = load(&path, &trust(), now).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(loaded.verified.envelope()).unwrap(),
            original
        );
        assert!(loaded.verified.index().packages[0]
            .agent
            .extra
            .contains_key("x-registry-note"));
        let response =
            super::super::ManagedCatalogResponse::verified(&loaded.verified, false, None);
        assert_eq!(
            serde_json::to_value(response.index.unwrap()).unwrap(),
            original
        );
        assert_eq!(
            response
                .recommended_versions
                .get("acme-agent")
                .map(String::as_str),
            Some("1.2.3")
        );
        let before = std::fs::read(&path).unwrap();
        assert!(persist(&path, &trust(), signed(now + Duration::seconds(2)), now).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(persist(&path, &trust(), mixed(now - Duration::seconds(1)), now).is_err());
        let mut owner = mixed(now + Duration::seconds(1));
        owner.signed.packages[0]["package"]["host"]["publisher"] = serde_json::json!("other");
        resign_mixed(&mut owner);
        assert!(persist(&path, &trust(), owner, now).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
