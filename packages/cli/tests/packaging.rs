use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Fixture {
    root: tempfile::TempDir,
    staging: PathBuf,
    metadata: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("staging");
        std::fs::create_dir_all(staging.join("bin")).unwrap();
        std::fs::create_dir(staging.join("assets")).unwrap();
        std::fs::write(staging.join("bin/provider"), b"#!/bin/sh\necho provider\n").unwrap();
        make_executable(&staging.join("bin/provider"));
        std::fs::write(staging.join("assets/icon.svg"), b"<svg/>\n").unwrap();
        std::fs::write(staging.join("README.md"), b"read me\n").unwrap();
        std::fs::write(staging.join("LICENSE"), b"license\n").unwrap();
        let metadata = root.path().join("package.json");
        std::fs::write(
            &metadata,
            serde_json::to_vec(&serde_json::json!({
                "agent": {
                    "id": "provider", "name": "Provider", "version": "1.0.0",
                    "description": "Test provider",
                    "distribution": { "binary": { "darwin-aarch64": {
                        "archive": "https://example.invalid/provider.tar.gz",
                        "cmd": "bin/provider", "sha256": "0".repeat(64)
                    }}}
                },
                "host": {
                    "publisher": "publisher",
                    "compatibility": { "min_app_version": "0.12.0" },
                    "assets": {
                        "icon": "assets/icon.svg", "readme": "README.md", "license": "LICENSE"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            root,
            staging,
            metadata,
        }
    }

    fn rust(&self, output: &Path) -> Output {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["registry", "pack-provider", "--package"])
            .arg(&self.metadata)
            .args(["--target", "darwin-aarch64", "--directory"])
            .arg(&self.staging)
            .arg("--output")
            .arg(output)
            .output()
            .unwrap()
    }
}

#[test]
fn rust_archive_matches_frozen_legacy_tar_and_receipt_contract() {
    let fixture = Fixture::new();
    let rust_path = fixture.root.path().join("rust.tar.gz");
    let rust = fixture.rust(&rust_path);
    assert!(
        rust.status.success(),
        "{}",
        String::from_utf8_lossy(&rust.stderr)
    );
    let rust_bytes = std::fs::read(&rust_path).unwrap();
    // Frozen legacy pack-provider output: compare the exact tar wire bytes, not gzip
    // compressor output (see fixtures/legacy-v1/README.md for capture provenance).
    use sha2::{Digest as _, Sha256};
    let legacy_tar = include_bytes!("fixtures/legacy-v1/provider.tar");
    assert_eq!(
        Sha256::digest(legacy_tar)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        "418003582162f591358df410f7336251843509aeb4abfa1cf86ad11487201beb"
    );
    assert_eq!(decode_gzip(&rust_bytes).as_slice(), legacy_tar.as_slice());
    let rust_receipt: serde_json::Value = serde_json::from_slice(&rust.stdout).unwrap();
    assert_eq!(rust_receipt["target"], "darwin-aarch64");
    assert_digest_and_size(&rust_receipt, &rust_bytes);
    assert_eq!(
        rust_receipt["archive"],
        rust_path.to_string_lossy().as_ref()
    );
}

fn decode_gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read as _;
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut decoded)
        .unwrap();
    decoded
}

fn assert_digest_and_size(receipt: &serde_json::Value, bytes: &[u8]) {
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(receipt["sha256"], digest);
    assert_eq!(receipt["size"], bytes.len());
}

#[test]
fn packaging_refuses_overwrite_nested_output_and_missing_files() {
    let fixture = Fixture::new();
    let existing = fixture.root.path().join("existing.tar.gz");
    std::fs::write(&existing, b"keep").unwrap();
    let overwrite = fixture.rust(&existing);
    assert_eq!(overwrite.status.code(), Some(1));
    assert_eq!(std::fs::read(existing).unwrap(), b"keep");

    let nested = fixture.rust(&fixture.staging.join("nested.tar.gz"));
    assert_eq!(nested.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&nested.stderr).contains("inside staging"));

    std::fs::remove_file(fixture.staging.join("assets/icon.svg")).unwrap();
    let missing = fixture.rust(&fixture.root.path().join("missing.tar.gz"));
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("icon asset is missing"));
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}
