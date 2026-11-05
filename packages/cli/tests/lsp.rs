//! LSP authoring through the real offline binary; no server code is executed.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
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

#[cfg(unix)]
fn native_targets(root: &Path) -> (Value, Vec<(String, PathBuf, PathBuf)>) {
    use cadencr_plugin_core::tab::{test_support::native_executable, TabPlatform};
    use std::os::unix::fs::PermissionsExt;
    let mut package: Value = serde_json::from_str(include_str!(
        "../../../tooling/marketplace-registry/examples/lsp/package.node.json"
    ))
    .unwrap();
    let mut targets = serde_json::Map::new();
    let mut trees = Vec::new();
    for platform in TabPlatform::ALL {
        let target = platform.as_str();
        let folder = root.join(target);
        std::fs::create_dir(&folder).unwrap();
        let entry = folder.join("server");
        std::fs::write(&entry, native_executable(platform)).unwrap();
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(folder.join("LICENSE"), "upstream notice").unwrap();
        let archive = root.join(format!("{target}.tar.gz"));
        let mut receipt = success(&run(&[
            "registry",
            "pack-lsp",
            "--directory",
            path(&folder),
            "--target",
            target,
            "--runtime",
            "native",
            "--entry",
            "server",
            "--output",
            path(&archive),
        ]));
        for field in ["kind", "target"] {
            receipt.as_object_mut().unwrap().remove(field);
        }
        receipt["archive"] = json!(format!(
            "https://github.com/acme/language-server/releases/download/v1.0.0/{target}.tar.gz"
        ));
        targets.insert(target.to_string(), receipt);
        trees.push((target.to_string(), folder, archive));
    }
    package["package"]["lsp"]["distribution"]["binary"] = Value::Object(targets);
    for (_, folder, _) in &trees {
        write_json(&folder.join("lsp.json"), &package);
    }
    (package, trees)
}

#[cfg(unix)]
#[test]
fn explicit_native_targets_validate_the_complete_manifest_and_exact_archives_without_execution() {
    let root = tempfile::tempdir().unwrap();
    let (package, trees) = native_targets(root.path());
    for (target, folder, archive) in &trees {
        let args = [
            "plugin",
            "validate",
            path(folder),
            "--kind",
            "lsp",
            "--target",
            target,
            "--archive",
            path(archive),
        ];
        let receipt = success(&run(&args));
        assert!(receipt["message"]
            .as_str()
            .unwrap()
            .contains("signed archive verified"));
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(folder.join("lsp.json")).unwrap())
                .unwrap(),
            package
        );
        assert!(!run(&["plugin", "validate", path(folder), "--kind", "lsp"])
            .status
            .success());
        let foreign = trees.iter().find(|(other, _, _)| other != target).unwrap();
        assert!(!run(&[
            "plugin",
            "validate",
            path(folder),
            "--kind",
            "lsp",
            "--target",
            target,
            "--archive",
            path(&foreign.2)
        ])
        .status
        .success());
        let mut invalid = package.clone();
        invalid["package"]["lsp"]["distribution"]["binary"][&foreign.0]["sha256"] =
            json!("invalid");
        write_json(&folder.join("lsp.json"), &invalid);
        assert!(
            !run(&args).status.success(),
            "unselected target metadata must still validate"
        );
        write_json(&folder.join("lsp.json"), &package);
        std::fs::write(folder.join("server"), "changed").unwrap();
        assert!(
            !run(&args).status.success(),
            "the local entry must still match the signed archive"
        );
    }
}

#[test]
fn lsp_target_selection_refuses_ambiguous_or_unrelated_inputs() {
    let root = tempfile::tempdir().unwrap();
    let folder = &root.path().join("runtime");
    std::fs::create_dir(folder).unwrap();
    std::fs::write(folder.join("server.js"), "throw new Error('never execute')").unwrap();
    let receipt = success(&pack(folder, &root.path().join("archive.tar.gz")));
    author_package(folder, &receipt);
    for args in [
        vec![
            "plugin",
            "validate",
            path(folder),
            "--kind",
            "lsp",
            "--target",
            "darwin-aarch64",
        ],
        vec![
            "plugin",
            "validate",
            path(folder),
            "--kind",
            "theme",
            "--target",
            "linux-x86_64",
        ],
        vec![
            "plugin",
            "validate",
            path(folder),
            "--kind",
            "lsp",
            "--archive",
            "archive.tar.gz",
        ],
    ] {
        assert!(!run(&args).status.success());
    }
}
