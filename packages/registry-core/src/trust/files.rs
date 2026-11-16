use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::{
    invalid, verify_registry_trust_manifest, VerifiedRegistryTrust, MAX_TRUST_MANIFEST_BYTES,
};

/// Root/profile inputs are host-owned publication configuration, never package-supplied.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryTrustFiles {
    pub manifest: PathBuf,
    pub root_public_key: PathBuf,
    pub root_key_id: String,
    #[serde(default = "initial_generation")]
    pub minimum_generation: u64,
}

fn initial_generation() -> u64 {
    1
}

impl RegistryTrustFiles {
    pub fn load(&self) -> Result<VerifiedRegistryTrust, crate::RegistryError> {
        let bytes = crate::safe_io::read_bounded_regular(&self.manifest, MAX_TRUST_MANIFEST_BYTES)
            .map_err(|e| invalid(format!("cannot read trust manifest: {e}")))?;
        let public = crate::safe_io::read_bounded_regular(&self.root_public_key, 16 * 1024)
            .map_err(|e| invalid(format!("cannot read offline root public key: {e}")))?;
        self.load_bytes(&bytes, &public)
    }
    /// Verify already captured immutable publication inputs, without reopening paths.
    pub fn load_bytes(
        &self,
        bytes: &[u8],
        public: &[u8],
    ) -> Result<VerifiedRegistryTrust, crate::RegistryError> {
        if public.len() > 16 * 1024 {
            return Err(invalid("offline root public key exceeds byte limit"));
        }
        let key = crate::signing::parse_public_key(public)?;
        verify_registry_trust_manifest()
            .bytes(bytes)
            .root_public_key(key.as_bytes())
            .root_key_id(&self.root_key_id)
            .minimum_generation(self.minimum_generation)
            .call()
    }
    pub fn relative_to(&self, base: &Path) -> Self {
        Self {
            manifest: base.join(&self.manifest),
            root_public_key: base.join(&self.root_public_key),
            root_key_id: self.root_key_id.clone(),
            minimum_generation: self.minimum_generation,
        }
    }
}
