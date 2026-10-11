use super::*;
use cadencr_registry_core::{
    decode_registry_public_key, verify_registry_trust_manifest, VerifiedRegistryTrust,
};
use std::sync::OnceLock;

mod state;

#[derive(Debug, Clone)]
pub enum PinnedIndexTrustStatus {
    Unconfigured,
    Configured { key: TrustedIndexKey },
    Generation { trust: ManagedTrustStore },
    Invalid { code: &'static str, message: String },
}

static STATUS: OnceLock<PinnedIndexTrustStatus> = OnceLock::new();

pub fn pinned_index_trust_store() -> ManagedTrustStore {
    match pinned_index_trust_status() {
        PinnedIndexTrustStatus::Configured { key } => ManagedTrustStore::new([key]),
        PinnedIndexTrustStatus::Generation { trust } => trust,
        PinnedIndexTrustStatus::Unconfigured | PinnedIndexTrustStatus::Invalid { .. } => {
            ManagedTrustStore::default()
        }
    }
}
pub fn pinned_index_trust_status() -> PinnedIndexTrustStatus {
    STATUS.get().cloned().unwrap_or_else(|| {
        invalid("registry trust must be initialized against its durable generation before use")
    })
}

/// Run before installed-provider startup scans. All filesystem work is off the async worker.
pub async fn initialize_pinned_registry_trust() -> Result<(), crate::error::AppError> {
    let path =
        crate::domain::settings_store::dir::sibling_dir("registry-trust").join("generation.json");
    let status = tokio::task::spawn_blocking(move || {
        let status = compiled_status();
        match (&status, root_configuration()) {
            (PinnedIndexTrustStatus::Generation { trust }, Ok(Some((root, id)))) => {
                match state::advance(&path, trust.profile.as_ref().expect("generation profile"), &root, id) {
                    Ok(()) => status,
                    Err(error) => invalid(error),
                }
            }
            _ => match path.symlink_metadata() {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => status,
                Ok(_) => invalid("This data directory requires a root-authorized registry trust generation; update Cadencr."),
                Err(error) => invalid(format!("Cannot inspect registry trust generation: {error}")),
            },
        }
    }).await.map_err(|error| crate::error::AppError::Internal(format!("registry trust initialization failed: {error}")))?;
    STATUS.set(status).map_err(|_| {
        crate::error::AppError::Internal(
            "registry trust was used before startup initialization".into(),
        )
    })
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
fn invalid(message: impl fmt::Display) -> PinnedIndexTrustStatus {
    PinnedIndexTrustStatus::Invalid {
        code: "PINNED_TRUST_CONFIGURATION_INVALID",
        message: message.to_string(),
    }
}
