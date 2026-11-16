use std::fs;
use std::path::Path;
use std::process::{Command, Output};

#[path = "support/publication.rs"]
mod publication;

const TOKEN: &str = "inert-restore-fixture-token";

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
        ("--confirm-restore", "provider-acme-agent-v1.2.3".into()),
    ];
    for (flag, value) in overrides {
        args.iter_mut().find(|(key, _)| key == flag).unwrap().1 = (*value).into();
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
    command.args(["--json", "registry", "restore-publication"]);
    for (flag, value) in args {
        command.arg(flag).arg(value);
    }
    command.env_remove("CADENCR_REGISTRY_GITHUB_TOKEN");
    if token {
        command.env("CADENCR_REGISTRY_GITHUB_TOKEN", TOKEN);
    }
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
    assert_eq!(value["code"], "REGISTRY_PUBLICATION_RESTORE_FAILED");
    let message = value["message"].as_str().unwrap();
    assert!(message.contains(expected), "{value}");
    assert!(!message.contains(TOKEN));
}

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("submission.json"),
        serde_json::to_vec(&publication::submission()).unwrap(),
    )
    .unwrap();
    fs::create_dir(root.path().join("staging")).unwrap();
    root
}

#[test]
fn restore_requires_explicit_confirmation_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "restore-publication"])
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
        "--confirm-restore",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn confirmations_and_submission_precede_credentials() {
    let root = fixture();
    for (flag, value, expected) in [
        (
            "--confirm-repository",
            "other/registry",
            "repository confirmation",
        ),
        ("--registry-commit", "main", "40 lowercase hex"),
        ("--confirm-restore", "other-tag", "restore confirmation"),
    ] {
        diagnostic(run(root.path(), &[(flag, value)], false), expected);
    }
    diagnostic(
        run(root.path(), &[], false),
        "CADENCR_REGISTRY_GITHUB_TOKEN is required",
    );
    fs::write(root.path().join("submission.json"), "{").unwrap();
    diagnostic(run(root.path(), &[], false), "invalid submission JSON");
    assert_eq!(
        fs::read_dir(root.path().join("staging")).unwrap().count(),
        0
    );
}

#[test]
fn empty_workspace_bad_receipts_fail_before_network() {
    for name in [
        "staging-receipt.json",
        "mirror-receipt.json",
        "publication-receipt.json",
    ] {
        let root = fixture();
        let staging = root.path().join("staging");
        fs::write(staging.join(name), "{}").unwrap();
        diagnostic(run(root.path(), &[], true), "receipt");
        assert_eq!(fs::read(staging.join(name)).unwrap(), b"{}");
        assert_eq!(fs::read_dir(staging).unwrap().count(), 1);
    }
}

#[cfg(unix)]
#[test]
fn symlink_directory_and_foreign_lock_are_preserved() {
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
    fs::write(staging.join(".mirror.lock"), b"foreign owner").unwrap();
    diagnostic(run(root.path(), &[], true), "lock");
    assert_eq!(
        fs::read(staging.join(".mirror.lock")).unwrap(),
        b"foreign owner"
    );
    assert_eq!(fs::read_dir(staging).unwrap().count(), 1);
}
