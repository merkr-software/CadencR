//! Bind newly persisted managed sessions to their publisher/source identity.
//! Existing raw IDs remain usable until an explicit signed namespace transfer.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::receipt::ManagedPackageReceipt;

const PREFIX: &str = "cadencr-managed-v1.";
const INCOMPATIBLE: &str = "MANAGED_SESSION_OWNER_CHANGED: This conversation belongs to a previous provider implementation. Its messages and native session are retained. Start a new conversation with the installed provider; saved-session compatibility has not been established.";

pub(crate) struct ManagedSessionScope {
    owner: String,
    require_bound_id: bool,
}

impl ManagedSessionScope {
    pub(crate) fn load(executable: &std::path::Path) -> Result<Option<Self>, String> {
        Ok(super::installer::session_receipt(executable)
            .map_err(|e| e.to_string())?
            .map(|receipt| Self::from_receipt(&receipt)))
    }

    fn from_receipt(receipt: &ManagedPackageReceipt) -> Self {
        let require_bound_id = match &receipt.signed_index {
            super::SignedProviderCatalog::Legacy(_) => false,
            super::SignedProviderCatalog::Mixed(index) => {
                index.signed.provider_handoffs.iter().any(|record| {
                    record.provider_id == receipt.agent.id
                        && record.to.publisher == receipt.publisher
                        && Some(record.to.repository.as_str())
                            == receipt.agent.repository.as_deref()
                })
            }
        };
        let owner = crate::shared::file_digest::sha256_hex(
            &cadencr_registry_core::canonical_json_bytes(&serde_json::json!([
                receipt.agent.id,
                receipt.publisher,
                receipt.agent.repository
            ])),
        );
        Self {
            owner,
            require_bound_id,
        }
    }

    pub(crate) fn owner(&self) -> Option<&str> {
        self.require_bound_id.then_some(self.owner.as_str())
    }

    pub(crate) fn bind(&self, native: &str) -> String {
        if !self.require_bound_id {
            return native.into();
        }
        format!("{PREFIX}{}.{}", self.owner, URL_SAFE_NO_PAD.encode(native))
    }

    pub(crate) fn native(&self, persisted: &str) -> Result<String, String> {
        if let Some(binding) = persisted.strip_prefix(PREFIX) {
            let (owner, encoded) = binding
                .split_once('.')
                .ok_or_else(|| INCOMPATIBLE.to_owned())?;
            if owner != self.owner {
                return Err(INCOMPATIBLE.into());
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| INCOMPATIBLE.to_owned())?;
            let native = String::from_utf8(bytes).map_err(|_| INCOMPATIBLE.to_owned())?;
            if native.is_empty() {
                return Err(INCOMPATIBLE.into());
            }
            return Ok(native);
        }
        if self.require_bound_id || persisted.is_empty() {
            return Err(INCOMPATIBLE.into());
        }
        Ok(persisted.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_never_forwards_raw_or_foreign_owner_ids_and_keeps_native_ids_lossless() {
        let previous = ManagedSessionScope {
            owner: "old".into(),
            require_bound_id: false,
        };
        let successor = ManagedSessionScope {
            owner: "new".into(),
            require_bound_id: true,
        };
        assert_eq!(previous.native("old-native-id").unwrap(), "old-native-id");
        assert!(successor
            .native("old-native-id")
            .unwrap_err()
            .contains("OWNER_CHANGED"));
        assert!(successor.native(&previous.bind("old-native-id")).is_err());
        for native in [
            "pidancr-v1.native-id",
            "a unicode session π",
            "cadencr-managed-v1.native",
        ] {
            assert_eq!(successor.native(&successor.bind(native)).unwrap(), native);
        }
        assert!(successor
            .native("cadencr-managed-v1.new.invalid!base64")
            .is_err());
    }
}
