use std::path::Path;
use std::process::{Command, Output};

use serde_json::{json, Value};

/// The service's protocol-speaking fixture, compiled with `rustc` at test
/// time; its behavior follows the file name it is installed as.
#[path = "../../service/tests/fixtures/native_tab_backend/install.rs"]
mod native_tab_backend;

fn manifest(id: &str) -> Value {
    json!({
        "schema_version": 1,
        "kind": "tab",
        "id": id,
        "name": "Changed files graph",
        "version": "0.1.0",
        "icon": "icon.svg",
        "api_version": 1,
        "entry": "dist/index.html",
        "tab": { "label": "Graph" },
        "permissions": ["features:read", "git:read"],
        "network": {
            "allowed_origins": ["http://localhost:5173"],
            "reasoning": "Local dev server."
        }
    })
}

fn validate(folder: &Path) -> Output {
    validate_with(folder, &[])
}

fn validate_with(folder: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "plugin", "validate"])
        .arg(folder)
        .args(["--kind", "tab"])
        .args(extra)
        .output()
        .unwrap()
}

fn success_message(output: &Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice::<Value>(&output.stdout).unwrap()["message"]
        .as_str()
        .unwrap()
        .to_string()
}

fn current_platform() -> Option<&'static str> {
    use cadencr_plugin_core::tab::TabPlatform;
    TabPlatform::current().map(TabPlatform::as_str)
}

