//! Bounded archive inspection; returns captured regular-file bytes, never extracts.
use super::{invalid, native, safe_path, MAX_LSP_ARCHIVE_BYTES, MAX_LSP_UNCOMPRESSED_BYTES};
use crate::{digest::sha256_hex, gzip::gunzip_bounded, LspRuntime, LspTarget, RegistryError};
use std::collections::{BTreeMap, HashSet};

pub fn read_lsp_archive(
    bytes: &[u8],
    platform: &str,
    target: &LspTarget,
) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    super::validate_target(target, None)?;
    if cadencr_plugin_core::tab::TabPlatform::parse(platform).is_none() {
        return Err(invalid("unsupported platform"));
    }
    if bytes.len() as u64 != target.size
        || bytes.len() as u64 > MAX_LSP_ARCHIVE_BYTES
        || sha256_hex(bytes) != target.sha256
    {
        return Err(invalid(
            "archive size or SHA-256 differs from signed target",
        ));
    }
    let decoded = gunzip_bounded(bytes, MAX_LSP_UNCOMPRESSED_BYTES)
        .map_err(|_| invalid("invalid, oversized or trailing gzip data"))?;
    let mode = if target.runtime == LspRuntime::Native {
        0o755
    } else {
        0o644
    };
    let limit = if target.runtime == LspRuntime::Native {
        1
    } else {
        4096
    };
    let files = crate::theme_verify::read_tar_with_mode(&decoded, limit, true, mode)?;
    validate_paths(&files)?;
    let entry = files
        .get(&target.entry)
        .ok_or_else(|| invalid("entry is missing"))?;
    validate_lsp_entry(entry, platform, target)?;
    Ok(files)
}

/// Check the captured launch entry against its signed identity and native target.
pub fn validate_lsp_entry(
    bytes: &[u8],
    platform: &str,
    target: &LspTarget,
) -> Result<(), RegistryError> {
    if bytes.len() as u64 != target.entry_size || sha256_hex(bytes) != target.entry_sha256 {
        return Err(invalid("entry size or SHA-256 differs from signed target"));
    }
    if target.runtime == LspRuntime::Native {
        native(bytes, platform)?;
    }
    Ok(())
}

fn validate_paths(files: &BTreeMap<String, Vec<u8>>) -> Result<(), RegistryError> {
    use unicode_normalization::UnicodeNormalization as _;
    let mut portable = HashSet::new();
    let normalized = files
        .keys()
        .map(|s| s.nfc().collect::<String>().to_lowercase())
        .collect::<HashSet<_>>();
    for path in files.keys() {
        if !safe_path(path) || !portable.insert(path.nfc().collect::<String>().to_lowercase()) {
            return Err(invalid("unsafe or conflicting archive paths"));
        }
        let mut ancestor = path.as_str();
        while let Some((parent, _)) = ancestor.rsplit_once('/') {
            if normalized.contains(&parent.nfc().collect::<String>().to_lowercase()) {
                return Err(invalid("file/directory path conflict"));
            }
            ancestor = parent;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab_backend::tests::archive;
    fn target(bytes: &[u8], entry: &[u8]) -> LspTarget {
        LspTarget {
            archive: "https://github.com/acme/lsp/releases/download/v1/lsp.tar.gz".into(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            entry: "dist/server.js".into(),
            entry_sha256: sha256_hex(entry),
            entry_size: entry.len() as u64,
            runtime: LspRuntime::Node,
        }
    }
    #[test]
    fn prepared_node_bundle_is_bound_and_has_no_install_steps() {
        let js = b"process.stdin.resume();";
        let bytes = archive(&[
            ("dist/server.js", 0o644, b'0', js),
            ("node_modules/x/index.js", 0o644, b'0', b"module.exports={}"),
        ]);
        let signed = target(&bytes, js);
        assert_eq!(
            read_lsp_archive(&bytes, "linux-x86_64", &signed)
                .unwrap()
                .len(),
            2
        );
        let mut wrong = signed.clone();
        wrong.entry_sha256 = "0".repeat(64);
        assert!(read_lsp_archive(&bytes, "linux-x86_64", &wrong).is_err());
        let mut trailing = bytes.clone();
        trailing.extend(&bytes);
        assert!(read_lsp_archive(&trailing, "linux-x86_64", &target(&trailing, js)).is_err());
        for entries in [
            vec![("../server.js", 0o644, b'0', &js[..])],
            vec![("dist/server.js", 0o644, b'2', &js[..])],
            vec![("dist/server.js", 0o755, b'0', &js[..])],
        ] {
            let bytes = archive(&entries);
            assert!(read_lsp_archive(&bytes, "linux-x86_64", &target(&bytes, js)).is_err());
        }
    }
    #[test]
    fn node_bundles_reject_case_unicode_and_file_directory_conflicts() {
        let js = b"process.stdin.resume();";
        for extra in [
            "dist/Server.js",
            "dist/server.js/child",
            "../outside",
            "dist/../outside",
        ] {
            let bytes = archive(&[
                ("dist/server.js", 0o644, b'0', js),
                (extra, 0o644, b'0', js),
            ]);
            assert!(
                read_lsp_archive(&bytes, "linux-x86_64", &target(&bytes, js)).is_err(),
                "{extra}"
            );
        }
        let bytes = archive(&[
            ("dist/server.js", 0o644, b'0', js),
            ("caf\u{e9}.js", 0o644, b'0', js),
            ("cafe\u{301}.js", 0o644, b'0', js),
        ]);
        assert!(read_lsp_archive(&bytes, "linux-x86_64", &target(&bytes, js)).is_err());
        let bytes = archive(&[("dist/server.js", 0o644, b'0', js)]);
        assert!(read_lsp_archive(&bytes, "linux-aarch64", &target(&bytes, js)).is_err());
    }

    #[test]
    fn native_targets_verify_both_supported_operating_systems() {
        use cadencr_plugin_core::tab::{test_support::native_executable, TabPlatform};
        for platform in TabPlatform::ALL {
            let executable = native_executable(platform);
            let bytes = archive(&[("bin/server", 0o755, b'0', &executable)]);
            let mut signed = target(&bytes, &executable);
            signed.entry = "bin/server".into();
            signed.runtime = LspRuntime::Native;
            read_lsp_archive(&bytes, platform.as_str(), &signed).unwrap();
            let script = b"#!/bin/sh\necho hi\n";
            let bytes = archive(&[("bin/server", 0o755, b'0', script)]);
            signed.sha256 = sha256_hex(&bytes);
            signed.size = bytes.len() as u64;
            signed.entry_sha256 = sha256_hex(script);
            signed.entry_size = script.len() as u64;
            assert!(read_lsp_archive(&bytes, platform.as_str(), &signed).is_err());
        }
    }
}
