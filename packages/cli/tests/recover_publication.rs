use std::fs;
use std::path::Path;
use std::process::{Command, Output};

#[path = "support/publication.rs"]
mod publication;

const CODE: &str = "REGISTRY_PUBLICATION_RECOVERY_FAILED";

fn run(root: &Path, overrides: &[(&str, &str)], token: bool) -> Output {
    let mut args = vec![
        (
            "--submission",
            root.join("submission.json").display().to_string(),
        ),
        ("--repository", "acme/registry".into()),
        ("--registry-commit", "a".repeat(40)),
        ("--directory", root.join("staging").display().to_string()),
        ("--confirm-repository", "acme/registry".into()),
        ("--confirm-recover", "provider-acme-agent-v1.2.3".into()),
    ];
    for (flag, value) in overrides {
        args.iter_mut().find(|(key, _)| key == flag).unwrap().1 = (*value).into();
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
    command.args(["--json", "registry", "recover-publication"]);
    for (flag, value) in args {
        command.arg(flag).arg(value);
    }
    command.env_remove("CADENCR_REGISTRY_GITHUB_TOKEN");
    if token {
        command.env(
            "CADENCR_REGISTRY_GITHUB_TOKEN",
            "inert-recovery-fixture-token",
        );
    }
    // Even a regressed local gate must not reach GitHub during subprocess tests.
    command
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("https_proxy", "http://127.0.0.1:9")
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .output()
        .unwrap()
}

fn diagnostic(output: Output, expected: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], CODE);
    let message = value["message"].as_str().unwrap();
    assert!(message.contains(expected), "{value}");
    assert!(!message.contains("inert-recovery-fixture-token"));
}

fn fixture() -> tempfile::TempDir {
    use sha2::{Digest as _, Sha256};
    let root = tempfile::tempdir().unwrap();
    let bytes = b"inert recovery archive";
    let mut submission = publication::submission();
    submission["package"]["agent"]["distribution"]["binary"]["linux-x86_64"]["sha256"] =
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            .into();
    fs::write(
        root.path().join("submission.json"),
        serde_json::to_vec(&submission).unwrap(),
    )
    .unwrap();
    let staging = root.path().join("staging");
    fs::create_dir(&staging).unwrap();
    let plan =
        cadencr_registry_core::create_publication_plan(&submission, "acme/registry").unwrap();
    fs::write(
        staging.join(plan["targets"][0]["asset"].as_str().unwrap()),
        bytes,
    )
    .unwrap();
    root
}

#[test]
fn recovery_requires_all_explicit_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "recover-publication"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], "CLI_USAGE_ERROR");
    for flag in [
        "--submission",
        "--repository",
        "--registry-commit",
        "--directory",
        "--confirm-repository",
        "--confirm-recover",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn confirmation_commit_and_submission_precede_credentials() {
    let root = fixture();
    for (flag, value, message) in [
        (
            "--confirm-repository",
            "other/registry",
            "repository confirmation",
        ),
        ("--registry-commit", "main", "40 lowercase hex"),
        ("--confirm-recover", "other-tag", "recovery confirmation"),
    ] {
        diagnostic(run(root.path(), &[(flag, value)], false), message);
    }
    diagnostic(
        run(root.path(), &[], false),
        "CADENCR_REGISTRY_GITHUB_TOKEN is required",
    );
    fs::write(root.path().join("submission.json"), "{").unwrap();
    diagnostic(run(root.path(), &[], false), "invalid submission JSON");
    assert!(!root.path().join("staging/mirror-receipt.json").exists());
    assert!(!root.path().join("staging/.mirror.lock").exists());
}

#[test]
fn malformed_receipts_fail_locally_without_remote_access() {
    let root = fixture();
    let staging = root.path().join("staging");
    for name in ["mirror-receipt.json", "publication-receipt.json"] {
        let receipt = staging.join(name);
        fs::write(&receipt, "{}").unwrap();
        diagnostic(run(root.path(), &[], true), "receipt");
        assert_eq!(fs::read(&receipt).unwrap(), b"{}");
        assert!(!staging.join(".mirror.lock").exists());
        fs::remove_file(receipt).unwrap();
    }
}

#[test]
fn missing_staged_archive_refuses_source_download() {
    let root = fixture();
    let staging = root.path().join("staging");
    let archive = fs::read_dir(&staging)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::remove_file(archive).unwrap();
    diagnostic(run(root.path(), &[], true), "refuses to download sources");
    assert!(!staging.join("mirror-receipt.json").exists());
    assert!(!staging.join(".mirror.lock").exists());
}

#[cfg(unix)]
#[test]
fn symbolic_directory_and_foreign_lock_are_preserved() {
    let root = fixture();
    let staging = root.path().join("staging");
    let link = root.path().join("linked");
    std::os::unix::fs::symlink(&staging, &link).unwrap();
    diagnostic(
        run(
            root.path(),
            &[("--directory", link.to_str().unwrap())],
            true,
        ),
        "non-symlink directory",
    );
    let lock = staging.join(".mirror.lock");
    fs::write(&lock, b"foreign owner").unwrap();
    diagnostic(run(root.path(), &[], true), "lock");
    assert_eq!(fs::read(lock).unwrap(), b"foreign owner");
    assert!(!staging.join("mirror-receipt.json").exists());
}
