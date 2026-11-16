//! `cadencr registry pack-tab-backend` and the tab blocklist commands, run
//! through the real binary.
#[cfg(unix)]
use std::path::Path;
use std::process::{Command, Output};

use serde_json::{json, Value};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(args)
        .output()
        .unwrap()
}

#[cfg(unix)]
fn host_platform() -> Option<&'static str> {
    use cadencr_plugin_core::tab::TabPlatform;
    TabPlatform::current().map(TabPlatform::as_str)
}

/// A tab folder whose host-platform backend is this test's own executable
/// (native, and signed on Apple silicon by the Rust linker).
#[cfg(unix)]
fn backend_tab(root: &Path, platform: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let folder = root.join("port-monitor");
    std::fs::create_dir_all(folder.join("dist")).unwrap();
    std::fs::create_dir_all(folder.join(format!("bin/{platform}"))).unwrap();
    std::fs::write(folder.join("dist/index.html"), "<html></html>").unwrap();
    let manifest = json!({"schema_version":1,"kind":"tab","id":"port-monitor","name":"Port monitor",
        "version":"1.0.0","api_version":1,"entry":"dist/index.html",
        "backend":{"protocol":1,"reasoning":"Lists listening ports.",
            "binary":{platform:format!("bin/{platform}/port-monitor")}}});
    std::fs::write(folder.join("tab.json"), manifest.to_string()).unwrap();
    let binary = folder.join(format!("bin/{platform}/port-monitor"));
    std::fs::copy(std::env::current_exe().unwrap(), &binary).unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    folder
}

#[cfg(unix)]
#[test]
fn packs_the_host_backend_deterministically_and_reports_its_binary_entry() {
    let Some(platform) = host_platform() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let folder = backend_tab(root.path(), platform);
    let pack = |name: &str| {
        let output = root.path().join(name);
        run(&[
            "registry",
            "pack-tab-backend",
            "--directory",
            folder.to_str().unwrap(),
            "--target",
            platform,
            "--output",
            output.to_str().unwrap(),
        ])
    };
    let first = pack("a.tar.gz");
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let packed: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(packed["kind"], "tab-backend");
    assert_eq!(packed["target"], platform);
    assert_eq!(packed["cmd"], format!("bin/{platform}/port-monitor"));
    let executable = std::fs::read(std::env::current_exe().unwrap()).unwrap();
    assert_eq!(packed["executable_size"], executable.len() as u64);
    let archive = std::fs::read(packed["archive"].as_str().unwrap()).unwrap();
    assert_eq!(packed["size"], archive.len() as u64);
    let second: Value = serde_json::from_slice(&pack("b.tar.gz").stdout).unwrap();
    assert_eq!(second["sha256"], packed["sha256"]);
    // Never overwrites; `--json` failures carry a stable code.
    let again = pack("a.tar.gz");
    assert!(!again.status.success());
    std::fs::write(
        folder.join(format!("bin/{platform}/port-monitor")),
        "#!/bin/sh\n",
    )
    .unwrap();
    let script = run(&[
        "--json",
        "registry",
        "pack-tab-backend",
        "--directory",
        folder.to_str().unwrap(),
        "--target",
        platform,
        "--output",
        root.path().join("script.tar.gz").to_str().unwrap(),
    ]);
    let error: Value = serde_json::from_slice(&script.stderr).unwrap();
    assert_eq!(error["code"], "TAB_BACKEND_PACKAGING_FAILED");
    assert!(error["message"].as_str().unwrap().contains("not a script"));
    assert!(!root.path().join("script.tar.gz").exists());
}

#[test]
fn an_unknown_target_is_a_usage_error() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("out.tar.gz");
    let refused = run(&[
        "--json",
        "registry",
        "pack-tab-backend",
        "--directory",
        root.path().to_str().unwrap(),
        "--target",
        "windows-x86_64",
        "--output",
        output.to_str().unwrap(),
    ]);
    assert!(!refused.status.success());
    let error: Value = serde_json::from_slice(&refused.stderr).unwrap();
    assert_eq!(error["code"], "CLI_USAGE_ERROR");
    let message = error["message"].as_str().unwrap();
    assert!(
        message.contains("not a tab backend platform; use darwin-aarch64"),
        "{message}"
    );
    assert!(!output.exists());
}

#[test]
fn tab_blocklists_sign_verify_and_stay_in_their_domain() {
    let root = tempfile::tempdir().unwrap();
    let payload = root.path().join("policy.json");
    let private = root.path().join("private.pem");
    let public = root.path().join("public.pem");
    let signed = root.path().join("signed.json");
    std::fs::write(&private,"-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n").unwrap();
    std::fs::write(&public,"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n").unwrap();
    let now = chrono::Utc::now();
    let at = |offset: chrono::Duration| {
        (now + offset).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    };
    let value = json!({"schema_version":1,"kind":"tab-blocklist",
        "generated_at":at(-chrono::Duration::minutes(1)),"expires_at":at(chrono::Duration::hours(1)),
        "entries":[{"tab_id":"port-monitor","executable_sha256":"e".repeat(64),"reason":"Leaked a token."}]});
    std::fs::write(&payload, serde_json::to_vec(&value).unwrap()).unwrap();
    let paths = [&payload, &private, &public, &signed].map(|path| path.to_str().unwrap());
    let sign = [
        "registry",
        "sign-tab-blocklist",
        "--payload",
        paths[0],
        "--private-key",
        paths[1],
        "--key-id",
        "test-key",
        "--output",
        paths[3],
    ];
    let result = run(&sign);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!run(&sign).status.success(), "overwrote the output");
    let verify = |command: &str| {
        run(&[
            "registry",
            command,
            "--index",
            paths[3],
            "--public-key",
            paths[2],
            "--key-id",
            "test-key",
        ])
        .status
        .success()
    };
    assert!(verify("verify-tab-blocklist"));
    assert!(!verify("verify-theme-blocklist"));
    let mut envelope: Value = serde_json::from_slice(&std::fs::read(&signed).unwrap()).unwrap();
    envelope["signed"]["entries"][0]["reason"] = json!("Changed after signing.");
    std::fs::write(&signed, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(!verify("verify-tab-blocklist"));
}
