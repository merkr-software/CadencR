use super::archive::invalid;
use super::models::{ManagedThemeCatalogResponse, SignedMixedCatalog};
use super::storage;
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::error::AppError;
use chrono::Utc;
use serde_json::Value;
use std::collections::BTreeMap;

pub fn verify(
    index: &SignedMixedCatalog,
    trust: &ManagedTrustStore,
    allow_expired: bool,
) -> Result<(), AppError> {
    if index.signed.schema_version != 2 {
        return Err(invalid(
            "theme installation requires mixed catalog schema 2",
        ));
    }
    let payload = serde_json::to_value(&index.signed).map_err(invalid)?;
    let bytes =
        cadencr_registry_core::validate_signing_payload_at(&payload, allow_expired, Utc::now())
            .map_err(invalid)?;
    trust
        .verify_bytes(&bytes, &index.signature)
        .map_err(|error| {
            AppError::coded(
                axum::http::StatusCode::BAD_REQUEST,
                "REGISTRY_SIGNATURE_INVALID",
                error.to_string(),
            )
        })?;
    Ok(())
}
pub fn resolve(index: &SignedMixedCatalog, id: &str, version: &str) -> Result<Value, AppError> {
    let entry = index
        .signed
        .packages
        .iter()
        .find(|entry| {
            entry["kind"] == "theme"
                && entry["package"]["theme"]["id"] == id
                && entry["package"]["theme"]["version"] == version
        })
        .ok_or_else(|| invalid("theme version is absent from signed catalog"))?;
    ensure_compatible(&entry["package"])?;
    Ok(entry["package"].clone())
}
fn ensure_compatible(package: &Value) -> Result<(), AppError> {
    let compatibility = &package["host"]["compatibility"];
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(invalid)?;
    let minimum = compatibility["min_app_version"]
        .as_str()
        .ok_or_else(|| invalid("theme host minimum version missing"))?;
    let minimum = semver::Version::parse(minimum).map_err(invalid)?;
    let maximum = compatibility["max_app_version"]
        .as_str()
        .map(semver::Version::parse)
        .transpose()
        .map_err(invalid)?;
    if current < minimum || maximum.is_some_and(|maximum| current > maximum) {
        return Err(invalid("theme is incompatible with this host version"));
    }
    Ok(())
}
fn source() -> Option<&'static str> {
    option_env!("CADENCR_MANAGED_THEME_INDEX_URL").filter(|url| !url.is_empty())
}
fn cache() -> std::path::PathBuf {
    storage::root().join("catalog.json")
}
pub fn ingest(index: &SignedMixedCatalog) -> Result<(), AppError> {
    ingest_trusted(index, &pinned_index_trust_store())
}
fn ingest_trusted(index: &SignedMixedCatalog, trust: &ManagedTrustStore) -> Result<(), AppError> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK
        .lock()
        .map_err(|error| invalid(format!("theme catalog lock failed: {error}")))?;
    verify(index, trust, false)?;
    match storage::bounded_json::<SignedMixedCatalog>(&cache()) {
        Ok(previous) => {
            verify(&previous, trust, true)?;
            let earlier = chrono::DateTime::parse_from_rfc3339(&previous.signed.generated_at)
                .map_err(invalid)?;
            let incoming = chrono::DateTime::parse_from_rfc3339(&index.signed.generated_at)
                .map_err(invalid)?;
            let prior_payload = serde_json::to_value(&previous.signed).map_err(invalid)?;
            let incoming_payload = serde_json::to_value(&index.signed).map_err(invalid)?;
            if incoming < earlier || incoming == earlier && prior_payload != incoming_payload {
                return Err(invalid(
                    "theme catalog rollback or same-time equivocation rejected",
                ));
            }
            if incoming == earlier {
                // Both envelopes were authenticated above. Exact payload replay is
                // an idempotent admission, not a newly published catalog revision.
                return Ok(());
            }
            cadencr_registry_core::validate_catalog_continuity(&prior_payload, &incoming_payload)
                .map_err(invalid)?;
        }
        Err(error) => match cache().symlink_metadata() {
            Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(error),
            Err(inspect) => {
                return Err(invalid(format!(
                    "cannot inspect theme catalog high-water cache: {inspect}"
                )))
            }
        },
    }
    storage::secure(&storage::root())?;
    crate::shared::atomic_file::write_atomic_private(
        &cache(),
        &serde_json::to_string(index).map_err(invalid)?,
    )
}
pub async fn acquire(refresh: bool) -> ManagedThemeCatalogResponse {
    let policy_error = super::policy::refresh(refresh)
        .await
        .err()
        .map(|error| error.to_string());
    let (result, refresh_error) = match acquire_inner(refresh).await {
        Ok(index) => (Ok(index), None),
        Err(error) => {
            match storage::bounded_json::<SignedMixedCatalog>(&cache()).and_then(|index| {
                verify(&index, &pinned_index_trust_store(), false)?;
                Ok(index)
            }) {
                Ok(index) => (Ok(index), Some(error.to_string())),
                Err(cache_error) => (
                    Err(invalid(format!(
                        "{error}; verified cache unavailable: {cache_error}"
                    ))),
                    None,
                ),
            }
        }
    };
    match result {
        Ok(index) => {
            let recommended_versions = recommended_versions(&index);
            ManagedThemeCatalogResponse {
                index: Some(index),
                recommended_versions,
                verified: true,
                error: match (refresh_error, policy_error) {
                    (Some(catalog), Some(policy)) => Some(format!("{catalog}; {policy}")),
                    (catalog, policy) => catalog.or(policy),
                },
            }
        }
        Err(error) => ManagedThemeCatalogResponse {
            index: None,
            recommended_versions: Default::default(),
            verified: false,
            error: Some(error.to_string()),
        },
    }
}
fn recommended_versions(index: &SignedMixedCatalog) -> BTreeMap<String, String> {
    let mut recommended: BTreeMap<&str, (&str, semver::Version)> = BTreeMap::new();
    for entry in &index.signed.packages {
        if entry["kind"] != "theme" || ensure_compatible(&entry["package"]).is_err() {
            continue;
        }
        let (Some(id), Some(version)) = (
            entry["package"]["theme"]["id"].as_str(),
            entry["package"]["theme"]["version"].as_str(),
        ) else {
            continue;
        };
        let Ok(candidate) = semver::Version::parse(version) else {
            continue;
        };
        if recommended.get(id).is_none_or(|(_, current)| {
            (candidate.pre.is_empty() && !current.pre.is_empty())
                || (candidate.pre.is_empty() == current.pre.is_empty() && candidate > *current)
        }) {
            recommended.insert(id, (version, candidate));
        }
    }
    recommended
        .into_iter()
        .map(|(id, (version, _))| (id.into(), version.into()))
        .collect()
}
async fn acquire_inner(refresh: bool) -> Result<SignedMixedCatalog, AppError> {
    let trust = pinned_index_trust_store();
    storage::secure(&storage::root())?;
    let cached = storage::bounded_json::<SignedMixedCatalog>(&cache()).and_then(|index| {
        verify(&index, &trust, false)?;
        Ok(index)
    });
    let cached = match cached {
        Ok(index) if !refresh => return Ok(index),
        cached => cached,
    };
    let Some(url) = source() else {
        return match cached {
            Ok(index) => Ok(index),
            Err(error) if cache().exists() => Err(error),
            Err(_) => Err(invalid("theme catalog source is not configured")),
        };
    };
    let bytes = download(url, cadencr_registry_core::MAX_CATALOG_BYTES).await?;
    let index = serde_json::from_slice(&bytes).map_err(invalid)?;
    ingest(&index)?;
    Ok(index)
}
pub use super::download::{download, download_archive};

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};
    pub(crate) fn signed() -> (SignedMixedCatalog, ManagedTrustStore) {
        let now = Utc::now();
        let payload = serde_json::json!({"schema_version":2,"generated_at":(now-chrono::Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),"expires_at":(now+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),"packages":[{"kind":"theme","package":{"theme":{"id":"midnight","name":"Midnight","description":"Dark theme","version":"1.0.0","repository":"https://github.com/acme/themes","license":"MIT","document_version":1,"distribution":{"archive":"https://github.com/acme/themes/releases/download/v1/theme.tar.gz","sha256":"a".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}}]});
        let key = SigningKey::from_bytes(&[19; 32]);
        let bytes =
            cadencr_registry_core::validate_signing_payload_at(&payload, false, now).unwrap();
        let envelope = serde_json::json!({"signed":payload,"signature":{"algorithm":"ed25519","key_id":"test","value":base64::engine::general_purpose::STANDARD.encode(key.sign(&bytes).to_bytes())}});
        (
            serde_json::from_value(envelope).unwrap(),
            ManagedTrustStore::new([
                TrustedIndexKey::new("test", key.verifying_key().to_bytes()).unwrap()
            ]),
        )
    }
    #[test]
    fn signed_mixed_catalog_rejects_tampering_unknown_keys_expiry_and_acp_payloads() {
        let (index, trust) = signed();
        verify(&index, &trust, false).unwrap();
        assert!(resolve(&index, "midnight", "1.0.0").is_ok());
        assert!(verify(&index, &ManagedTrustStore::default(), false).is_err());
        let mut tampered = index.clone();
        tampered.signed.packages[0]["package"]["theme"]["name"] = serde_json::json!("tampered");
        assert!(verify(&tampered, &trust, false).is_err());
        let mut expired = index.clone();
        expired.signed.expires_at = (Utc::now() - chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        assert!(verify(&expired, &trust, false).is_err());
        let mut acp = index;
        acp.signed.packages[0]["package"]["theme"]["command"] = serde_json::json!("evil");
        assert!(verify(&acp, &trust, false).is_err());
    }
    #[test]
    fn recommendation_ignores_provider_entries_and_prefers_compatible_stable_versions() {
        let (mut index, _) = signed();
        let template = index.signed.packages[0].clone();
        index.signed.packages.clear();
        for n in 0..1_000 {
            index
                .signed
                .packages
                .push(serde_json::json!({"kind":"provider", "package":{"id":n}}));
        }
        for version in ["1.0.0", "2.0.0-beta.1", "1.5.0", "1.4.0", "3.0.0"] {
            let mut entry = template.clone();
            entry["package"]["theme"]["version"] = version.into();
            if version == "3.0.0" {
                entry["package"]["host"]["compatibility"]["min_app_version"] = "999.0.0".into();
            }
            index.signed.packages.push(entry);
        }
        let recommendations = recommended_versions(&index);
        assert_eq!(recommendations.len(), 1);
        assert_eq!(recommendations.values().next().unwrap(), "1.5.0");
    }
    #[test]
    fn exact_authenticated_replay_is_idempotent_but_equivocation_and_rollback_are_rejected() {
        let (index, trust) = signed();
        ingest_trusted(&index, &trust).unwrap();
        let before = std::fs::read(cache()).unwrap();
        let modified = std::fs::metadata(cache()).unwrap().modified().unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt as _;
            std::fs::metadata(cache()).unwrap().ino()
        };
        ingest_trusted(&index, &trust).unwrap();
        assert_eq!(std::fs::read(cache()).unwrap(), before);
        assert_eq!(
            std::fs::metadata(cache()).unwrap().modified().unwrap(),
            modified
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            assert_eq!(std::fs::metadata(cache()).unwrap().ino(), inode);
        }
        let key = SigningKey::from_bytes(&[19; 32]);
        for rollback in [false, true] {
            let mut conflicting = index.clone();
            if rollback {
                let earlier = chrono::DateTime::parse_from_rfc3339(&index.signed.generated_at)
                    .unwrap()
                    - chrono::Duration::seconds(1);
                conflicting.signed.generated_at =
                    earlier.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            } else {
                conflicting.signed.packages[0]["package"]["theme"]["name"] =
                    "Conflicting name".into();
            }
            conflicting.signature.value = base64::engine::general_purpose::STANDARD.encode(
                key.sign(&cadencr_registry_core::canonical_json_bytes(
                    &serde_json::to_value(&conflicting.signed).unwrap(),
                ))
                .to_bytes(),
            );
            verify(&conflicting, &trust, false).unwrap();
            assert!(ingest_trusted(&conflicting, &trust).is_err());
            assert_eq!(std::fs::read(cache()).unwrap(), before);
        }
        let mut unauthenticated = index.clone();
        unauthenticated.signature.value = "invalid".into();
        assert!(ingest_trusted(&unauthenticated, &trust).is_err());
        let mut expired = index;
        expired.signed.generated_at = (Utc::now() - chrono::Duration::hours(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        expired.signed.expires_at = (Utc::now() - chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        expired.signature.value = base64::engine::general_purpose::STANDARD.encode(
            key.sign(&cadencr_registry_core::canonical_json_bytes(
                &serde_json::to_value(&expired.signed).unwrap(),
            ))
            .to_bytes(),
        );
        verify(&expired, &trust, true).unwrap();
        let expired_bytes = serde_json::to_string(&expired).unwrap();
        crate::shared::atomic_file::write_atomic_private(&cache(), &expired_bytes).unwrap();
        assert!(
            ingest_trusted(&expired, &trust).is_err(),
            "exact replay must still be current"
        );
        assert_eq!(std::fs::read_to_string(cache()).unwrap(), expired_bytes);
    }
    #[test]
    fn cached_signed_history_rejects_same_version_mutation_and_removal() {
        let (index, trust) = signed();
        ingest_trusted(&index, &trust).unwrap();
        let key = SigningKey::from_bytes(&[19; 32]);
        for mutate in [false, true] {
            let mut newer = index.clone();
            newer.signed.generated_at =
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            if mutate {
                newer.signed.packages[0]["package"]["theme"]["distribution"]["sha256"] =
                    "b".repeat(64).into();
            } else {
                newer.signed.packages.clear();
            }
            newer.signature.value = base64::engine::general_purpose::STANDARD.encode(
                key.sign(&cadencr_registry_core::canonical_json_bytes(
                    &serde_json::to_value(&newer.signed).unwrap(),
                ))
                .to_bytes(),
            );
            assert!(ingest_trusted(&newer, &trust).is_err());
            let retained: SignedMixedCatalog = storage::bounded_json(&cache()).unwrap();
            assert_eq!(
                serde_json::to_value(retained.signed).unwrap(),
                serde_json::to_value(&index.signed).unwrap()
            );
        }
        #[cfg(unix)]
        {
            std::fs::rename(cache(), cache().with_extension("saved")).unwrap();
            std::os::unix::fs::symlink(storage::root().join("missing-catalog"), cache()).unwrap();
            assert!(ingest_trusted(&index, &trust).is_err());
            assert!(cache().symlink_metadata().unwrap().file_type().is_symlink());
        }
    }
}
