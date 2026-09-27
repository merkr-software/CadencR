use std::path::Path;

use serde_json::Value;

use super::{
    parse_targets, partial_path, StageArtifact, StageReceipt, Target, LOCK, MAX_ARCHIVE_BYTES,
};
use crate::artifact::{artifact_from_verified, finish_target};
use crate::fs::{ensure_directory, hash_regular, remove_owned, Identity, OwnedLock};
use crate::receipt::{publish_receipt, validate_existing_receipt};
use crate::{DownloadRequest, Downloader, PublisherError};

#[derive(Clone, Copy)]
pub(super) enum StagingPolicy {
    Source,
    Managed { max_total_bytes: u64 },
}

pub(super) fn stage_plan_with_policy(
    directory: &Path,
    plan: Value,
    downloader: &impl Downloader,
    policy: StagingPolicy,
) -> Result<StageReceipt, PublisherError> {
    let targets = parse_targets(&plan)?;
    validate_policy_targets(&targets, policy)?;
    ensure_directory(directory)?;
    let lock = OwnedLock::acquire(&directory.join(LOCK))?;
    let result = stage_locked(directory, plan, targets, downloader, policy);
    match result {
        Ok(receipt) => {
            lock.release(None)?;
            Ok(receipt)
        }
        Err(error) => {
            lock.release(Some(error))?;
            unreachable!("release returns the primary error")
        }
    }
}

fn stage_locked(
    directory: &Path,
    plan: Value,
    targets: Vec<Target>,
    downloader: &impl Downloader,
    policy: StagingPolicy,
) -> Result<StageReceipt, PublisherError> {
    validate_existing_receipt(directory, &plan)?;
    let artifacts = match policy {
        StagingPolicy::Source => stage_source_targets(directory, &targets, downloader)?,
        StagingPolicy::Managed { max_total_bytes } => {
            stage_managed_targets(directory, &targets, downloader, max_total_bytes)?
        }
    };
    let receipt = StageReceipt {
        schema_version: 1,
        plan,
        artifacts,
    };
    publish_receipt(directory, &receipt)?;
    Ok(receipt)
}

fn validate_policy_targets(
    targets: &[Target],
    policy: StagingPolicy,
) -> Result<(), PublisherError> {
    if matches!(policy, StagingPolicy::Managed { .. })
        && targets
            .iter()
            .any(|target| target.destination_url.is_empty())
    {
        return Err(PublisherError::new(
            "publication target destination URL is missing",
        ));
    }
    Ok(())
}

fn stage_source_targets(
    directory: &Path,
    targets: &[Target],
    downloader: &impl Downloader,
) -> Result<Vec<StageArtifact>, PublisherError> {
    targets
        .iter()
        .map(|target| {
            stage_target(
                directory,
                target,
                downloader,
                &target.source_url,
                MAX_ARCHIVE_BYTES,
            )
        })
        .collect()
}

fn stage_managed_targets(
    directory: &Path,
    targets: &[Target],
    downloader: &impl Downloader,
    budget: u64,
) -> Result<Vec<StageArtifact>, PublisherError> {
    let (retained, mut used) = verify_retained(directory, targets, budget)?;
    targets
        .iter()
        .zip(retained)
        .map(|(target, retained)| match retained {
            Some(artifact) => Ok(artifact),
            None => {
                let max_bytes = budget.saturating_sub(used).min(MAX_ARCHIVE_BYTES);
                if max_bytes == 0 {
                    return Err(budget_error());
                }
                let artifact = stage_target(
                    directory,
                    target,
                    downloader,
                    &target.destination_url,
                    max_bytes,
                )?;
                used = add_to_budget(used, artifact.size, budget)?;
                Ok(artifact)
            }
        })
        .collect()
}

fn verify_retained(
    directory: &Path,
    targets: &[Target],
    budget: u64,
) -> Result<(Vec<Option<StageArtifact>>, u64), PublisherError> {
    let mut retained = Vec::with_capacity(targets.len());
    let mut used = 0;
    for target in targets {
        let path = directory.join(&target.asset);
        let artifact = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(PublisherError::io("inspect existing asset", error)),
            Ok(_) => {
                let verified = hash_regular(&path, MAX_ARCHIVE_BYTES, "existing asset")?;
                used = add_to_budget(used, verified.size, budget)?;
                Some(artifact_from_verified(target, verified)?)
            }
        };
        retained.push(artifact);
    }
    Ok((retained, used))
}

fn add_to_budget(used: u64, size: u64, budget: u64) -> Result<u64, PublisherError> {
    let total = used.checked_add(size).ok_or_else(budget_error)?;
    if total > budget {
        return Err(budget_error());
    }
    Ok(total)
}

fn budget_error() -> PublisherError {
    PublisherError::new("managed staging exceeds the 1 GiB budget")
}

fn stage_target(
    directory: &Path,
    target: &Target,
    downloader: &impl Downloader,
    url: &str,
    max_bytes: u64,
) -> Result<StageArtifact, PublisherError> {
    let final_path = directory.join(&target.asset);
    match std::fs::symlink_metadata(&final_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(PublisherError::io("inspect existing asset", error)),
        Ok(_) => {
            return artifact_from_verified(
                target,
                hash_regular(&final_path, max_bytes, "existing asset")?,
            )
        }
    }
    let partial = partial_path(directory, &target.asset);
    let downloaded = downloader.download(DownloadRequest {
        url,
        sha256: &target.sha256,
        output: partial.clone(),
        max_bytes,
    })?;
    let identity = Identity::from_metadata(
        &std::fs::symlink_metadata(&partial)
            .map_err(|error| PublisherError::io("inspect downloaded asset", error))?,
    );
    let result = finish_target(
        target,
        &partial,
        identity,
        &final_path,
        downloaded,
        max_bytes,
    );
    let cleanup = remove_owned(&partial, identity);
    match (result, cleanup) {
        (Ok(artifact), Ok(())) => Ok(artifact),
        (Ok(_), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(PublisherError::new("owned staging partial disappeared"))
        }
        (Ok(_), Err(error)) => Err(PublisherError::io("remove staging partial", error)),
        (Err(primary), Ok(())) => Err(primary),
        (Err(primary), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Err(primary),
        (Err(primary), Err(_)) => Err(PublisherError::cleanup(primary, 1)),
    }
}
