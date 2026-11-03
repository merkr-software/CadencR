//! Local-only deterministic packaging of a prepared language-server tree.
use super::{invalid, native, safe_path, MAX_LSP_ARCHIVE_BYTES, MAX_LSP_UNCOMPRESSED_BYTES};
use crate::{digest::sha256_hex, LspRuntime, RegistryError};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(bon::Builder)]
pub struct PackLspRequest<'a> {
    pub directory: &'a Path,
    pub target: &'a str,
    pub entry: &'a str,
    pub runtime: LspRuntime,
    pub output: &'a Path,
}
#[derive(Debug, Clone, Serialize)]
pub struct PackedLsp {
    pub target: String,
    pub archive: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub entry: String,
    pub entry_sha256: String,
    pub entry_size: u64,
    pub runtime: LspRuntime,
}

pub fn pack_lsp(request: PackLspRequest<'_>) -> Result<PackedLsp, RegistryError> {
    crate::archive::validate_output_name(request.output)?;
    if !safe_path(request.entry)
        || cadencr_plugin_core::tab::TabPlatform::parse(request.target).is_none()
    {
        return Err(invalid("invalid entry or unsupported target"));
    }
    if request.runtime == LspRuntime::Node
        && ![".js", ".cjs", ".mjs"]
            .iter()
            .any(|suffix| request.entry.ends_with(suffix))
    {
        return Err(invalid("Node entry must end in .js, .cjs or .mjs"));
    }
    let snapshot = crate::archive::scan::collect(request.directory)?;
    if snapshot
        .entries
        .iter()
        .any(|entry| !entry.directory && !safe_path(&entry.relative.to_string_lossy()))
    {
        return Err(invalid(
            "bundle paths exceed the normalized archive path bounds",
        ));
    }
    let total = snapshot
        .entries
        .iter()
        .filter(|entry| !entry.directory)
        .map(|entry| entry.identity.len)
        .sum::<u64>();
    if total > MAX_LSP_UNCOMPRESSED_BYTES - 4096 * 1024 {
        return Err(invalid("bundle exceeds uncompressed size budget"));
    }
    let path = snapshot.root.join(request.entry);
    let entry = crate::safe_io::read_bounded_regular(&path, MAX_LSP_UNCOMPRESSED_BYTES)
        .map_err(|e| invalid(format!("cannot read entry: {e}")))?;
    if entry.is_empty() {
        return Err(invalid("entry is empty"));
    }
    let built = if request.runtime == LspRuntime::Native {
        native(&entry, request.target)?;
        crate::archive::scan::validate_declared_files(
            &snapshot,
            request.target,
            request.entry,
            [],
        )?;
        crate::archive::write::single_executable_archive(
            request.entry,
            &entry,
            &snapshot.root,
            request.output,
        )?
    } else {
        // Normalized regular files only; every dependency must already be present.
        crate::archive::write::lsp_bundle_archive(&snapshot, request.output)?
    };
    if built.size > MAX_LSP_ARCHIVE_BYTES {
        return Err(invalid("archive exceeds 64 MiB"));
    }
    let bytes = crate::safe_io::read_bounded_regular(request.output, MAX_LSP_ARCHIVE_BYTES)
        .map_err(|e| invalid(format!("cannot verify packed archive: {e}")))?;
    let signed = crate::LspTarget {
        archive: "https://github.com/local/lsp/releases/download/v1/lsp.tar.gz".into(),
        sha256: built.sha256.clone(),
        size: built.size,
        entry: request.entry.into(),
        entry_sha256: sha256_hex(&entry),
        entry_size: entry.len() as u64,
        runtime: request.runtime,
    };
    super::read_lsp_archive(&bytes, request.target, &signed)?;
    Ok(PackedLsp {
        target: request.target.into(),
        archive: std::path::absolute(request.output).map_err(|e| invalid(e.to_string()))?,
        sha256: built.sha256,
        size: built.size,
        entry: signed.entry,
        entry_sha256: signed.entry_sha256,
        entry_size: signed.entry_size,
        runtime: request.runtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_bundle_packing_is_deterministic_and_refuses_existing_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("server.js"), "process.stdin.resume()").unwrap();
        let pack = |name: &str| {
            pack_lsp(
                PackLspRequest::builder()
                    .directory(&root)
                    .target("linux-x86_64")
                    .entry("server.js")
                    .runtime(LspRuntime::Node)
                    .output(&temp.path().join(name))
                    .build(),
            )
        };
        let a = pack("a.tar.gz").unwrap();
        let b = pack("b.tar.gz").unwrap();
        assert_eq!(a.sha256, b.sha256);
        assert!(pack("a.tar.gz").is_err());
    }
}
