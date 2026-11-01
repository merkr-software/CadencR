use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{json, Value};

#[path = "support/theme.rs"]
mod theme_support;

fn plugin_manifest(members: Value) -> Value {
    json!({"schema_version":1,"kind":"plugin","id":"aurora","name":"Aurora",
        "version":"1.0.0","description":"Agent, tab and theme","contributes":members})
}

fn tab_manifest(id: &str, version: &str) -> Value {
    json!({"schema_version":1,"kind":"tab","id":id,"name":"Aurora tab","version":version,
        "api_version":1,"entry":"dist/index.html","tab":{"label":"Aurora"},
        "permissions":["features:read"]})
}

fn write_json(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

/// A tab + theme plugin at `<root>/aurora`.
fn tab_and_theme(root: &Path) -> PathBuf {
    let plugin = root.join("aurora");
    write_json(
        &plugin.join("plugin.json"),
        &plugin_manifest(json!([
            {"kind":"tab","path":"aurora-tab"},
            {"kind":"theme","path":"theme"}])),
    );
    write_json(
        &plugin.join("aurora-tab/tab.json"),
        &tab_manifest("aurora-tab", "1.0.0"),
    );
    write_json(&plugin.join("theme/theme.json"), &theme_support::document());
    plugin
}

/// Add a provider member at `agent/` whose descriptor declares `id` at `version`.
#[cfg(unix)]
fn add_provider(plugin: &Path, id: &str, version: &str) {
    use std::os::unix::fs::PermissionsExt;
    let executable = plugin.join("agent/bin/provider");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, "never executed").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let descriptor = format!("agent/{id}.json");
    write_json(
        &plugin.join(&descriptor),
        &json!({"schema_version":1,
            "agent":{"id":id,"name":"Aurora agent","version":version,"description":"ACP provider"},
            "installation":{"executable":{"command":executable.canonicalize().unwrap()}}}),
    );
    let path = plugin.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["contributes"].as_array_mut().unwrap().insert(
        0,
        json!({"kind":"provider","path":"agent","descriptor":descriptor}),
    );
    write_json(&path, &manifest);
}

fn validate(folder: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "plugin", "validate"])
        .arg(folder)
        .args(["--kind", "plugin"])
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

fn failure_message(output: &Output) -> String {
    assert_eq!(output.status.code(), Some(1));
    let diagnostic: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(diagnostic["code"], "PLUGIN_VALIDATION_FAILED");
    diagnostic["message"].as_str().unwrap().to_string()
}

#[test]
fn validates_every_member_with_its_own_kind() {
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    let message = success_message(&validate(&plugin, &[]));
    assert!(
        message.starts_with("valid multi-export plugin: aurora 1.0.0 ("),
        "{message}"
    );
    assert!(message.contains("2 members)"), "{message}");
    assert!(
        message.contains("\n- contributes[0] tab `aurora-tab`: valid custom tab: aurora-tab 1.0.0"),
        "{message}"
    );
    assert!(
        message.contains("\n- contributes[1] theme `theme`: valid declarative theme: CLI Theme"),
        "{message}"
    );
}

#[cfg(unix)]
#[test]
fn validates_provider_members_against_their_named_descriptor() {
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    add_provider(&plugin, "aurora-agent", "1.0.0");
    let message = success_message(&validate(&plugin, &[]));
    assert!(message.contains("3 members)"), "{message}");
    assert!(
        message.contains("\n- contributes[0] provider `agent`: valid local provider structure"),
        "{message}"
    );
}

#[cfg(unix)]
#[test]
fn reports_every_member_and_binding_problem_at_once() {
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    add_provider(&plugin, "auroratab", "1.0.1");
    write_json(&plugin.join("theme/theme.json"), &json!({"label":"broken"}));
    let message = failure_message(&validate(&plugin, &[]));
    assert!(message.starts_with("aurora 1.0.0 ("), "{message}");
    for expected in [
        "\n- contributes[2] theme `theme`: [THEME_VALIDATION_FAILED] ",
        "\n- contributes[0] provider `agent`: [MEMBER_VERSION_MISMATCH] provider version 1.0.1 must equal the plugin version 1.0.0",
        "\n- contributes[1] tab `aurora-tab`: [MEMBER_ID_COLLISION] tab id `aurora-tab` collides with contributes[0] id `auroratab`",
    ] {
        assert!(message.contains(expected), "{expected} not in {message}");
    }
}

