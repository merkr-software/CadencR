use serde_json::{json, Value};
use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn real_cli_packs_builds_signs_and_verifies_schema2_without_rewriting_schema1() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("theme");
    std::fs::create_dir(&folder).unwrap();
    let mut vars = serde_json::Map::new();
    for token in cadencr_plugin_core::theme::tokens::REQUIRED_TOKENS {
        vars.insert((*token).into(), json!("#000000"));
    }
    for pair in cadencr_plugin_core::theme::tokens::CONTRAST_PAIRS {
        vars.insert(pair.foreground.into(), json!("#ffffff"));
    }
    let schema: Value =
        serde_json::from_str(&cadencr_plugin_core::theme::schema::render()).unwrap();
    let xterm = schema["properties"]["xterm"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (key.clone(), json!("#ffffff")))
        .collect::<serde_json::Map<_, _>>();
    std::fs::write(
        folder.join("theme.json"),
        serde_json::to_vec(
            &json!({"label":"Midnight","appearance":"dark","cssVars":vars,"xterm":xterm}),
        )
        .unwrap(),
    )
    .unwrap();
    let archive = root.path().join("theme.tar.gz");
    let output = run(&[
        "registry",
        "pack-theme",
        "--directory",
        folder.to_str().unwrap(),
        "--output",
        archive.to_str().unwrap(),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let packed: Value = serde_json::from_slice(&output.stdout).unwrap();
    cadencr_registry_core::verify_theme_archive(&archive).unwrap();
    let package = json!({"kind":"theme","package":{"theme":{"id":"midnight","name":"Midnight","description":"Dark theme","version":"1.0.0","repository":"https://github.com/acme/themes","license":"MIT","document_version":1,"distribution":{"archive":"https://github.com/acme/themes/releases/download/v1/theme.tar.gz","sha256":packed["sha256"]}},"host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"}}}});
    let packages = root.path().join("packages");
    std::fs::create_dir(&packages).unwrap();
    std::fs::write(
        packages.join("midnight-1.0.0.json"),
        serde_json::to_vec(&package).unwrap(),
    )
    .unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../service/tests/fixtures/managed_provider_index/v1/valid.json"
    ))
    .unwrap();
    let provider = fixture["signed"]["packages"][0].clone();
    let legacy_file = packages.join("acme-agent-1.2.3.json");
    let legacy_bytes = serde_json::to_vec_pretty(&provider).unwrap();
    std::fs::write(&legacy_file, &legacy_bytes).unwrap();
    let generated = (chrono::Utc::now() - chrono::Duration::minutes(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let expires = (chrono::Utc::now() + chrono::Duration::days(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let legacy = run(&[
        "registry",
        "build-index",
        "--packages",
        packages.to_str().unwrap(),
        "--generated-at",
        &generated,
        "--expires-at",
        &expires,
    ]);
    assert!(!legacy.status.success());
    let payload = root.path().join("payload.json");
    let output = run(&[
        "registry",
        "build-index",
        "--schema-version",
        "2",
        "--packages",
        packages.to_str().unwrap(),
        "--generated-at",
        &generated,
        "--expires-at",
        &expires,
        "--output",
        payload.to_str().unwrap(),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let private = root.path().join("private.pem");
    let public = root.path().join("public.pem");
    // Deterministic test-only key, never production credentials.
    std::fs::write(&private,"-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n").unwrap();
    std::fs::write(&public,"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n").unwrap();
    let signed = root.path().join("signed.json");
    let output = run(&[
        "registry",
        "sign-index",
        "--payload",
        payload.to_str().unwrap(),
        "--private-key",
        private.to_str().unwrap(),
        "--key-id",
        "test-key",
        "--output",
        signed.to_str().unwrap(),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(run(&[
        "registry",
        "verify-index",
        "--index",
        signed.to_str().unwrap(),
        "--public-key",
        public.to_str().unwrap(),
        "--key-id",
        "test-key"
    ])
    .status
    .success());
    let decoded: Value = serde_json::from_slice(&std::fs::read(signed).unwrap()).unwrap();
    assert_eq!(decoded["signed"]["schema_version"], 2);
    assert_eq!(
        decoded["signed"]["packages"][0],
        json!({"kind":"provider","package":provider})
    );
    assert_eq!(decoded["signed"]["packages"][1], package);
    assert_eq!(std::fs::read(legacy_file).unwrap(), legacy_bytes);
    assert!(decoded["signed"]["packages"][0]["package"]["agent"]["x-registry-note"].is_object());
}

#[test]
fn real_cli_theme_blocklist_is_domain_bound_and_never_overwrites() {
    let root = tempfile::tempdir().unwrap();
    let payload = root.path().join("policy.json");
    let private = root.path().join("private.pem");
    let public = root.path().join("public.pem");
    let signed = root.path().join("signed.json");
    std::fs::write(&private,"-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n").unwrap();
    std::fs::write(&public,"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n").unwrap();
    let now = chrono::Utc::now();
    let value = json!({"schema_version":1,"kind":"theme-blocklist","generated_at":(now-chrono::Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":(now+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"entries":[]});
    std::fs::write(&payload, serde_json::to_vec(&value).unwrap()).unwrap();
    let sign = [
        "registry",
        "sign-theme-blocklist",
        "--payload",
        payload.to_str().unwrap(),
        "--private-key",
        private.to_str().unwrap(),
        "--key-id",
        "test-key",
        "--output",
        signed.to_str().unwrap(),
    ];
    let result = run(&sign);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let original = std::fs::read(&signed).unwrap();
    assert!(!run(&sign).status.success());
    assert_eq!(std::fs::read(&signed).unwrap(), original);
    let verify = [
        "registry",
        "verify-theme-blocklist",
        "--index",
        signed.to_str().unwrap(),
        "--public-key",
        public.to_str().unwrap(),
        "--key-id",
        "test-key",
    ];
    assert!(run(&verify).status.success());
    let mut envelope: Value = serde_json::from_slice(&original).unwrap();
    envelope["signed"]["kind"] = json!("provider-blocklist");
    std::fs::write(&signed, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(!run(&verify).status.success());
    std::fs::write(&payload, serde_json::to_vec(&envelope["signed"]).unwrap()).unwrap();
    let rejected = root.path().join("rejected.json");
    let mut wrong = sign;
    wrong[9] = rejected.to_str().unwrap();
    assert!(!run(&wrong).status.success());
    assert!(!rejected.exists());
}
