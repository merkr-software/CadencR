use super::*;
use cadencr_registry_core::{
    decode_registry_public_key, verify_registry_trust_manifest, VerifiedRegistryTrust,
};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

mod recovery;
mod state;

pub use recovery::{set_aside_registry_trust_generation, SetAsideGeneration};

#[derive(Debug, Clone)]
pub enum PinnedIndexTrustStatus {
    Unconfigured,
    Configured {
        key: TrustedIndexKey,
    },
    Generation {
        trust: ManagedTrustStore,
    },
    Invalid {
        code: &'static str,
        message: String,
        recovery: TrustRecovery,
    },
}

/// What a user can do about an unusable trust configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustRecovery {
    /// This build's compiled trust is broken: install an official build.
    Reinstall,
    /// The data directory trusts a newer generation than this build knows:
    /// update Cadencr. The stored generation is never set aside for this,
    /// since it is what refuses a rollback to older keys.
    UpdateApp,
    /// The stored generation file is unreadable or invalid: it can be set
    /// aside (renamed, kept) and rebuilt from this build's trust.
    SetAside { path: PathBuf },
    /// Something around the file needs fixing by hand; the message names it.
    Repair,
}

/// Set once at startup, replaced only by a user-confirmed recovery.
static STATUS: RwLock<Option<PinnedIndexTrustStatus>> = RwLock::new(None);

pub fn pinned_index_trust_store() -> ManagedTrustStore {
    store_for(pinned_index_trust_status())
}
fn store_for(status: PinnedIndexTrustStatus) -> ManagedTrustStore {
    match status {
        PinnedIndexTrustStatus::Configured { key } => ManagedTrustStore::new([key]),
        PinnedIndexTrustStatus::Generation { trust } => trust,
        PinnedIndexTrustStatus::Unconfigured => ManagedTrustStore::default(),
        PinnedIndexTrustStatus::Invalid { message, .. } => ManagedTrustStore {
            unusable: Some(message.into()),
            ..ManagedTrustStore::default()
        },
    }
}
pub fn pinned_index_trust_status() -> PinnedIndexTrustStatus {
    let status = match STATUS.read() {
        Ok(status) => status.clone(),
        Err(_) => {
            return invalid_with(
                "registry trust status lock is poisoned; restart Cadencr",
                TrustRecovery::Repair,
            )
        }
    };
    status.unwrap_or_else(|| {
        invalid("registry trust must be initialized against its durable generation before use")
    })
}
fn generation_path() -> PathBuf {
    crate::domain::settings_store::dir::data_sibling_dir("registry-trust").join("generation.json")
}
/// This build's trust, held against the data directory's stored generation.
fn resolve(path: &Path) -> PinnedIndexTrustStatus {
    let status = compiled_status();
    match (&status, root_configuration()) {
        (PinnedIndexTrustStatus::Generation { trust }, Ok(Some((root, id)))) => {
            let profile = trust.profile.as_ref().expect("generation profile");
            match state::advance(path, profile, &root, id) {
                Ok(()) => status,
                Err(failure) => failure.status(path),
            }
        }
        _ => match path.symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => status,
            Ok(_) => invalid_with(
                "This data directory requires a root-authorized registry trust generation; update Cadencr.",
                TrustRecovery::UpdateApp,
            ),
            Err(error) => invalid_with(
                format!("Cannot inspect registry trust generation: {error}"),
                TrustRecovery::Repair,
            ),
        },
    }
}

/// Run before installed-provider startup scans. All filesystem work is off the async worker.
pub async fn initialize_pinned_registry_trust() -> Result<(), crate::error::AppError> {
    let path = generation_path();
    let status = tokio::task::spawn_blocking(move || resolve(&path))
        .await
        .map_err(|error| {
            crate::error::AppError::internal(format!(
                "registry trust initialization failed: {error}"
            ))
        })?;
    let mut slot = STATUS
        .write()
        .map_err(|_| crate::error::AppError::internal("registry trust status lock is poisoned"))?;
    if slot.is_some() {
        return Err(crate::error::AppError::internal(
            "registry trust was used before startup initialization",
        ));
    }
    *slot = Some(status);
    Ok(())
}

