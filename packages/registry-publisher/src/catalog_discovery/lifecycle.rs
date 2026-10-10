use std::path::Path;

use crate::github::discovery::{DiscoveryClient, DiscoveryHead, SetDiscoveryRequest};
use crate::github::ReleaseClient;
use crate::{Downloader, PublisherError};

#[cfg(test)]
use super::preflight;
use super::receipt::{self, DiscoveryReceipt};
use super::validation::{assess, require_candidate, require_same_head};
use super::verification::{validate_remote_catalog, verify_public_catalog, verify_raw};
use super::LOCK;

#[cfg(test)]
pub(super) fn advance_with(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
    client: &(impl DiscoveryClient + ReleaseClient),
    catalog_downloader: &impl Downloader,
    discovery_downloader: &impl Downloader,
) -> Result<DiscoveryReceipt, PublisherError> {
    let freshness = || snapshot.revalidate_freshness().map_err(Into::into);
    preflight(snapshot, manifest, directory, branch)?;
    advance_preflighted_with_freshness()
        .snapshot(snapshot)
        .manifest(manifest)
        .directory(directory)
        .branch(branch)
        .client(client)
        .catalog_downloader(catalog_downloader)
        .discovery_downloader(discovery_downloader)
        .freshness(&freshness)
        .call()
}

pub(crate) fn advance_preflighted(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
    client: &(impl DiscoveryClient + ReleaseClient),
    catalog_downloader: &impl Downloader,
    discovery_downloader: &impl Downloader,
) -> Result<DiscoveryReceipt, PublisherError> {
    let freshness = || snapshot.revalidate_freshness().map_err(Into::into);
    advance_preflighted_with_freshness()
        .snapshot(snapshot)
        .manifest(manifest)
        .directory(directory)
        .branch(branch)
        .client(client)
        .catalog_downloader(catalog_downloader)
        .discovery_downloader(discovery_downloader)
        .freshness(&freshness)
        .call()
}