fn write_executable(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn actual_cli_validates_custom_tab_folders() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("changed-files-graph");
    std::fs::create_dir(&folder).unwrap();
    let path = folder.join("tab.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&manifest("changed-files-graph")).unwrap(),
    )
    .unwrap();
    std::fs::write(folder.join("icon.svg"), "<svg viewBox=\"0 0 24 24\"/>").unwrap();

    let valid = validate(&folder);
    assert!(
        valid.status.success(),
        "{}",
        String::from_utf8_lossy(&valid.stderr)
    );
    let report: Value = serde_json::from_slice(&valid.stdout).unwrap();
    let message = report["message"].as_str().unwrap();
    assert!(
        message.contains("valid custom tab: changed-files-graph"),
        "{message}"
    );
    assert!(message.contains("not built yet"), "{message}");
    assert!(message.contains("ORIGIN_INSECURE_LOCALHOST"), "{message}");
    assert!(message.contains("access: page only"), "{message}");

    let mut runner = manifest("changed-files-graph");
    runner["commands"] = json!([{ "program": "git", "reasoning": "history" }]);
    std::fs::write(&path, serde_json::to_vec(&runner).unwrap()).unwrap();
    let message = serde_json::from_slice::<Value>(&validate(&folder).stdout).unwrap()["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(message.contains("access: runs commands (git)"), "{message}");
    runner["commands"] = json!([{ "program": "bash", "reasoning": "anything" }]);
    std::fs::write(&path, serde_json::to_vec(&runner).unwrap()).unwrap();
    let refused = validate(&folder);
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("COMMAND_NOT_ALLOWED"));
    runner["commands"] = json!([]);
    runner["backend"] = json!({ "command": "node", "args": ["server.mjs"], "reasoning": "ports" });
    std::fs::write(&path, serde_json::to_vec(&runner).unwrap()).unwrap();
    let legacy = validate(&folder);
    assert_eq!(legacy.status.code(), Some(1));
    let legacy = String::from_utf8_lossy(&legacy.stderr).into_owned();
    assert!(legacy.contains("BACKEND_COMMAND_REMOVED"), "{legacy}");
    assert!(legacy.contains("native executables now"), "{legacy}");

    let platforms = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64"];
    let binary: serde_json::Map<String, Value> = platforms
        .iter()
        .map(|platform| {
            (
                platform.to_string(),
                json!(format!("bin/{platform}/backend")),
            )
        })
        .collect();
    runner["backend"] = json!({ "protocol": 1, "binary": binary, "reasoning": "ports" });
    std::fs::write(&path, serde_json::to_vec(&runner).unwrap()).unwrap();
    let current = current_platform();
    let mut others = platforms
        .iter()
        .filter(|platform| Some(**platform) != current);
    // This platform's binary is built; another's is a script; the last is missing.
    if let Some(current) = current {
        let header = cadencr_plugin_core::tab::test_support::native_executable(
            cadencr_plugin_core::tab::TabPlatform::parse(current).unwrap(),
        );
        write_executable(&folder.join(format!("bin/{current}/backend")), &header);
    }
    let script = others.next().unwrap();
    write_executable(
        &folder.join(format!("bin/{script}/backend")),
        b"#!/bin/sh\n",
    );
    let missing = others.next().unwrap();
    // The current platform's file is only a native header: it passes the
    // static checks but cannot run, so conformance is skipped here.
    let message = success_message(&validate_with(&folder, &["--no-run"]));
    assert!(
        message.contains(
            "native backend for darwin-aarch64, darwin-x86_64, linux-x86_64 (protocol 1), which runs with the user's rights"
        ),
        "{message}"
    );
    assert!(
        message.contains(&format!(
            "note: backend binary `bin/{script}/backend` for {script} is a `#!` script"
        )),
        "{message}"
    );
    assert!(
        message.contains(&format!(
            "note: backend binary `bin/{missing}/backend` for {missing} is not built yet: it does not exist in the tab folder"
        )),
        "{message}"
    );
    if let Some(current) = current {
        assert!(!message.contains("BACKEND_UNAVAILABLE"), "{message}");
        assert!(
            message.contains(&format!(
                "note: backend `bin/{current}/backend` was not run (--no-run)"
            )),
            "{message}"
        );
        std::fs::remove_file(folder.join(format!("bin/{current}/backend"))).unwrap();
        let unbuilt = serde_json::from_slice::<Value>(&validate(&folder).stdout).unwrap()
            ["message"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(unbuilt.contains("BACKEND_UNAVAILABLE"), "{unbuilt}");
        assert!(unbuilt.contains("is not built yet"), "{unbuilt}");
    }
    runner["backend"]["binary"] = json!({ *missing: format!("bin/{missing}/backend") });
    std::fs::write(&path, serde_json::to_vec(&runner).unwrap()).unwrap();
    let elsewhere = serde_json::from_slice::<Value>(&validate(&folder).stdout).unwrap()["message"]
        .as_str()
        .unwrap()
        .to_string();
    if let Some(current) = current {
        assert!(
            elsewhere.contains(&format!(
                "declares no binary for {current}, so it is unavailable on this platform"
            )),
            "{elsewhere}"
        );
    }

    std::fs::write(&path, serde_json::to_vec(&manifest("other-id")).unwrap()).unwrap();
    let mismatch = validate(&folder);
    assert_eq!(mismatch.status.code(), Some(1));
    let diagnostic: Value = serde_json::from_slice(&mismatch.stderr).unwrap();
    assert_eq!(diagnostic["code"], "TAB_VALIDATION_FAILED");
    assert!(diagnostic["message"]
        .as_str()
        .unwrap()
        .contains("ID_MISMATCH"));

    let mut unknown = manifest("changed-files-graph");
    unknown["script"] = json!("evil.js");
    std::fs::write(&path, serde_json::to_vec(&unknown).unwrap()).unwrap();
    assert_eq!(validate(&folder).status.code(), Some(1));

    let with_descriptor = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["plugin", "validate"])
        .arg(&folder)
        .args(["--kind", "tab", "--descriptor"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(with_descriptor.status.code(), Some(1));
}

/// A tab folder whose backend declares only this platform's binary, at
/// `bin/<platform>/<name>`.
fn backend_tab(root: &Path, platform: &str, name: &str) -> std::path::PathBuf {
    let folder = root.join("ports");
    std::fs::create_dir_all(&folder).unwrap();
    let mut document = manifest("ports");
    document.as_object_mut().unwrap().remove("icon");
    document["backend"] = json!({
        "protocol": 1,
        "binary": { platform: format!("bin/{platform}/{name}") },
        "reasoning": "Lists listening ports."
    });
    std::fs::write(folder.join("tab.json"), document.to_string()).unwrap();
    folder
}

#[test]
fn validate_runs_the_backend_through_the_conformance_checks() {
    let Some(platform) = current_platform() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let folder = backend_tab(root.path(), platform, "backend");
    native_tab_backend::install(&folder, &format!("bin/{platform}/backend"));
    let message = success_message(&validate(&folder));
    assert!(
        message.contains(&format!(
            "backend conformance on {platform}: passed (starts, ready, unknown_method, \
             malformed_line, concurrent_requests, exit_on_stdin_close, stdout_clean)"
        )),
        "{message}"
    );
    assert!(!message.contains("BACKEND_UNAVAILABLE"), "{message}");

    let skipped = success_message(&validate_with(&folder, &["--no-run"]));
    assert!(skipped.contains("was not run (--no-run)"), "{skipped}");
    assert!(!skipped.contains("conformance on"), "{skipped}");
}

#[test]
fn a_backend_failing_conformance_fails_validation() {
    let Some(platform) = current_platform() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    // `future` answers `hello` with a `ready` for protocol 2.
    let folder = backend_tab(root.path(), platform, "future");
    native_tab_backend::install(&folder, &format!("bin/{platform}/future"));
    let failed = validate(&folder);
    assert_eq!(failed.status.code(), Some(1));
    let diagnostic: Value = serde_json::from_slice(&failed.stderr).unwrap();
    assert_eq!(diagnostic["code"], "TAB_BACKEND_CONFORMANCE_FAILED");
    let message = diagnostic["message"].as_str().unwrap();
    assert!(
        message.contains(&format!(
            "backend `bin/{platform}/future` for {platform} fails the protocol conformance checks"
        )),
        "{message}"
    );
    assert!(message.contains("): ready\n"), "{message}");
    assert!(
        message.contains("FAIL  ready: `ready` has protocol 2, expected 1"),
        "{message}"
    );
    assert!(message.contains("skip  unknown_method"), "{message}");
    assert!(message.contains("stderr: (empty)"), "{message}");
    // Not run, it cannot fail.
    success_message(&validate_with(&folder, &["--no-run"]));
}

#[test]
fn a_binary_the_host_would_refuse_fails_validation() {
    use cadencr_plugin_core::tab::test_support::{elf, mach_o, native_executable, MachOSlice};
    use cadencr_plugin_core::tab::TabPlatform;
    let Some(platform) = current_platform() else {
        return;
    };
    let host = TabPlatform::parse(platform).unwrap();
    let wrong_cpu = match host {
        TabPlatform::DarwinAarch64 => mach_o(&[MachOSlice::X86_64]),
        TabPlatform::DarwinX86_64 => native_executable(TabPlatform::DarwinAarch64),
        TabPlatform::LinuxX86_64 => elf(183),
    };
    let mut cases = vec![
        (
            "script",
            b"#!/bin/sh\necho hi\n".to_vec(),
            "is a `#!` script",
        ),
        ("foreign", b"MZ\x90\x00".to_vec(), "not a native executable"),
        ("wrong-cpu", wrong_cpu, "is built for"),
    ];
    if host == TabPlatform::DarwinAarch64 {
        cases.push((
            "unsigned",
            mach_o(&[MachOSlice::Arm64Unsigned]),
            "unsigned arm64",
        ));
    }
    for (name, bytes, expected) in cases {
        let root = tempfile::tempdir().unwrap();
        let folder = backend_tab(root.path(), platform, name);
        write_executable(&folder.join(format!("bin/{platform}/{name}")), &bytes);
        for extra in [&[][..], &["--no-run"]] {
            let refused = validate_with(&folder, extra);
            assert_eq!(refused.status.code(), Some(1), "{name} {extra:?}");
            let diagnostic: Value = serde_json::from_slice(&refused.stderr).unwrap();
            assert_eq!(diagnostic["code"], "TAB_BACKEND_BINARY_REFUSED", "{name}");
            let message = diagnostic["message"].as_str().unwrap();
            assert!(message.contains(expected), "{name}: {message}");
            assert!(message.contains("refuses to start it"), "{message}");
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let folder = backend_tab(root.path(), platform, "plain");
        let path = folder.join(format!("bin/{platform}/plain"));
        write_executable(&path, &native_executable(host));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let refused = validate_with(&folder, &["--no-run"]);
        let diagnostic: Value = serde_json::from_slice(&refused.stderr).unwrap();
        assert_eq!(diagnostic["code"], "TAB_BACKEND_BINARY_REFUSED");
        assert!(diagnostic["message"]
            .as_str()
            .unwrap()
            .contains("is not executable"));
    }
}

#[test]
fn an_unbuilt_backend_is_a_note_not_a_failure() {
    let Some(platform) = current_platform() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let folder = backend_tab(root.path(), platform, "backend");
    let message = success_message(&validate(&folder));
    assert!(message.contains("BACKEND_UNAVAILABLE"), "{message}");
    assert!(
        message.contains(&format!("`bin/{platform}/backend` is not built yet")),
        "{message}"
    );
    assert!(!message.contains("conformance"), "{message}");
}

#[test]
fn actual_cli_packs_the_compiled_custom_tab_without_overwriting() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("graph");
    std::fs::create_dir_all(folder.join("dist")).unwrap();
    let mut document = manifest("graph");
    document.as_object_mut().unwrap().remove("icon");
    std::fs::write(folder.join("tab.json"), document.to_string()).unwrap();
    std::fs::write(folder.join("dist/index.html"), "<html>Graph</html>").unwrap();
    let archive = root.path().join("tab.tar.gz");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["--json", "registry", "pack-tab", "--directory"])
            .arg(&folder)
            .arg("--output")
            .arg(&archive)
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["kind"], "tab");
    assert_eq!(receipt["sha256"].as_str().unwrap().len(), 64);
    assert!(!run().status.success());
}

