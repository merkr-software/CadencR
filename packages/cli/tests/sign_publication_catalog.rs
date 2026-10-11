use std::path::Path;
use std::process::{Command, Output};

fn sign(manifest: &Path, output: &Path, key_id: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args([
            "--json",
            "registry",
            "sign-publication-catalog",
            "--manifest",
        ])
        .arg(manifest)
        .args([
            "--generated-at",
            "2099-01-01T00:00:00Z",
            "--expires-at",
            "2099-01-02T00:00:00Z",
            "--private-key",
            "missing-private.pem",
            "--key-id",
            key_id,
            "--output",
        ])
        .arg(output)
        .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
        .output()
        .unwrap()
}

fn diagnostic(output: Output, code: &str, message: &str, status: i32) {
    assert_eq!(output.status.code(), Some(status));
    assert!(output.stdout.is_empty());
    let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(diagnostic["code"], code);
    assert!(
        diagnostic["message"].as_str().unwrap().contains(message),
        "{diagnostic}"
    );
}

#[test]
fn catalog_signing_requires_all_six_explicit_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "sign-publication-catalog"])
        .output()
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(value["code"], "CLI_USAGE_ERROR");
    for flag in [
        "--manifest",
        "--generated-at",
        "--expires-at",
        "--private-key",
        "--key-id",
        "--output",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn output_and_key_policy_precede_manifest_reads_and_signing() {
    let root = tempfile::tempdir().unwrap();
    let manifest = root.path().join("missing.json");
    let output = root.path().join("existing.json");
    std::fs::write(&output, "keep-original").unwrap();
    diagnostic(
        sign(&manifest, &output, "BAD KEY"),
        "OUTPUT_WRITE_FAILED",
        "output already exists",
        3,
    );
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "keep-original");
    let absent = root.path().join("absent.json");
    diagnostic(
        sign(&manifest, &absent, "BAD KEY"),
        "REGISTRY_CATALOG_SIGNING_FAILED",
        "signing key id is invalid",
        1,
    );
    assert!(!absent.exists());
    std::fs::write(&manifest, "{").unwrap();
    diagnostic(
        sign(&manifest, &absent, "catalog-key"),
        "REGISTRY_CATALOG_SIGNING_FAILED",
        "manifest",
        1,
    );
    assert!(!absent.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
}

#[cfg(unix)]
#[test]
fn catalog_output_refuses_symlink_parent_and_dangling_destination() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real");
    let linked = root.path().join("linked");
    std::fs::create_dir(&real).unwrap();
    symlink(&real, &linked).unwrap();
    diagnostic(
        sign(
            &root.path().join("missing.json"),
            &linked.join("new.json"),
            "key",
        ),
        "OUTPUT_WRITE_FAILED",
        "non-symlink directory",
        3,
    );
    let dangling = root.path().join("dangling.json");
    symlink(root.path().join("absent.json"), &dangling).unwrap();
    diagnostic(
        sign(&root.path().join("missing.json"), &dangling, "key"),
        "OUTPUT_WRITE_FAILED",
        "output already exists",
        3,
    );
    assert!(std::fs::symlink_metadata(dangling)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_dir(real).unwrap().count(), 0);
}
