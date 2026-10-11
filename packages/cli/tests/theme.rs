use std::process::Command;

use serde_json::{json, Value};

fn document() -> Value {
    use cadencr_plugin_core::theme::{schema, tokens};
    let mut vars = serde_json::Map::new();
    for token in tokens::REQUIRED_TOKENS {
        vars.insert((*token).into(), json!("#000000"));
    }
    for pair in tokens::CONTRAST_PAIRS {
        vars.insert(pair.foreground.into(), json!("#ffffff"));
    }
    let contract: Value = serde_json::from_str(&schema::render()).unwrap();
    let xterm = contract["properties"]["xterm"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (key.clone(), json!("#ffffff")))
        .collect::<serde_json::Map<_, _>>();
    json!({"label":"CLI Theme", "appearance":"dark", "cssVars":vars, "xterm":xterm})
}

#[test]
fn actual_cli_validates_and_packages_declarative_themes_without_provider_transport() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("theme");
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("theme.json");
    std::fs::write(&path, serde_json::to_vec(&document()).unwrap()).unwrap();
    let validate = || {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["--json", "plugin", "validate"])
            .arg(&directory)
            .args(["--kind", "theme"])
            .output()
            .unwrap()
    };
    let valid = validate();
    assert!(
        valid.status.success(),
        "{}",
        String::from_utf8_lossy(&valid.stderr)
    );
    let first = root.path().join("first.tar.gz");
    let second = root.path().join("second.tar.gz");
    let pack = |output: &std::path::Path| {
        Command::new(env!("CARGO_BIN_EXE_cadencr"))
            .args(["registry", "pack-theme", "--directory"])
            .arg(&directory)
            .arg("--output")
            .arg(output)
            .output()
            .unwrap()
    };
    let a = pack(&first);
    let b = pack(&second);
    assert!(a.status.success(), "{}", String::from_utf8_lossy(&a.stderr));
    assert!(b.status.success());
    let receipt: Value = serde_json::from_slice(&a.stdout).unwrap();
    assert_eq!(receipt["kind"], "theme");
    assert_eq!(
        std::fs::read(&first).unwrap(),
        std::fs::read(&second).unwrap()
    );
    assert!(!pack(&first).status.success());
    std::fs::write(directory.join("script.js"), b"evil()").unwrap();
    assert!(!pack(&root.path().join("script.tar.gz")).status.success());
    let mut unknown = document();
    unknown["script"] = json!("evil.js");
    std::fs::write(path, serde_json::to_vec(&unknown).unwrap()).unwrap();
    let invalid = validate();
    assert!(!invalid.status.success());
    let diagnostic: Value = serde_json::from_slice(&invalid.stderr).unwrap();
    assert_eq!(diagnostic["code"], "THEME_VALIDATION_FAILED");
}
