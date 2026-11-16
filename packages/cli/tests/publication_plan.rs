use std::process::Command;

fn cadencr() -> Command {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
}

fn submission() -> serde_json::Value {
    let repository = "https://github.com/acme/provider";
    serde_json::json!({
        "schema_version": 1,
        "package": {
            "agent": {
                "id": "acme-agent", "name": "Acme Agent", "version": "1.2.3",
                "description": "ACP connector", "license": "Apache-2.0",
                "repository": repository,
                "distribution": { "binary": { "linux-x86_64": {
                    "archive": format!("{repository}/releases/download/v1.2.3/provider.tgz"),
                    "cmd": "bin/provider", "sha256": "a".repeat(64)
                }}}
            },
            "host": {
                "publisher": "acme",
                "compatibility": { "min_app_version": "0.12.0" },
                "assets": { "icon": "icon.svg", "readme": "README.md", "license": "LICENSE" }
            }
        },
        "source": { "repository": repository, "commit": "1".repeat(40), "tag": "v1.2.3" },
        "changelog": "Release notes."
    })
}

#[test]
fn plans_publication_offline_and_refuses_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let submission_path = root.path().join("submission.json");
    let output = root.path().join("plan.json");
    std::fs::write(&submission_path, serde_json::to_vec(&submission()).unwrap()).unwrap();
    let run = || {
        cadencr()
            .args(["registry", "plan-publication", "--submission"])
            .arg(&submission_path)
            .args(["--repository", "cadencr/registry", "--output"])
            .arg(&output)
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
    let plan: serde_json::Value = serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
    assert_eq!(plan["release"]["tag"], "provider-acme-agent-v1.2.3");
    assert_eq!(plan["repository"], "cadencr/registry");
    let original = std::fs::read(&output).unwrap();
    let overwrite = run();
    assert_eq!(overwrite.status.code(), Some(3));
    assert_eq!(std::fs::read(output).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn submission_boundary_rejects_symlinks_and_fifos_without_blocking() {
    use std::ffi::CString;
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real.json");
    let linked = root.path().join("linked.json");
    std::fs::write(&real, serde_json::to_vec(&submission()).unwrap()).unwrap();
    symlink(&real, &linked).unwrap();
    let output = root.path().join("plan.json");
    for input in [&linked, &root.path().join("fifo")] {
        if input.file_name().unwrap() == "fifo" {
            let raw = CString::new(input.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
        }
        let result = cadencr()
            .args(["registry", "plan-publication", "--submission"])
            .arg(input)
            .args(["--repository", "cadencr/registry", "--output"])
            .arg(&output)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&result.stderr).contains("regular file"));
    }
}
