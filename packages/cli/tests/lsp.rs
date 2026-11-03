//! LSP authoring through the real offline binary; no server code is executed.
use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Output};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .arg("--json")
        .args(args)
        .output()
        .unwrap()
}
fn path(path: &Path) -> &str {
    path.to_str().unwrap()
}
fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}
fn pack(folder: &Path, output: &Path) -> Output {
    run(&[
        "registry",
        "pack-lsp",
        "--directory",
        path(folder),
        "--target",
        "linux-x86_64",
        "--runtime",
        "node",
        "--entry",
        "server.js",
        "--output",
        path(output),
    ])
}
fn success(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn author_package(folder: &Path, receipt: &Value) -> Value {
    let mut package: Value = serde_json::from_str(include_str!(
        "../../../tooling/marketplace-registry/examples/lsp/package.node.json"
    ))
    .unwrap();
    let mut target = receipt.clone();
    for field in ["target", "kind"] {
        target.as_object_mut().unwrap().remove(field);
    }
    target["archive"] =
        json!("https://github.com/acme/language-server/releases/download/v1.0.0/lsp.tar.gz");
    package["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"] = target;
    write_json(&folder.join("lsp.json"), &package);
    package
}

#[test]
fn real_cli_lsp_packing_validation_and_plugin_members_bind_captured_entries() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("lsp");
    std::fs::create_dir(&folder).unwrap();
    // If any authoring operation executed this, it would fail immediately.
    std::fs::write(
        folder.join("server.js"),
        "throw new Error('must never execute')",
    )
    .unwrap();
    let archive = root.path().join("server.tar.gz");
    let receipt = success(&pack(&folder, &archive));
    let second = success(&pack(&folder, &root.path().join("second.tar.gz")));
    assert_eq!(receipt["sha256"], second["sha256"]);
    assert!(receipt.get("entry_sha256").is_some());
    assert!(!pack(&folder, &archive).status.success());
    let package = author_package(&folder, &receipt);
    success(&run(&[
        "plugin",
        "validate",
        path(&folder),
        "--kind",
        "lsp",
    ]));
    write_json(
        &root.path().join("plugin.json"),
        &json!({"schema_version":1,"kind":"plugin","id":"example-plugin","name":"Example","version":"1.0.0","contributes":[{"kind":"lsp","path":"lsp"}]}),
    );
    success(&run(&[
        "plugin",
        "validate",
        path(root.path()),
        "--kind",
        "plugin",
    ]));
    let mut mismatched = package;
    mismatched["package"]["lsp"]["version"] = json!("2.0.0");
    write_json(&folder.join("lsp.json"), &mismatched);
    assert!(
        !run(&["plugin", "validate", path(root.path()), "--kind", "plugin"])
            .status
            .success()
    );
    std::fs::write(folder.join("server.js"), "tampered").unwrap();
    let failed = run(&["plugin", "validate", path(&folder), "--kind", "lsp"]);
    assert_eq!(failed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&failed.stderr).contains("SHA-256"));
}

#[cfg(unix)]
#[test]
fn lsp_authoring_refuses_metadata_and_entry_links_without_following_them() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("lsp");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("server.js"), "process.stdin.resume()").unwrap();
    let receipt = success(&pack(&folder, &root.path().join("server.tar.gz")));
    author_package(&folder, &receipt);
    std::fs::rename(folder.join("lsp.json"), root.path().join("metadata.json")).unwrap();
    std::os::unix::fs::symlink(root.path().join("metadata.json"), folder.join("lsp.json")).unwrap();
    assert!(
        !run(&["plugin", "validate", path(&folder), "--kind", "lsp"])
            .status
            .success()
    );
    std::fs::remove_file(folder.join("lsp.json")).unwrap();
    author_package(&folder, &receipt);
    std::fs::rename(folder.join("server.js"), root.path().join("real.js")).unwrap();
    std::os::unix::fs::symlink(root.path().join("real.js"), folder.join("server.js")).unwrap();
    assert!(
        !run(&["plugin", "validate", path(&folder), "--kind", "lsp"])
            .status
            .success()
    );
    let output = root.path().join("refused.tar.gz");
    assert!(!pack(&folder, &output).status.success());
    assert!(!output.exists());
}
