#[path = "support/publication.rs"]
mod publication;
use publication::submission;

use std::fs;
use std::process::{Command, Output};

fn promote(input: &std::path::Path, commit: &str, confirmation: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "promote-publication", "--submission"])
        .arg(input)
        .args(["--repository", "acme/registry", "--registry-commit", commit])
        .arg("--directory")
        .arg(input.with_file_name("staging"))
        .args([
            "--confirm-repository",
            confirmation,
            "--confirm-publish",
            "provider-acme-agent-v1.2.3",
        ])
        .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
        .output()
        .unwrap()
}

#[test]
fn promote_refuses_confirmation_commit_and_submission_before_credentials() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("submission.json");
    fs::write(&input, "{").unwrap();
    for (commit, confirmation, expected) in [
        ("a".repeat(40), "other/registry", "confirmation"),
        ("A".repeat(40), "acme/registry", "40 lowercase hex"),
        ("a".repeat(40), "acme/registry", "invalid submission JSON"),
    ] {
        let output = promote(&input, &commit, confirmation);
        assert_eq!(output.status.code(), Some(1));
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(diagnostic["code"], "REGISTRY_PROMOTION_FAILED");
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
fn promote_requires_explicit_destination_confirmation() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args([
            "--json",
            "registry",
            "promote-publication",
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

#[test]
fn promotion_checks_exact_release_tag_before_credentials() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("submission.json");
    fs::write(&input, serde_json::to_vec(&submission()).unwrap()).unwrap();
    let run = |tag: &str| {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["--json", "registry", "promote-publication", "--submission"])
            .arg(&input)
            .args([
                "--repository",
                "acme/registry",
                "--registry-commit",
                &"a".repeat(40),
            ])
            .arg("--directory")
            .arg(root.path().join("staging"))
            .args([
                "--confirm-repository",
                "acme/registry",
                "--confirm-publish",
                tag,
            ])
            .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
            .output()
            .unwrap()
    };
    for (tag, message) in [
        ("wrong-tag", "publish confirmation"),
        (
            "provider-acme-agent-v1.2.3",
            "CADENCR_REGISTRY_GITHUB_TOKEN is required",
        ),
    ] {
        let result = run(tag);
        assert_eq!(result.status.code(), Some(1));
        let diagnostic: serde_json::Value = serde_json::from_slice(&result.stderr).unwrap();
        assert_eq!(diagnostic["code"], "REGISTRY_PROMOTION_FAILED");
        assert!(diagnostic["message"].as_str().unwrap().contains(message));
        assert!(result.stdout.is_empty());
    }
    assert!(!root.path().join("staging").exists());
}

#[test]
fn fully_staged_promotion_requires_a_matching_mirror_receipt() {
    use sha2::{Digest as _, Sha256};
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("submission.json");
    let staging = root.path().join("staging");
    let bytes = b"inert archive";
    let mut submission = submission();
    submission["package"]["agent"]["distribution"]["binary"]["linux-x86_64"]["sha256"] =
        serde_json::json!(Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>());
    fs::write(&input, serde_json::to_vec(&submission).unwrap()).unwrap();
    fs::create_dir(&staging).unwrap();
    let plan =
        cadencr_registry_core::create_publication_plan(&submission, "acme/registry").unwrap();
    fs::write(
        staging.join(plan["targets"][0]["asset"].as_str().unwrap()),
        bytes,
    )
    .unwrap();
    cadencr_registry_publisher::stage_publication(
        cadencr_registry_publisher::StageRequest::builder()
            .submission(&input)
            .repository("acme/registry")
            .directory(&staging)
            .build(),
    )
    .unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["--json", "registry", "promote-publication", "--submission"])
            .arg(&input)
            .args([
                "--repository",
                "acme/registry",
                "--registry-commit",
                &"a".repeat(40),
            ])
            .arg("--directory")
            .arg(&staging)
            .args([
                "--confirm-repository",
                "acme/registry",
                "--confirm-publish",
                "provider-acme-agent-v1.2.3",
            ])
            .env("CADENCR_REGISTRY_GITHUB_TOKEN", "inert-fixture-token")
            // No request can reach GitHub even if a future regression crosses the local gate.
            .env("HTTPS_PROXY", "http://127.0.0.1:9")
            .env("https_proxy", "http://127.0.0.1:9")
            .env("NO_PROXY", "")
            .env("no_proxy", "")
            .output()
            .unwrap()
    };
    for (index, message) in [
        "mirror receipt is required",
        "existing mirror receipt is invalid",
    ]
    .iter()
    .enumerate()
    {
        if index == 1 {
            fs::write(staging.join("mirror-receipt.json"), "{}").unwrap();
        }
        let output = run();
        assert_eq!(output.status.code(), Some(1));
        let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(diagnostic["code"], "REGISTRY_PROMOTION_FAILED");
        assert!(diagnostic["message"].as_str().unwrap().contains(message));
        assert!(!staging.join("publication-receipt.json").exists());
        assert!(!staging.join(".mirror.lock").exists());
    }
}
