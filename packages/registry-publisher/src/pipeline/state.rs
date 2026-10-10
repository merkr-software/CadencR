use super::PreparedPipeline;
use crate::PublisherError;
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn inspect_directory(path: &Path, require_all: bool) -> Result<(), PublisherError> {
    let mut cursor = std::path::PathBuf::new();
    for component in path.components() {
        cursor.push(component);
        match std::fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(PublisherError::new(
                    "pipeline path contains symbolic link or non-directory",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !require_all => return Ok(()),
            Err(e) => return Err(PublisherError::io("inspect pipeline directory", e)),
        }
    }
    Ok(())
}

pub(super) fn ensure_directory(path: &Path) -> Result<(), PublisherError> {
    inspect_directory(path, false)?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(path)
        .map_err(|e| PublisherError::io("create pipeline directory", e))?;
    inspect_directory(path, true)
}

pub(super) fn preflight(prepared: &PreparedPipeline) -> Result<(), PublisherError> {
    check_json(
        &prepared.directory.join("pipeline-request.json"),
        &prepared.binding,
    )?;
    let inputs = prepared.directory.join("inputs");
    inspect_directory(&inputs, false)?;
    check_bytes(&inputs.join("public-key.pem"), &prepared.public_key)?;
    if let Some(bytes) = &prepared.previous {
        check_bytes(&inputs.join("previous-index.json"), bytes)?;
    }
    for entry in &prepared.entries {
        inspect_directory(&entry.directory, false)?;
        check_bytes(&entry.submission_file(), &entry.bytes)?;
        let binding = crate::binding::build_publication_prebinding(
            &entry.plan,
            &prepared.request.repository,
            &entry.registry_commit,
        )?;
        crate::receipt::validate_existing_receipt_prebound(&entry.directory, &binding)?;
        crate::recover::local::prebound_receipts(
            &entry.directory,
            &binding,
            &prepared.request.repository,
            &entry.registry_commit,
        )?;
        check_json(&entry.directory.join("publication-plan.json"), &entry.plan)?;
    }
    check_json(
        &prepared.directory.join("publication-manifest.json"),
        &manifest(prepared),
    )?;
    let catalog_file = prepared.directory.join("managed-index.json");
    if exists(&catalog_file)? {
        let snapshot = super::catalog::snapshot(prepared, &catalog_file)?;
        let expected = cadencr_registry_core::prepare_publication_index()
            .packages(
                prepared
                    .entries
                    .iter()
                    .map(|e| e.plan["mirrored_package"].clone())
                    .collect(),
            )
            .generated_at(&prepared.request.generated_at)
            .expires_at(&prepared.request.expires_at)
            .call()?;
        if snapshot.canonical_payload() != expected.canonical_payload() {
            return Err(PublisherError::new(
                "existing signed catalog conflicts with reviewed request",
            ));
        }
        let catalog_receipt = crate::catalog_publish::read_receipt(&prepared.directory, &snapshot)?;
        if catalog_receipt.is_some() {
            crate::catalog_discovery::preflight(
                &snapshot,
                &prepared.directory.join("publication-manifest.json"),
                &prepared.directory,
                &prepared.request.discovery_branch,
            )?;
        } else if exists(&prepared.directory.join("discovery-receipt.json"))? {
            return Err(PublisherError::new(
                "discovery receipt requires verified catalog receipt",
            ));
        }
    }
    if !exists(&catalog_file)?
        && (exists(&prepared.directory.join("catalog-publication-receipt.json"))?
            || exists(&prepared.directory.join("discovery-receipt.json"))?)
    {
        return Err(PublisherError::new(
            "catalog receipts require existing signed catalog",
        ));
    }
    super::staging::retained_bytes(prepared)?;
    Ok(())
}

pub(super) fn materialize(prepared: &PreparedPipeline) -> Result<(), PublisherError> {
    crate::receipt::publish_canonical_receipt(
        &prepared.directory,
        "pipeline-request.json",
        &prepared.binding,
    )?;
    let inputs = prepared.directory.join("inputs");
    ensure_directory(&inputs)?;
    ensure_directory(&prepared.directory.join("publications"))?;
    write_bytes_once(&inputs.join("public-key.pem"), &prepared.public_key)?;
    if let Some(bytes) = &prepared.previous {
        write_bytes_once(&inputs.join("previous-index.json"), bytes)?;
    }
    for entry in &prepared.entries {
        ensure_directory(&entry.directory)?;
        write_bytes_once(&entry.submission_file(), &entry.bytes)?;
    }
    Ok(())
}

pub(super) fn manifest(prepared: &PreparedPipeline) -> Value {
    json!({"schema_version":1,"repository":prepared.request.repository,
        "publications":prepared.entries.iter().enumerate().map(|(index, entry)| {
            let directory = format!("publications/{:03}",index+1);
            json!({"submission":format!("{directory}/submission.json"),"directory":directory,"registry_commit":entry.registry_commit})
        }).collect::<Vec<_>>()})
}

pub(super) fn write_json_once(path: &Path, value: &Value) -> Result<(), PublisherError> {
    let parent = path
        .parent()
        .ok_or_else(|| PublisherError::new("pipeline output has no parent"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PublisherError::new("pipeline output filename is invalid"))?;
    crate::receipt::publish_canonical_receipt(parent, name, value)
}

pub(super) fn write_bytes_once(path: &Path, bytes: &[u8]) -> Result<(), PublisherError> {
    if exists(path)? {
        return compare_bytes(path, bytes);
    }
    let parent = path
        .parent()
        .ok_or_else(|| PublisherError::new("pipeline output has no parent"))?;
    let partial = crate::stage::partial_path(parent, "pipeline-input");
    let identity = crate::fs::write_private_synced(&partial, bytes)?;
    let result = match std::fs::hard_link(&partial, path) {
        Ok(()) => compare_bytes(path, bytes),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => compare_bytes(path, bytes),
        Err(e) => Err(PublisherError::io("publish pipeline input", e)),
    };
    let cleanup = crate::fs::remove_owned(&partial, identity);
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) => Err(e),
        (Err(e), Err(_)) => Err(PublisherError::cleanup(e, 1)),
        (Ok(()), Err(e)) => Err(PublisherError::io("remove pipeline input partial", e)),
    }
}

fn check_bytes(path: &Path, expected: &[u8]) -> Result<(), PublisherError> {
    if !exists(path)? {
        return Ok(());
    }
    compare_bytes(path, expected)
}

fn compare_bytes(path: &Path, expected: &[u8]) -> Result<(), PublisherError> {
    let bytes = crate::fs::read_bounded(
        path,
        (expected.len() as u64).max(4 * 1024 * 1024),
        "pipeline input",
    )?;
    if bytes == expected {
        Ok(())
    } else {
        Err(PublisherError::new("existing pipeline input conflicts"))
    }
}
fn check_json(path: &Path, expected: &Value) -> Result<(), PublisherError> {
    if !exists(path)? {
        return Ok(());
    }
    let bytes = crate::fs::read_bounded(path, 4 * 1024 * 1024, "pipeline state")?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new("pipeline input must be valid JSON"))?;
    if cadencr_registry_core::canonical_json_bytes(&value)
        == cadencr_registry_core::canonical_json_bytes(expected)
    {
        Ok(())
    } else {
        Err(PublisherError::new("existing pipeline state conflicts"))
    }
}

pub(super) fn exists(path: &Path) -> Result<bool, PublisherError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(PublisherError::io("inspect pipeline state", e)),
    }
}
