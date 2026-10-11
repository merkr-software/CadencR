use std::process::{Command, Output};

#[path = "support/catalog.rs"]
mod catalog;
use catalog::Fixture;

const CODE: &str = "REGISTRY_CATALOG_PUBLICATION_FAILED";

fn diagnostic(output: Output, expected: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], CODE);
    assert!(
        value["message"].as_str().unwrap().contains(expected),
        "{value}"
    );
}

#[test]
fn catalog_publication_requires_ten_explicit_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "publish-catalog"])
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
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn explicit_bindings_and_signature_precede_credentials() {
    let fixture = Fixture::new();
    diagnostic(
        fixture.run(
            "publish-catalog",
            &[("--confirm-repository", "other/repository")],
        ),
        "repository confirmation",
    );
    diagnostic(
        fixture.run("publish-catalog", &[("--registry-commit", "main")]),
        "40 lowercase hex",
    );
    diagnostic(
        fixture.run("publish-catalog", &[("--key-id", "bad key")]),
        "key id",
    );
    diagnostic(
        fixture.run("publish-catalog", &[("--confirm-publish", "catalog-wrong")]),
        "publish confirmation",
    );
    diagnostic(
        fixture.run("publish-catalog", &[]),
        "CADENCR_REGISTRY_GITHUB_TOKEN is required",
    );
    let path = fixture.root.path().join("catalog.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["signed"]["packages"][0]["agent"]["name"] = "tampered".into();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    diagnostic(
        fixture.run("publish-catalog", &[]),
        "signature verification",
    );
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn manifest_repository_binding_precedes_credentials() {
    let fixture = Fixture::new();
    let path = fixture.root.path().join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["repository"] = "other/registry".into();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    diagnostic(fixture.run("publish-catalog", &[]), "repository");
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(unix)]
#[test]
fn symlink_publication_directory_is_refused_without_locking_target() {
    let fixture = Fixture::new();
    let link = fixture.root.path().join("linked");
    std::os::unix::fs::symlink(fixture.root.path().join("publication"), &link).unwrap();
    diagnostic(
        fixture.run(
            "publish-catalog",
            &[("--directory", link.to_str().unwrap())],
        ),
        "non-symlink directory",
    );
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}
