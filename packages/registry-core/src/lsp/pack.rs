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
    let snapshot =
        crate::archive::scan::collect_bounded(request.directory, super::MAX_LSP_ENTRIES)?;
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
    if total > MAX_LSP_UNCOMPRESSED_BYTES - (super::MAX_LSP_ENTRIES as u64 * 1024 + 1024) {
        return Err(invalid("bundle exceeds uncompressed size budget"));
    }
    let path = snapshot.root.join(request.entry);
    let entry = crate::safe_io::read_bounded_regular(&path, MAX_LSP_UNCOMPRESSED_BYTES)
        .map_err(|e| invalid(format!("cannot read entry: {e}")))?;
    if entry.is_empty() {
        return Err(invalid("entry is empty"));
    }
    if request.runtime == LspRuntime::Native {
        native(&entry, request.target)?;
        crate::archive::scan::validate_declared_files(
            &snapshot,
            request.target,
            request.entry,
            [],
        )?;
        if snapshot.entries.iter().any(|file| {
            !file.directory && file.executable && file.relative != Path::new(request.entry)
        }) {
            return Err(invalid("only the declared native entry may be executable"));
        }
    }
    let built =
        crate::archive::write::lsp_bundle_archive(&snapshot, request.output, request.runtime)?;
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
        node_min_version: None,
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

    #[test]
    fn complete_python_stub_trees_fit_without_expanding_other_package_limits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        let stubs = root.join("typeshed");
        std::fs::create_dir_all(&stubs).unwrap();
        std::fs::write(root.join("server.js"), "process.stdin.resume()").unwrap();
        for index in 0..5_423 {
            std::fs::write(stubs.join(format!("module{index}.pyi")), "value: str\n").unwrap();
        }
        assert!(crate::archive::scan::collect(&root).is_err());
        let packed = pack_lsp(
            PackLspRequest::builder()
                .directory(&root)
                .target("linux-x86_64")
                .entry("server.js")
                .runtime(LspRuntime::Node)
                .output(&temp.path().join("python.tar.gz"))
                .build(),
        )
        .unwrap();
        let signed = crate::LspTarget {
            archive: "https://github.com/acme/lsp/releases/download/v1/python.tar.gz".into(),
            sha256: packed.sha256,
            size: packed.size,
            entry: packed.entry,
            entry_sha256: packed.entry_sha256,
            entry_size: packed.entry_size,
            runtime: packed.runtime,
            node_min_version: None,
        };
        let files = super::super::read_lsp_archive(
            &std::fs::read(packed.archive).unwrap(),
            "linux-x86_64",
            &signed,
        )
        .unwrap();
        assert_eq!(files.len(), 5_424);
        assert_eq!(files["typeshed/module5422.pyi"], b"value: str\n");
    }

    #[cfg(unix)]
    #[test]
    fn native_bundles_preserve_libraries_and_licenses_but_reject_extra_executables() {
        use cadencr_plugin_core::tab::{test_support::native_executable, TabPlatform};
        use std::os::unix::fs::PermissionsExt;
        for platform in TabPlatform::ALL {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("source");
            std::fs::create_dir_all(root.join("bin")).unwrap();
            std::fs::create_dir(root.join("lib")).unwrap();
            let executable = native_executable(platform);
            std::fs::write(root.join("bin/server"), &executable).unwrap();
            std::fs::set_permissions(
                root.join("bin/server"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            std::fs::write(root.join("lib/stdlib.lua"), "return {}\n").unwrap();
            std::fs::write(root.join("LICENSE"), "upstream license\n").unwrap();
            let pack = |name: &str| {
                pack_lsp(
                    PackLspRequest::builder()
                        .directory(&root)
                        .target(platform.as_str())
                        .entry("bin/server")
                        .runtime(LspRuntime::Native)
                        .output(&temp.path().join(name))
                        .build(),
                )
            };
            let first = pack("first.tar.gz").unwrap();
            assert_eq!(first.sha256, pack("repeat.tar.gz").unwrap().sha256);
            let target = crate::LspTarget {
                archive: "https://github.com/acme/lsp/releases/download/v1/native.tar.gz".into(),
                sha256: first.sha256,
                size: first.size,
                entry: first.entry,
                entry_sha256: first.entry_sha256,
                entry_size: first.entry_size,
                runtime: first.runtime,
                node_min_version: None,
            };
            let files = super::super::read_lsp_archive(
                &std::fs::read(first.archive).unwrap(),
                platform.as_str(),
                &target,
            )
            .unwrap();
            assert_eq!(files.len(), 3);
            assert_eq!(files["bin/server"], executable);
            assert_eq!(files["lib/stdlib.lua"], b"return {}\n");
            assert_eq!(files["LICENSE"], b"upstream license\n");
            std::fs::set_permissions(
                root.join("lib/stdlib.lua"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            assert!(pack("unexpected-executable.tar.gz")
                .unwrap_err()
                .to_string()
                .contains("only the declared native entry"));
        }
    }
}
