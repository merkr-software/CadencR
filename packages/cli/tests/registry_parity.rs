//! Transitional oracle: exercise the existing contribution safety suite against
//! the Rust executable before retiring the JavaScript implementation.
use std::path::Path;
use std::process::Command;

#[test]
fn existing_contribution_safety_suite_passes_against_rust_cli() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let source = std::fs::read_to_string(
        root.join("tooling/marketplace-registry/tests/contribution.test.mjs"),
    )
    .unwrap();
    let registry = serde_json::to_string(&root.join("tooling/marketplace-registry")).unwrap();
    let binary = serde_json::to_string(env!("CARGO_BIN_EXE_cadencr")).unwrap();
    let substitutions = [
        (
            "const registry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), \"..\");",
            format!("const registry = {registry};"),
        ),
        (
            "spawnSync(process.execPath, [cli, \"--base\", base, \"--candidate\", candidate, ...extra]",
            format!("spawnSync({binary}, [\"registry\", \"validate\", \"--base\", base, \"--candidate\", candidate, ...extra]"),
        ),
        (
            "spawnSync(process.execPath, [cli],",
            format!("spawnSync({binary}, [\"registry\", \"validate\"],"),
        ),
    ];
    let script = substitutions
        .into_iter()
        .fold(source, |source, (from, to)| {
            assert_eq!(
                source.matches(from).count(),
                1,
                "oracle harness changed: {from}"
            );
            source.replace(from, &to)
        });
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("contribution.test.mjs");
    std::fs::write(&path, script).unwrap();
    let result = Command::new("node")
        .arg("--test")
        .arg(path)
        .output()
        .expect("Node is required for the transitional JavaScript parity oracle");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
