use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::PublisherError;

#[derive(bon::Builder)]
pub struct PublishCatalogRequest<'a> {
    pub snapshot: &'a cadencr_registry_core::CatalogSnapshot,
    pub manifest: &'a Path,
    pub directory: &'a Path,
    pub token: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogPublicationReceipt {
    pub schema_version: u64,
    pub status: String,
    pub repository: String,
    pub registry_commit: String,
    pub release_id: u64,
    pub release_tag: String,
    pub tag_commit: String,
    pub catalog_sha256: String,
    pub catalog_size: u64,
    pub catalog_url: String,
    pub previous_sha256: String,
}

pub(super) fn build_receipt(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    release_id: u64,
) -> CatalogPublicationReceipt {
    CatalogPublicationReceipt {
        schema_version: 1,
        status: "published_verified".into(),
        repository: snapshot.repository().into(),
        registry_commit: snapshot.registry_commit().into(),
        release_id,
        release_tag: snapshot.tag().into(),
        tag_commit: snapshot.registry_commit().into(),
        catalog_sha256: snapshot.sha256().into(),
        catalog_size: snapshot.size() as u64,
        catalog_url: snapshot.expected_url().into(),
        previous_sha256: snapshot.previous_sha256().unwrap_or("bootstrap").into(),
    }
}

pub(super) fn read_receipt(
    directory: &Path,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
) -> Result<Option<CatalogPublicationReceipt>, PublisherError> {
    let path = directory.join(super::RECEIPT);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PublisherError::io("inspect catalog receipt", error)),
        Ok(_) => {}
    }
    let bytes = crate::fs::read_bounded(&path, 4 * 1024 * 1024, "catalog receipt")?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new("existing catalog receipt is invalid"))?;
    let receipt: CatalogPublicationReceipt = serde_json::from_value(value)
        .map_err(|_| PublisherError::new("existing catalog receipt is invalid"))?;
    if !(1..=super::MAX_SAFE_ID).contains(&receipt.release_id) {
        return Err(PublisherError::new("existing catalog receipt conflicts"));
    }
    if receipt != build_receipt(snapshot, receipt.release_id) {
        return Err(PublisherError::new("existing catalog receipt conflicts"));
    }
    Ok(Some(receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1,
            "status": "published_verified",
            "repository": "cadencr/registry",
            "registry_commit": "b".repeat(40),
            "release_id": 7,
            "release_tag": "catalog-deadbeef",
            "tag_commit": "b".repeat(40),
            "catalog_sha256": "a".repeat(64),
            "catalog_size": 42,
            "catalog_url": "https://github.com/cadencr/registry/releases/download/catalog-deadbeef/managed-index.json",
            "previous_sha256": "bootstrap"
        })
    }

    #[test]
    fn receipt_schema_denies_unknown_and_missing_fields() {
        serde_json::from_value::<CatalogPublicationReceipt>(value()).unwrap();
        let mut extra = value();
        extra["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<CatalogPublicationReceipt>(extra).is_err());
        let mut missing = value();
        missing.as_object_mut().unwrap().remove("catalog_url");
        assert!(serde_json::from_value::<CatalogPublicationReceipt>(missing).is_err());
    }
}