#[cfg(test)]
#[bon::builder]
pub(super) fn advance_with_freshness(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
    client: &(impl DiscoveryClient + ReleaseClient),
    catalog_downloader: &impl Downloader,
    discovery_downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<DiscoveryReceipt, PublisherError> {
    preflight(snapshot, manifest, directory, branch)?;
    advance_preflighted_with_freshness()
        .snapshot(snapshot)
        .manifest(manifest)
        .directory(directory)
        .branch(branch)
        .client(client)
        .catalog_downloader(catalog_downloader)
        .discovery_downloader(discovery_downloader)
        .freshness(freshness)
        .call()
}

#[bon::builder]
fn advance_preflighted_with_freshness(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
    client: &(impl DiscoveryClient + ReleaseClient),
    catalog_downloader: &impl Downloader,
    discovery_downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<DiscoveryReceipt, PublisherError> {
    let lock = crate::fs::OwnedLock::acquire(&directory.join(LOCK))?;
    let result = advance_locked()
        .snapshot(snapshot)
        .manifest(manifest)
        .directory(directory)
        .branch(branch)
        .client(client)
        .catalog_downloader(catalog_downloader)
        .discovery_downloader(discovery_downloader)
        .freshness(freshness)
        .call();
    match result {
        Ok(value) => {
            lock.release(None)?;
            Ok(value)
        }
        Err(error) => Err(lock.release(Some(error)).unwrap_err()),
    }
}

#[bon::builder]
fn advance_locked(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
    client: &(impl DiscoveryClient + ReleaseClient),
    catalog_downloader: &impl Downloader,
    discovery_downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<DiscoveryReceipt, PublisherError> {
    let catalog = crate::catalog_publish::read_receipt(directory, snapshot)?
        .ok_or_else(|| PublisherError::new("catalog publication receipt is required"))?;
    let prior = receipt::read(directory)?;
    receipt::validate_binding(prior.as_ref(), snapshot, branch, catalog.release_id)?;
    let original = client.get_discovery(branch)?;
    let replay = assess(snapshot, original.as_ref())?;

    validate_remote_catalog(client, snapshot, catalog.release_id)?;
    verify_public_catalog(snapshot, directory, catalog_downloader)?;
    crate::catalog_publish::authoritative_prepare(
        snapshot,
        manifest,
        catalog_downloader,
        freshness,
    )?;
    let current = client.get_discovery(branch)?;
    require_same_head(original.as_ref(), current.as_ref())?;
    validate_remote_catalog(client, snapshot, catalog.release_id)?;
    freshness()?;

    let final_head = if replay {
        current.ok_or_else(|| PublisherError::new("discovery does not contain the candidate"))?
    } else {
        set_or_reconcile(client, snapshot, branch, original.as_ref())?
    };
    require_candidate(snapshot, Some(&final_head))?;
    verify_raw(snapshot, branch, directory, discovery_downloader)?;
    let after_raw = client.get_discovery(branch)?;
    require_candidate(snapshot, after_raw.as_ref())?;
    if after_raw.as_ref().map(|head| &head.sha) != Some(&final_head.sha) {
        return Err(PublisherError::new(
            "discovery changed during public verification",
        ));
    }
    validate_remote_catalog(client, snapshot, catalog.release_id)?;
    freshness()?;
    let final_head = after_raw.expect("candidate just required");
    let receipt = receipt::build(snapshot, branch, catalog.release_id, &final_head.sha)?;
    if let Some(prior) = prior {
        if prior != receipt {
            return Err(PublisherError::new("existing discovery receipt conflicts"));
        }
        return Ok(prior);
    }
    crate::receipt::publish_canonical_receipt(directory, receipt::RECEIPT, &receipt)?;
    Ok(receipt)
}

fn set_or_reconcile(
    client: &impl DiscoveryClient,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    branch: &str,
    original: Option<&DiscoveryHead>,
) -> Result<DiscoveryHead, PublisherError> {
    let request = SetDiscoveryRequest::builder()
        .branch(branch)
        .bytes(snapshot.canonical_envelope())
        .maybe_expected_sha(original.map(|head| head.sha.as_str()))
        .build();
    match client.set_discovery(request) {
        Ok(()) => client
            .get_discovery(branch)?
            .ok_or_else(|| PublisherError::new("discovery does not contain the candidate")),
        Err(primary) => match client.get_discovery(branch)? {
            Some(winner) if winner.bytes == snapshot.canonical_envelope() => Ok(winner),
            _ => Err(primary),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    use super::super::fixture::{assert_js_receipt, run, setup, setup_baseline, RawMode};
    use crate::catalog_publish::fixture::PublicMode;

    #[test]
    fn advances_recovers_lost_put_and_replays_without_mutation() {
        for lost in [false, true] {
            let (value, raw) = setup();
            value.client.set_lost_discovery(lost);
            let receipt = run(&value, &raw).unwrap();
            assert_js_receipt(&receipt, &value.snapshot);
            assert_eq!(receipt.blob_sha, "c".repeat(40));
            assert_eq!(value.client.discovery_counts().1, 1);
            run(&value, &raw).unwrap();
            assert_eq!(value.client.discovery_counts().1, 1);
        }
        let (value, raw) = setup();
        value.client.foreign_winner_on_lost_set();
        assert!(run(&value, &raw).is_err());
        assert_eq!(value.client.discovery_counts().1, 1);
        assert!(!value.directory.join(receipt::RECEIPT).exists());
        let (value, raw) = setup_baseline();
        value
            .client
            .set_discovery_head(std::fs::read(value.directory.join("previous.json")).unwrap());
        run(&value, &raw).unwrap();
        assert_eq!(value.client.discovery_counts().1, 1);
    }

    #[test]
    fn conflicts_drift_and_public_failures_never_write_receipt() {
        for mode in [RawMode::WrongDigest, RawMode::WrongSize] {
            let (value, raw) = setup();
            raw.set_mode(mode);
            assert!(run(&value, &raw).is_err());
            assert!(!value.directory.join(receipt::RECEIPT).exists());
        }
        for mode in [PublicMode::WrongDigest, PublicMode::WrongSize] {
            let (value, raw) = setup();
            value.downloader.set_public_mode(mode);
            assert!(run(&value, &raw).is_err());
            assert_eq!(value.client.discovery_counts().1, 0);
        }
        let (value, raw) = setup();
        value.client.set_discovery_head(b"{}\n".to_vec());
        assert!(run(&value, &raw).is_err());
        assert_eq!(value.client.discovery_counts().1, 0);
        for get in [2, 4] {
            let (value, raw) = setup();
            value.client.drift_discovery_at(get);
            assert!(run(&value, &raw).is_err());
            assert!(!value.directory.join(receipt::RECEIPT).exists());
        }
        for release in [true, false] {
            let (value, raw) = setup();
            if release {
                value.client.drift_release_after(2);
            } else {
                value.client.fail_tag_after(2);
            }
            assert!(run(&value, &raw).is_err());
            assert_eq!(value.client.discovery_counts().1, 0);
        }
        for release in [true, false] {
            let (value, raw) = setup();
            if release {
                value.client.drift_release_after(3);
            } else {
                value.client.fail_tag_after(3);
            }
            assert!(run(&value, &raw).is_err());
            assert_eq!(value.client.discovery_counts().1, 1);
            assert!(!value.directory.join(receipt::RECEIPT).exists());
        }
    }

    #[test]
    fn freshness_gates_put_and_receipt() {
        for (checkpoint, sets) in [(1, 0), (2, 0), (3, 1)] {
            let (value, raw) = setup();
            let calls = Cell::new(0);
            let fresh = || {
                calls.set(calls.get() + 1);
                if calls.get() == checkpoint {
                    Err(PublisherError::new("expired"))
                } else {
                    Ok(())
                }
            };
            assert!(advance_with_freshness()
                .snapshot(&value.snapshot)
                .manifest(&value.manifest)
                .directory(&value.directory)
                .branch("main")
                .client(&value.client)
                .catalog_downloader(&value.downloader)
                .discovery_downloader(&raw)
                .freshness(&fresh)
                .call()
                .is_err());
            assert_eq!(value.client.discovery_counts().1, sets);
            assert!(!value.directory.join(receipt::RECEIPT).exists());
        }
    }

    #[test]
    fn receipt_failures_are_local_and_precede_remote_reads() {
        for bytes in [b"{}".to_vec(), b"{".to_vec(), b"null".to_vec()] {
            let (value, raw) = setup();
            std::fs::write(value.directory.join(receipt::RECEIPT), bytes).unwrap();
            assert!(run(&value, &raw).is_err());
            assert_eq!(value.client.discovery_counts(), (0, 0));
            assert_eq!(raw.calls(), 0);
            assert_eq!(value.client.api_calls(), 0);
            assert_eq!(value.downloader.calls(), 0);
        }
        for field in ["unknown", "blob", "release"] {
            let (value, raw) = setup();
            let mut receipt = serde_json::to_value(
                receipt::build(&value.snapshot, "main", 7, &"c".repeat(40)).unwrap(),
            )
            .unwrap();
            match field {
                "unknown" => receipt["extra"] = serde_json::json!(true),
                "blob" => receipt["blob_sha"] = serde_json::json!("BAD"),
                "release" => receipt["release_id"] = serde_json::json!(8),
                _ => unreachable!(),
            }
            std::fs::write(
                value.directory.join(receipt::RECEIPT),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
            assert!(run(&value, &raw).is_err());
            assert_eq!(value.client.api_calls(), 0);
            assert_eq!(value.downloader.calls(), 0);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let (value, raw) = setup();
            symlink("missing", value.directory.join(receipt::RECEIPT)).unwrap();
            assert!(run(&value, &raw).is_err());
            assert_eq!(value.client.api_calls(), 0);
            assert_eq!(value.downloader.calls(), 0);
        }
        let (value, raw) = setup();
        std::fs::remove_file(value.directory.join("catalog-publication-receipt.json")).unwrap();
        assert!(run(&value, &raw).is_err());
        assert_eq!(value.client.discovery_counts(), (0, 0));
        let (value, raw) = setup();
        value.set_manifest_repository("other/registry");
        assert!(run(&value, &raw).is_err());
        assert_eq!(value.client.api_calls(), 0);
        assert_eq!(value.downloader.calls(), 0);
    }
}
