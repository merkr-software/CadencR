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
    let mirrored = &plan["mirrored_package"];
    for (target, artifact) in targets.iter().zip(&artifacts) {
        let archive = directory.join(&artifact.asset);
        let (entry, name) = if cadencr_registry_core::marketplace_package_kind(mirrored)
            == Some(cadencr_registry_core::PLUGIN_KIND)
        {
            plugin_member_target(mirrored, &target.target)?
        } else {
            (mirrored, target.target.as_str())
        };
        verify_entry_artifact(entry, name, &archive)?;
    }
    let receipt = StageReceipt {
        schema_version: 1,
        plan,
        artifacts,
    };
    publish_receipt(directory, &receipt)?;
    Ok(receipt)
}

/// A plugin target names its member: `<kind>:<id>:<member target>`.
fn plugin_member_target<'a>(
    plugin: &'a Value,
    target: &'a str,
) -> Result<(&'a Value, &'a str), PublisherError> {
    let unknown = || PublisherError::new(format!("unknown plugin publication target {target}"));
    let (kind, id, name) =
        cadencr_registry_core::split_plugin_target(target).ok_or_else(unknown)?;
    let member = cadencr_registry_core::plugin_members(plugin)
        .iter()
        .find(|member| {
            cadencr_registry_core::marketplace_package_kind(member) == Some(kind)
                && cadencr_registry_core::marketplace_package_identity(member)
                    .is_some_and(|(member_id, _)| member_id == id)
        })
        .ok_or_else(unknown)?;
    Ok((member, name))
}

/// Verify one staged archive against its single-kind entry, executing
/// nothing. Provider binaries are checked by digest only.
fn verify_entry_artifact(
    entry: &Value,
    target: &str,
    archive: &Path,
) -> Result<(), PublisherError> {
    match cadencr_registry_core::marketplace_package_kind(entry) {
        Some("lsp") => {
            let signed = cadencr_registry_core::signed_lsp_target(entry, target)?;
            let bytes = crate::fs::read_bounded(
                archive,
                cadencr_registry_core::MAX_LSP_ARCHIVE_BYTES,
                "staged LSP archive",
            )?;
            cadencr_registry_core::read_lsp_archive(&bytes, target, &signed)?;
        }
        Some("theme") => cadencr_registry_core::verify_theme_archive(archive)?,
        Some("tab") => {
            let backend = cadencr_registry_core::signed_tab_backend(entry)
                .map_err(cadencr_registry_core::RegistryError::from)?;
            verify_tab_artifact(&entry["package"], backend.as_ref(), target, archive)?
        }
        _ => {}
    }
    Ok(())
}

/// A tab publication stages its web archive (`tab`) and one archive per
/// backend platform (`backend-<platform>`); each is verified against the
/// mirrored package (and its signed `backend`) without being executed.
fn verify_tab_artifact(
    package: &Value,
    backend: Option<&cadencr_registry_core::SignedTabBackend>,
    target: &str,
    archive: &Path,
) -> Result<(), PublisherError> {
    if target == "tab" {
        let bytes = crate::fs::read_bounded(
            archive,
            cadencr_registry_core::MAX_TAB_BYTES,
            "staged tab archive",
        )?;
        let files = cadencr_registry_core::read_tab_archive_bytes(&bytes)?;
        cadencr_registry_core::validate_tab_package_files(package, &files)?;
        return Ok(());
    }
    let platform = cadencr_registry_core::plan_target_platform(target)
        .ok_or_else(|| PublisherError::new(format!("unknown tab publication target {target}")))?;
    let signed = backend
        .and_then(|backend| backend.target(platform))
        .ok_or_else(|| {
            PublisherError::new(format!("tab package declares no backend for {platform}"))
        })?;
    let bytes = crate::fs::read_bounded(
        archive,
        cadencr_registry_core::MAX_TAB_BACKEND_ARCHIVE_BYTES,
        "staged tab backend archive",
    )?;
    cadencr_registry_core::read_tab_backend_archive(&bytes, platform, signed)?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use cadencr_registry_core::{pack_lsp, LspRuntime, PackLspRequest};
    use serde_json::json;

    #[test]
    fn lsp_archives_are_verified_for_standalone_and_plugin_targets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("server.js"), "process.stdin.resume()").unwrap();
        let packed = pack_lsp(
            PackLspRequest::builder()
                .directory(&source)
                .target("linux-x86_64")
                .entry("server.js")
                .runtime(LspRuntime::Node)
                .output(&root.path().join("server.tar.gz"))
                .build(),
        )
        .unwrap();
        let mut member: Value = serde_json::from_str(include_str!(
            "../../../../tooling/marketplace-registry/examples/lsp/package.node.json"
        ))
        .unwrap();
        let mut target = serde_json::to_value(&packed).unwrap();
        target.as_object_mut().unwrap().remove("target");
        target["archive"] =
            json!("https://github.com/acme/language-server/releases/download/v1.0.0/server.tar.gz");
        member["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"] = target;
        verify_entry_artifact(&member, "linux-x86_64", &packed.archive).unwrap();
        let plugin = json!({"kind":"plugin","package":{"contributes":[member.clone()]}});
        let (entry, platform) =
            plugin_member_target(&plugin, "lsp:example-language-server:linux-x86_64").unwrap();
        verify_entry_artifact(entry, platform, &packed.archive).unwrap();
        assert!(plugin_member_target(&plugin, "lsp:other:linux-x86_64").is_err());
        member["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"]["entry_sha256"] =
            json!("f".repeat(64));
        assert!(verify_entry_artifact(&member, "linux-x86_64", &packed.archive).is_err());
    }
}
