use std::fs;
use std::process::Command;

fn cadencr() -> Command {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
}

#[test]
fn stage_publication_rejects_invalid_submission_before_network_or_output() {
    let root = tempfile::tempdir().unwrap();
    let submission = root.path().join("submission.json");
    let staging = root.path().join("staging");
    fs::write(&submission, b"{").unwrap();
    let output = cadencr()
        .args(["registry", "stage-publication", "--submission"])
        .arg(&submission)
        .args(["--repository", "acme/registry", "--directory"])
        .arg(&staging)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("REGISTRY_PUBLICATION_STAGING_FAILED"));
    assert!(!staging.exists());
}

#[test]
fn stage_publication_failure_has_stable_json_diagnostic() {
    let root = tempfile::tempdir().unwrap();
    let submission = root.path().join("submission.json");
    fs::write(&submission, b"{}").unwrap();
    let output = cadencr()
        .args(["--json", "registry", "stage-publication", "--submission"])
        .arg(&submission)
        .args(["--repository", "acme/registry", "--directory"])
        .arg(root.path().join("staging"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(diagnostic["ok"], false);
    assert_eq!(diagnostic["code"], "REGISTRY_PUBLICATION_STAGING_FAILED");
    assert!(diagnostic["message"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
}

#[test]
fn stage_publication_requires_all_explicit_arguments() {
    let output = cadencr()
        .args(["--json", "registry", "stage-publication"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let diagnostic: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(diagnostic["code"], "CLI_USAGE_ERROR");
}

#[test]
fn stage_publication_replays_verified_local_assets_and_rejects_tampering() {
    use serde_json::json;
    use sha2::{Digest as _, Sha256};
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("submission.json");
    let staging = root.path().join("staging");
    let mut package: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
    )))
    .unwrap();
    let repository = "https://github.com/acme/provider";
    let digest = Sha256::digest(b"inert archive fixture")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    package["agent"]["repository"] = json!(repository);
    package["agent"]["distribution"] = json!({"binary":{"linux-x86_64":{
        "archive":format!("{repository}/releases/download/v1/fixture.tgz"),
        "cmd":"bin/provider", "sha256":digest
    }}});
    let submission = json!({
        "schema_version":1, "package":package,
        "source":{"repository":repository,"commit":"a".repeat(40),"tag":"v1"},
        "changelog":"Local verification fixture"
    });
    let plan =
        cadencr_registry_core::create_publication_plan(&submission, "acme/registry").unwrap();
    fs::write(&input, serde_json::to_vec(&submission).unwrap()).unwrap();
    fs::create_dir(&staging).unwrap();
    let archive = staging.join(plan["targets"][0]["asset"].as_str().unwrap());
    fs::write(&archive, b"inert archive fixture").unwrap();
    let run = || {
        cadencr()
            .args(["--json", "registry", "stage-publication", "--submission"])
            .arg(&input)
            .args(["--repository", "acme/registry", "--directory"])
            .arg(&staging)
            .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
            .output()
            .unwrap()
    };
    let first = run();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let diagnostic: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(
        diagnostic["message"],
        "staged 1 verified publication artifacts"
    );
    let receipt = fs::read(staging.join("staging-receipt.json")).unwrap();
    assert!(run().status.success());
    assert_eq!(
        receipt,
        fs::read(staging.join("staging-receipt.json")).unwrap()
    );
    fs::write(&archive, b"tampered").unwrap();
    assert_eq!(run().status.code(), Some(1));
    assert_eq!(fs::read(archive).unwrap(), b"tampered");
    assert!(!staging.join(".stage.lock").exists());
}
