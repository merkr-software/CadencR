use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::PublisherError;

pub(super) const RECEIPT: &str = "discovery-receipt.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryReceipt {
    pub schema_version: u64,
    pub status: String,
    pub repository: String,
    pub branch: String,
    pub url: String,
    pub snapshot_sha256: String,
    pub baseline_sha256: String,
    pub blob_sha: String,
    pub release_id: u64,
    pub release_tag: String,
    pub registry_commit: String,
    pub tag_commit: String,
}

pub(super) fn build(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    branch: &str,
    release_id: u64,
    blob_sha: &str,
) -> Result<DiscoveryReceipt, PublisherError> {
    Ok(DiscoveryReceipt {
        schema_version: 1,
        status: "discovery_verified".into(),
        repository: snapshot.repository().into(),
        branch: branch.into(),
        url: cadencr_registry_core::discovery_url(snapshot.repository(), branch)?,
        snapshot_sha256: snapshot.sha256().into(),
        baseline_sha256: snapshot.previous_sha256().unwrap_or("bootstrap").into(),
        blob_sha: blob_sha.into(),
        release_id,
        release_tag: snapshot.tag().into(),
        registry_commit: snapshot.registry_commit().into(),
        tag_commit: snapshot.registry_commit().into(),
    })
}

pub(super) fn read(directory: &Path) -> Result<Option<DiscoveryReceipt>, PublisherError> {
    let path = directory.join(RECEIPT);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PublisherError::io("inspect discovery receipt", error)),
        Ok(_) => {}
    }
    let bytes = crate::fs::read_bounded(&path, 4 * 1024 * 1024, "discovery receipt")?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new("existing discovery receipt is invalid"))?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| PublisherError::new("existing discovery receipt is invalid"))
}

pub(super) fn validate_binding(
    receipt: Option<&DiscoveryReceipt>,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    branch: &str,
    release_id: u64,
) -> Result<(), PublisherError> {
    let Some(receipt) = receipt else {
        return Ok(());
    };
    if !valid_blob_sha(&receipt.blob_sha)
        || receipt != &build(snapshot, branch, release_id, &receipt.blob_sha)?
    {
        return Err(PublisherError::new("existing discovery receipt conflicts"));
    }
    Ok(())
}

fn valid_blob_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