fn compiled_status() -> PinnedIndexTrustStatus {
    match root_configuration() {
        Ok(Some((root, id))) => {
            let Some(manifest) =
                option_env!("CADENCR_REGISTRY_TRUST_MANIFEST_JSON").filter(|s| !s.is_empty())
            else {
                return invalid("registry trust manifest must accompany the offline root pin");
            };
            let minimum = option_env!("CADENCR_REGISTRY_TRUST_MIN_GENERATION")
                .unwrap_or("1")
                .parse::<u64>();
            let minimum = match minimum {
                Ok(value) if value > 0 => value,
                _ => return invalid("registry minimum trust generation is invalid"),
            };
            match verify_registry_trust_manifest()
                .bytes(manifest.as_bytes())
                .root_public_key(&root)
                .root_key_id(id)
                .minimum_generation(minimum)
                .call()
                .map_err(|e| e.to_string())
                .and_then(|profile| {
                    ManagedTrustStore::from_registry_trust(profile).map_err(|e| e.to_string())
                }) {
                Ok(trust) => PinnedIndexTrustStatus::Generation { trust },
                Err(error) => invalid(error),
            }
        }
        Ok(None)
            if option_env!("CADENCR_REGISTRY_TRUST_MANIFEST_JSON")
                .is_some_and(|s| !s.is_empty()) =>
        {
            invalid("registry trust manifest requires independent offline root pins")
        }
        Ok(None) => pinned_index_trust_status_from(
            option_env!("CADENCR_MANAGED_PROVIDER_KEY_ID"),
            option_env!("CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64"),
        ),
        Err(error) => invalid(error),
    }
}
fn root_configuration() -> Result<Option<([u8; 32], &'static str)>, String> {
    match (
        option_env!("CADENCR_REGISTRY_ROOT_KEY_ID").filter(|s| !s.is_empty()),
        option_env!("CADENCR_REGISTRY_ROOT_PUBLIC_KEY_BASE64").filter(|s| !s.is_empty()),
    ) {
        (None, None) => Ok(None),
        (Some(id), Some(key)) => decode_registry_public_key(key)
            .map(|key| Some((key, id)))
            .map_err(|e| e.to_string()),
        _ => Err("registry root key id and public key must be compiled in together".into()),
    }
}
pub(super) fn pinned_index_trust_status_from(
    key_id: Option<&str>,
    public_key: Option<&str>,
) -> PinnedIndexTrustStatus {
    match (key_id, public_key) {
        (None, None) => PinnedIndexTrustStatus::Unconfigured,
        (Some(id), Some(key)) => match TrustedIndexKey::from_base64(id, key) {
            Ok(key) => PinnedIndexTrustStatus::Configured { key },
            Err(error) => invalid(error),
        },
        _ => invalid("managed-provider key id and public key must be compiled in together"),
    }
}
/// A build whose compiled trust cannot be used.
fn invalid(message: impl fmt::Display) -> PinnedIndexTrustStatus {
    invalid_with(message, TrustRecovery::Reinstall)
}
fn invalid_with(message: impl fmt::Display, recovery: TrustRecovery) -> PinnedIndexTrustStatus {
    PinnedIndexTrustStatus::Invalid {
        code: "PINNED_TRUST_CONFIGURATION_INVALID",
        message: message.to_string(),
        recovery,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invalid_trust_configuration_reports_its_cause_not_an_empty_keyring() {
        let status = pinned_index_trust_status_from(Some("registry-1"), None);
        let PinnedIndexTrustStatus::Invalid { message, .. } = &status else {
            panic!("a key id without its public key is invalid: {status:?}");
        };
        let cause = message.clone();
        let signature: ManagedIndexSignature = serde_json::from_value(serde_json::json!({
            "algorithm": "ed25519", "key_id": "registry-1", "value": ""
        }))
        .unwrap();
        let error = store_for(status)
            .verify_bytes(b"{}", &signature)
            .unwrap_err();
        assert_eq!(error.code.as_str(), "PINNED_TRUST_CONFIGURATION_INVALID");
        assert!(error.message.contains(&cause), "{}", error.message);
        // The shared catalog reports the same cause, not a bad signature.
        let (catalog, _) = crate::domain::marketplace::catalog::tests::signed();
        let invalid = store_for(pinned_index_trust_status_from(Some("registry-1"), None));
        assert!(matches!(
            crate::domain::marketplace::catalog::verify(&catalog, &invalid, false),
            Err(crate::error::AppError::Coded {
                code: "PINNED_TRUST_CONFIGURATION_INVALID",
                ..
            })
        ));
        // A build that pins nothing still says so.
        let error = store_for(PinnedIndexTrustStatus::Unconfigured)
            .verify_bytes(b"{}", &signature)
            .unwrap_err();
        assert_eq!(error.code.as_str(), "TRUST_NOT_CONFIGURED");
    }
}
