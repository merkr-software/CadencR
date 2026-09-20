use std::fs;
use std::process::{Command, Output};

fn mirror(input: &std::path::Path, commit: &str, confirmation: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "mirror-publication", "--submission"])
        .arg(input)
        .args(["--repository", "acme/registry", "--registry-commit", commit])
        .arg("--directory")
        .arg(input.with_file_name("staging"))
        .args(["--confirm-repository", confirmation])
        .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
        .output()
        .unwrap()
}

#[test]
fn mirror_refuses_confirmation_commit_and_submission_before_credentials() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("submission.json");
    fs::write(&input, "{").unwrap();
    for (commit, confirmation, expected) in [
        ("a".repeat(40), "other/registry", "confirmation"),
        ("A".repeat(40), "acme/registry", "40 lowercase hex"),
        ("a".repeat(40), "acme/registry", "invalid submission JSON"),
    ] {
        let output = mirror(&input, &commit, confirmation);
        assert_eq!(output.status.code(), Some(1));
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(diagnostic["code"], "REGISTRY_MIRROR_FAILED");
        let message = diagnostic["message"].as_str().unwrap();
        assert!(message.contains(expected), "{message}");
        assert!(
            !message.contains("TOKEN"),
            "credentials read before local validation"
        );
        assert!(output.stdout.is_empty());
    }
    assert!(!root.path().join("staging").exists());
}

#[test]
fn mirror_requires_explicit_destination_confirmation() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args([
            "--json",
            "registry",
            "mirror-publication",
            "--submission",
            "missing.json",
            "--repository",
            "acme/registry",
            "--registry-commit",
            &"a".repeat(40),
            "--directory",
            "unused",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(diagnostic["code"], "CLI_USAGE_ERROR");
    assert!(diagnostic["message"]
        .as_str()
        .unwrap()
        .contains("--confirm-repository"));
}
