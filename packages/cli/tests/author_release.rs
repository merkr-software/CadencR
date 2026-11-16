use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    std::fs::write(root.join("archive"), b"archive").unwrap();
    std::fs::write(root.join("metadata"), b"archive").unwrap();
    let sha: String = Sha256::digest(b"archive")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let request = root.join("request.json");
    let value = json!({"schema_version":1,"repository":"acme/provider",
        "expected_repository_id":42,"expected_account":"author","tag":"v1",
        "source_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "release_notes":"notes","prerelease":false,
        "archive":{"name":"archive","size":7,"sha256":sha},
        "metadata":{"name":"metadata","size":7,"sha256":sha}});
    std::fs::write(&request, serde_json::to_vec(&value).unwrap()).unwrap();
    (temp, root, request)
}
fn run(root: &Path, request: &Path, confirmation: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
    command
        .env_remove("CADENCR_AUTHOR_GITHUB_TOKEN")
        .args(["--json", "plugin"])
        .arg(if confirmation.is_some() {
            "publish-release"
        } else {
            "inspect-release"
        })
        .arg("--request")
        .arg(request)
        .arg("--directory")
        .arg(root);
    if let Some(digest) = confirmation {
        command.arg("--confirm-request-sha256").arg(digest);
    }
    command.output().unwrap()
}
fn diagnostic(output: &Output, root: &Path) -> Value {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(root.to_str().unwrap()));
    serde_json::from_slice(&output.stderr).unwrap()
}
#[test]
fn inspect_emits_exact_single_json_receipt_and_publish_checks_before_token() {
    let (_temp, root, request) = fixture();
    let output = run(&root, &request, None);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: String = Sha256::digest(std::fs::read(&request).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(receipt["request_sha256"], expected);
    assert_eq!(receipt["local_only"], true);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(root.to_str().unwrap()));
    let output = run(&root, &request, Some("wrong"));
    assert_eq!(
        diagnostic(&output, &root)["message"],
        "request SHA-256 confirmation does not match"
    );
    let output = run(&root, &request, Some(&expected));
    assert_eq!(
        diagnostic(&output, &root)["message"],
        "CADENCR_AUTHOR_GITHUB_TOKEN is required"
    );
}
#[test]
fn malformed_schema_traversal_and_wrong_sizes_are_local_failures() {
    for change in [
        json!({"unknown":true}),
        json!({"schema_version":2}),
        json!({"archive":{"name":"../archive","size":7,"sha256":"a"}}),
    ] {
        let (_temp, root, request) = fixture();
        let mut value: Value = serde_json::from_slice(&std::fs::read(&request).unwrap()).unwrap();
        for (key, replacement) in change.as_object().unwrap() {
            value[key] = replacement.clone();
        }
        std::fs::write(&request, serde_json::to_vec(&value).unwrap()).unwrap();
        let output = run(&root, &request, Some("wrong"));
        assert_eq!(
            diagnostic(&output, &root)["message"],
            "author release local validation failed"
        );
    }
    let (_temp, root, request) = fixture();
    std::fs::write(root.join("archive"), b"longer archive").unwrap();
    assert_eq!(
        diagnostic(&run(&root, &request, None), &root)["message"],
        "author release local validation failed"
    );
}
#[cfg(unix)]
#[test]
fn symlink_sources_are_refused_by_the_binary() {
    let (_temp, root, request) = fixture();
    std::fs::rename(root.join("archive"), root.join("original")).unwrap();
    std::os::unix::fs::symlink(root.join("original"), root.join("archive")).unwrap();
    assert_eq!(
        diagnostic(&run(&root, &request, None), &root)["message"],
        "author release local validation failed"
    );
}
