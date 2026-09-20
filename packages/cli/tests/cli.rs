use std::process::Command;

fn cadencr() -> Command {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
}

#[test]
fn help_and_version_succeed_in_real_process() {
    let help = cadencr().arg("--help").output().expect("run help");
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout)
        .contains("Headless Cadencr package and registry tooling"));

    let version = cadencr().arg("--version").output().expect("run version");
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).starts_with("cadencr "));
}

#[test]
fn invalid_plugin_reports_machine_readable_diagnostic() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let output = cadencr()
        .args([
            "--json",
            "plugin",
            "validate",
            directory.path().to_str().expect("UTF-8 path"),
            "--descriptor",
            directory
                .path()
                .join("missing.json")
                .to_str()
                .expect("UTF-8 path"),
        ])
        .output()
        .expect("run validation");

    assert_eq!(output.status.code(), Some(1));
    let diagnostic: serde_json::Value =
        serde_json::from_slice(&output.stderr).expect("JSON diagnostic");
    assert_eq!(diagnostic["ok"], false);
    assert_eq!(diagnostic["code"], "DESCRIPTOR_UNREADABLE");
}

#[test]
fn plugin_json_diagnostics_distinguish_syntax_from_schema() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let descriptor = directory.path().join("acme.json");
    let run = || {
        cadencr()
            .args(["--json", "plugin", "validate"])
            .arg(directory.path())
            .arg("--descriptor")
            .arg(&descriptor)
            .output()
            .expect("run validation")
    };

    std::fs::write(&descriptor, "{").expect("write malformed descriptor");
    let malformed = run();
    assert_eq!(malformed.status.code(), Some(1));
    let diagnostic: serde_json::Value =
        serde_json::from_slice(&malformed.stderr).expect("malformed JSON diagnostic");
    assert_eq!(diagnostic["code"], "DESCRIPTOR_INVALID_JSON");

    std::fs::write(&descriptor, "{}").expect("write wrong descriptor shape");
    let wrong_shape = run();
    assert_eq!(wrong_shape.status.code(), Some(1));
    let diagnostic: serde_json::Value =
        serde_json::from_slice(&wrong_shape.stderr).expect("schema JSON diagnostic");
    assert_eq!(diagnostic["code"], "DESCRIPTOR_SCHEMA_VIOLATION");
}

#[cfg(unix)]
#[test]
fn valid_plugin_is_checked_without_executing_provider() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("temporary directory");
    let workspace = directory.path().join("workspace");
    let bin = workspace.join("bin");
    fs::create_dir_all(&bin).expect("create provider folder");
    let executable = bin.join("provider");
    fs::write(
        &executable,
        "this is deliberately not an executable program",
    )
    .expect("write inert provider fixture");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("mark provider fixture executable");
    let executable = executable.canonicalize().expect("canonical provider path");
    let descriptor = directory.path().join("acme.json");
    fs::write(
        &descriptor,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "agent": {
                "id": "acme",
                "name": "Acme",
                "version": "1.0.0",
                "description": "ACP provider"
            },
            "installation": { "executable": { "command": executable } }
        }))
        .expect("serialize descriptor"),
    )
    .expect("write descriptor");

    let output = cadencr()
        .args(["plugin", "validate"])
        .arg(&workspace)
        .arg("--descriptor")
        .arg(&descriptor)
        .output()
        .expect("run validation");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("valid local provider structure"));
}

#[test]
fn unknown_commands_use_clap_usage_exit_code() {
    let output = cadencr()
        .arg("install")
        .output()
        .expect("run invalid command");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
}

#[test]
fn invalid_usage_is_json_when_requested() {
    let output = cadencr()
        .args(["--json", "plugin", "validate"])
        .output()
        .expect("run invalid command");
    assert_eq!(output.status.code(), Some(2));
    let diagnostic: serde_json::Value =
        serde_json::from_slice(&output.stderr).expect("JSON diagnostic");
    assert_eq!(diagnostic["code"], "CLI_USAGE_ERROR");
}

#[test]
fn registry_validate_accepts_unchanged_local_trees() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let base = directory.path().join("base");
    let candidate = directory.path().join("candidate");
    for root in [&base, &candidate] {
        std::fs::create_dir_all(root.join("packages")).expect("create packages directory");
        std::fs::create_dir_all(root.join("submissions")).expect("create submissions directory");
    }

    let output = cadencr()
        .args(["registry", "validate", "--base"])
        .arg(&base)
        .arg("--candidate")
        .arg(&candidate)
        .output()
        .expect("run registry validation");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("valid registry contribution"));
}

#[test]
fn build_index_is_deterministic_and_refuses_overwrite() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let packages = directory.path().join("packages");
    std::fs::create_dir(&packages).expect("create packages directory");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture");
    std::fs::copy(fixture, packages.join("example-provider-0.1.0.json"))
        .expect("copy package fixture");
    let first = directory.path().join("index.json");
    let second = directory.path().join("index-copy.json");
    let generated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires_at = (chrono::Utc::now() + chrono::Duration::days(7))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    let run = |output: &std::path::Path| {
        cadencr()
            .args(["registry", "build-index", "--packages"])
            .arg(&packages)
            .arg("--generated-at")
            .arg(&generated_at)
            .arg("--expires-at")
            .arg(&expires_at)
            .arg("--output")
            .arg(output)
            .output()
            .expect("run index build")
    };

    let first_run = run(&first);
    assert!(
        first_run.status.success(),
        "{}",
        String::from_utf8_lossy(&first_run.stderr)
    );
    let second_run = run(&second);
    assert!(
        second_run.status.success(),
        "{}",
        String::from_utf8_lossy(&second_run.stderr)
    );
    assert_eq!(
        std::fs::read(&first).expect("read index"),
        std::fs::read(&second).expect("read copy")
    );

    let sentinel = b"do not overwrite";
    std::fs::write(&first, sentinel).expect("replace test output with sentinel");
    let overwrite = run(&first);
    assert_eq!(overwrite.status.code(), Some(3));
    assert_eq!(std::fs::read(&first).expect("read sentinel"), sentinel);

    let directory_target = directory.path().join("existing-directory");
    std::fs::create_dir(&directory_target).expect("create output directory collision");
    let entries_before = directory_entries(directory.path());
    let failed_publish = run(&directory_target);
    assert_eq!(failed_publish.status.code(), Some(3));
    assert!(directory_target.is_dir());
    assert_eq!(directory_entries(directory.path()), entries_before);
}

fn directory_entries(path: &std::path::Path) -> std::collections::BTreeSet<std::ffi::OsString> {
    std::fs::read_dir(path)
        .expect("read output directory")
        .map(|entry| entry.expect("read output entry").file_name())
        .collect()
}