#[test]
fn tab_members_must_ship_at_the_plugin_version() {
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    write_json(
        &plugin.join("aurora-tab/tab.json"),
        &tab_manifest("aurora-tab", "2.0.0"),
    );
    let message = failure_message(&validate(&plugin, &[]));
    assert!(
        message.contains("[MEMBER_VERSION_MISMATCH] tab version 2.0.0"),
        "{message}"
    );
    // A member's own rules still apply: a tab folder is named after its id.
    write_json(
        &plugin.join("aurora-tab/tab.json"),
        &tab_manifest("aurora", "1.0.0"),
    );
    let message = failure_message(&validate(&plugin, &[]));
    assert!(message.contains("[TAB_VALIDATION_FAILED]"), "{message}");
    assert!(message.contains("ID_MISMATCH"), "{message}");
}

#[test]
fn manifest_problems_are_reported_before_any_member_runs() {
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    let path = plugin.join("plugin.json");
    write_json(
        &path,
        &plugin_manifest(json!([
            {"kind":"tab","path":"aurora-tab"},
            {"kind":"theme","path":"aurora-tab/theme"},
            {"kind":"provider","path":"agent"}])),
    );
    let message = failure_message(&validate(&plugin, &[]));
    assert!(
        message.contains("[MEMBER_PATH_NESTED] contributes[1].path"),
        "{message}"
    );
    assert!(
        message.contains("[MEMBER_DESCRIPTOR_REQUIRED] contributes[2].descriptor"),
        "{message}"
    );
    let mut unknown = plugin_manifest(json!([{"kind":"theme","path":"theme"}]));
    unknown["icon"] = json!("icon.svg");
    write_json(&path, &unknown);
    let message = failure_message(&validate(&plugin, &[]));
    assert!(message.contains("[MANIFEST_INVALID_JSON]"), "{message}");
    std::fs::remove_file(&path).unwrap();
    let message = failure_message(&validate(&plugin, &[]));
    assert!(
        message.contains("[MANIFEST_UNREADABLE] plugin.json is missing"),
        "{message}"
    );
}

#[test]
fn refuses_a_descriptor_argument() {
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    let descriptor = plugin.join("plugin.json");
    let output = validate(&plugin, &["--descriptor", descriptor.to_str().unwrap()]);
    assert!(failure_message(&output).contains("--descriptor is not used"));
}

#[test]
fn tab_members_honor_no_run_and_refuse_unstartable_backends() {
    use cadencr_plugin_core::tab::{test_support::native_executable, TabPlatform};
    let Some(platform) = TabPlatform::current() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let plugin = tab_and_theme(root.path());
    let mut manifest = tab_manifest("aurora-tab", "1.0.0");
    let binary = format!("bin/{platform}/backend");
    manifest["backend"] = json!({"protocol":1,"binary":{platform.as_str():binary},
        "reasoning":"Lists listening ports."});
    write_json(&plugin.join("aurora-tab/tab.json"), &manifest);
    let executable = plugin.join("aurora-tab").join(&binary);
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, native_executable(platform)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let message = success_message(&validate(&plugin, &["--no-run"]));
    assert!(
        message.contains(&format!("backend `{binary}` was not run (--no-run)")),
        "{message}"
    );
    std::fs::write(&executable, b"#!/bin/sh\n").unwrap();
    let message = failure_message(&validate(&plugin, &["--no-run"]));
    assert!(
        message.contains("contributes[0] tab `aurora-tab`: [TAB_BACKEND_BINARY_REFUSED]"),
        "{message}"
    );
}
