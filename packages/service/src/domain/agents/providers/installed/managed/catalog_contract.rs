//! Original signed wire envelope plus a post-verification provider-only view.
//! The view is never serialized, signed, cached, or retained as proof.
use super::{ManagedProviderIndex, ManagedProviderPackage, SignedManagedProviderIndex};
use crate::domain::themes::managed::models::SignedMixedCatalog;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(untagged)]
pub enum SignedProviderCatalog {
    Legacy(SignedManagedProviderIndex),
    Mixed(SignedMixedCatalog),
}
impl From<SignedManagedProviderIndex> for SignedProviderCatalog {
    fn from(value: SignedManagedProviderIndex) -> Self {
        Self::Legacy(value)
    }
}
impl From<SignedMixedCatalog> for SignedProviderCatalog {
    fn from(value: SignedMixedCatalog) -> Self {
        Self::Mixed(value)
    }
}
impl SignedProviderCatalog {
    #[cfg(test)]
    pub(super) fn legacy_mut(&mut self) -> &mut SignedManagedProviderIndex {
        match self {
            Self::Legacy(index) => index,
            Self::Mixed(_) => panic!("legacy test fixture required"),
        }
    }
    pub fn payload_value(&self) -> Result<Value, serde_json::Error> {
        match self {
            Self::Legacy(index) => serde_json::to_value(&index.signed),
            Self::Mixed(index) => serde_json::to_value(&index.signed),
        }
    }
    pub fn schema_version(&self) -> u32 {
        match self {
            Self::Legacy(index) => index.signed.schema_version,
            Self::Mixed(index) => index.signed.schema_version,
        }
    }
    /// Metadata view only. Callers must establish signature trust first.
    pub(super) fn provider_view(&self) -> Result<ManagedProviderIndex, String> {
        match self {
            Self::Legacy(index) => Ok(index.signed.clone()),
            Self::Mixed(index) => {
                let generated_at = timestamp(&index.signed.generated_at)?;
                let expires_at = timestamp(&index.signed.expires_at)?;
                let packages = index
                    .signed
                    .packages
                    .iter()
                    .filter(|entry| entry["kind"] == "provider")
                    .map(|entry| {
                        serde_json::from_value::<ManagedProviderPackage>(entry["package"].clone())
                            .map_err(|e| e.to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(ManagedProviderIndex {
                    schema_version: 1,
                    generated_at,
                    expires_at,
                    packages,
                })
            }
        }
    }
}
fn timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|e| e.to_string())
}