#[test]
fn release_packaging_binds_strict_metadata_to_the_compiled_tab() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("graph");
    std::fs::create_dir_all(folder.join("dist")).unwrap();
    let mut document = manifest("graph");
    document.as_object_mut().unwrap().remove("icon");
    std::fs::write(folder.join("tab.json"), document.to_string()).unwrap();
    std::fs::write(folder.join("dist/index.html"), "<html>Graph</html>").unwrap();
    let package = json!({"kind":"tab","package":{
        "tab":{"id":"graph","name":document["name"],"description":"Explore changes",
            "version":"0.1.0","repository":"https://github.com/acme/tabs","license":"MIT",
            "api_version":1,"distribution":{
                "archive":"https://github.com/acme/tabs/releases/download/v0.1.0/tab.tar.gz",
                "sha256":"0".repeat(64)}},
        "host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"}}
    }});
    let metadata = root.path().join("package.json");
    let run = |output: &Path| {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["--json", "registry", "pack-tab", "--directory"])
            .arg(&folder)
            .arg("--package")
            .arg(&metadata)
            .arg("--output")
            .arg(output)
            .output()
            .unwrap()
    };
    for field in ["id", "name", "version", "api_version"] {
        let mut changed = package.clone();
        changed["package"]["tab"][field] = match field {
            "api_version" => json!(2),
            "version" => json!("0.2.0"),
            _ => json!("different"),
        };
        std::fs::write(&metadata, changed.to_string()).unwrap();
        let output = root.path().join(format!("wrong-{field}.tar.gz"));
        let rejected = run(&output);
        assert_eq!(rejected.status.code(), Some(1), "{field}");
        let error: Value = serde_json::from_slice(&rejected.stderr).unwrap();
        assert_eq!(error["code"], "TAB_PACKAGING_FAILED");
        assert!(!output.exists(), "invalid {field} wrote an archive");
    }
    for invalid in [
        json!({"kind":"provider","package":package.clone()}),
        json!({"kind":"tab","package":package["package"],"extra":true}),
    ] {
        std::fs::write(&metadata, invalid.to_string()).unwrap();
        let output = root.path().join("invalid.tar.gz");
        assert_eq!(run(&output).status.code(), Some(1));
        assert!(!output.exists());
    }
    // Duplicate JSON fields are not silently reinterpreted at this boundary.
    std::fs::write(&metadata, "{\"kind\":\"provider\",\"kind\":\"tab\"}").unwrap();
    assert_eq!(
        run(&root.path().join("duplicate.tar.gz")).status.code(),
        Some(1)
    );
    std::fs::write(&metadata, package.to_string()).unwrap();
    let first = root.path().join("first.tar.gz");
    let second = root.path().join("second.tar.gz");
    let accepted = run(&first);
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    assert!(run(&second).status.success());
    assert_eq!(
        std::fs::read(&first).unwrap(),
        std::fs::read(&second).unwrap()
    );
    assert_eq!(run(&first).status.code(), Some(1));
}
