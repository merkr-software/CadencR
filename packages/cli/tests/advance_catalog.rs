use std::process::{Command, Output};

#[path = "support/catalog.rs"]
mod catalog;
use catalog::Fixture;

fn diagnostic(output: Output, expected: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], "REGISTRY_CATALOG_DISCOVERY_FAILED");
    assert!(
        value["message"].as_str().unwrap().contains(expected),
        "{value}"
    );
}

fn write_publication_receipt(fixture: &Fixture) {
    let bytes = std::fs::read(fixture.root.path().join("catalog.json")).unwrap();
    let digest = fixture.tag.strip_prefix("catalog-").unwrap();
    let receipt = serde_json::json!({
        "schema_version": 1, "status": "published_verified",
        "repository": "acme/registry", "registry_commit": "a".repeat(40),
        "release_id": 7, "release_tag": fixture.tag, "tag_commit": "a".repeat(40),
        "catalog_sha256": digest, "catalog_size": bytes.len(),
        "catalog_url": format!("https://github.com/acme/registry/releases/download/{}/managed-index.json", fixture.tag),
        "previous_sha256": "bootstrap"
    });
    std::fs::write(
        fixture
            .root
            .path()
            .join("publication/catalog-publication-receipt.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
}

#[test]
fn discovery_requires_twelve_explicit_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "advance-catalog"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], "CLI_USAGE_ERROR");
    for flag in [
        "--catalog",
        "--previous-index",
        "--public-key",
        "--key-id",
        "--manifest",
        "--repository",
        "--registry-commit",
        "--directory",
        "--confirm-repository",
        "--confirm-publish",
        "--discovery-branch",
        "--confirm-discovery",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn confirmations_and_required_receipt_precede_credentials() {
    let fixture = Fixture::new();
    for (flag, value, message) in [
        ("--registry-commit", "main", "40 lowercase hex"),
        ("--key-id", "bad key", "key id"),
        ("--discovery-branch", "../main", "discovery branch"),
        (
            "--confirm-repository",
            "other/repo",
            "repository confirmation",
        ),
        ("--confirm-publish", "catalog-wrong", "publish confirmation"),
        (
            "--confirm-discovery",
            "https://example.com/index.json",
            "discovery confirmation",
        ),
    ] {
        diagnostic(fixture.run("advance-catalog", &[(flag, value)]), message);
    }
    diagnostic(fixture.run("advance-catalog", &[]), "receipt");
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
    write_publication_receipt(&fixture);
    diagnostic(
        fixture.run("advance-catalog", &[]),
        "CADENCR_REGISTRY_GITHUB_TOKEN is required",
    );
    assert!(!fixture
        .root
        .path()
        .join("publication/.catalog.lock")
        .exists());
}

#[test]
fn malformed_and_conflicting_receipts_precede_credentials() {
    let fixture = Fixture::new();
    write_publication_receipt(&fixture);
    let path = fixture
        .root
        .path()
        .join("publication/discovery-receipt.json");
    for bytes in [b"null".as_slice(), b"{}", b"invalid"] {
        std::fs::write(&path, bytes).unwrap();
        diagnostic(fixture.run("advance-catalog", &[]), "receipt");
    }
    assert!(!fixture
        .root
        .path()
        .join("publication/.catalog.lock")
        .exists());
}

#[cfg(unix)]
#[test]
fn symlink_directory_and_receipt_are_refused() {
    let fixture = Fixture::new();
    let directory = fixture.root.path().join("publication");
    let link = fixture.root.path().join("linked");
    std::os::unix::fs::symlink(&directory, &link).unwrap();
    diagnostic(
        fixture.run(
            "advance-catalog",
            &[("--directory", link.to_str().unwrap())],
        ),
        "non-symlink directory",
    );
    std::os::unix::fs::symlink(
        fixture.root.path().join("missing"),
        directory.join("catalog-publication-receipt.json"),
    )
    .unwrap();
    diagnostic(fixture.run("advance-catalog", &[]), "receipt");
    assert!(!directory.join(".catalog.lock").exists());
}

#[test]
fn tampered_signature_is_rejected_with_discovery_diagnostic() {
    let fixture = Fixture::new();
    let path = fixture.root.path().join("catalog.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["signed"]["packages"][0]["agent"]["name"] = "tampered".into();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    diagnostic(
        fixture.run("advance-catalog", &[]),
        "signature verification",
    );
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(unix)]
#[test]
fn symlink_lock_is_rejected_before_credentials_without_touching_target() {
    let fixture = Fixture::new();
    write_publication_receipt(&fixture);
    let target = fixture.root.path().join("foreign-lock");
    std::fs::write(&target, b"foreign-owner").unwrap();
    let lock = fixture.root.path().join("publication/.catalog.lock");
    std::os::unix::fs::symlink(&target, &lock).unwrap();
    diagnostic(fixture.run("advance-catalog", &[]), "symbolic link");
    assert_eq!(std::fs::read(&target).unwrap(), b"foreign-owner");
    assert!(std::fs::symlink_metadata(lock)
        .unwrap()
        .file_type()
        .is_symlink());
}
