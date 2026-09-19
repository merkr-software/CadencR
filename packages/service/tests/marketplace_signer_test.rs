use std::{fs, path::Path, process::Command};

use cadencr_service::domain::agents::providers::installed::managed::{
    trust::{ManagedTrustErrorCode, ManagedTrustStore, TrustedIndexKey},
    SignedManagedProviderIndex,
};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};

const KEY_ID: &str = "marketplace-signer-test";

fn run_node(args: &[&str]) {
    let output = Command::new("node")
        .args(args)
        .output()
        .expect("run Node.js");
    assert!(
        output.status.success(),
        "Node.js failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn generate_test_key(private_key: &Path, public_key: &Path) {
    let script = r#"
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(process.argv[1], privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const spki = publicKey.export({ format: 'der', type: 'spki' });
writeFileSync(process.argv[2], spki.subarray(spki.length - 32), { mode: 0o600 });
"#;
    run_node(&[
        "-e",
        script,
        private_key.to_str().expect("UTF-8 private-key path"),
        public_key.to_str().expect("UTF-8 public-key path"),
    ]);
}

fn write_payload(path: &Path) {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/managed_provider_index/v1/valid.json"
    )))
    .expect("parse managed-index fixture");
    let now = Utc::now();
    let payload = json!({
        "schema_version": 1,
        "generated_at": (now - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        "expires_at": (now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        "packages": fixture["signed"]["packages"],
    });
    fs::write(
        path,
        serde_json::to_vec(&payload).expect("serialize payload"),
    )
    .expect("write payload");
}

#[test]
fn node_signer_output_verifies_in_rust_and_rejects_tampering() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let payload = directory.path().join("index.json");
    let private_key = directory.path().join("private.pem");
    let public_key = directory.path().join("public.raw");
    let signed = directory.path().join("signed.json");
    write_payload(&payload);
    generate_test_key(&private_key, &public_key);

    let signer = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/marketplace-registry/scripts/sign-index.mjs");
    run_node(&[
        signer.to_str().expect("UTF-8 signer path"),
        "--payload",
        payload.to_str().expect("UTF-8 payload path"),
        "--private-key",
        private_key.to_str().expect("UTF-8 private-key path"),
        "--key-id",
        KEY_ID,
        "--output",
        signed.to_str().expect("UTF-8 output path"),
    ]);

    let public_bytes: [u8; 32] = fs::read(public_key)
        .expect("read public key")
        .try_into()
        .expect("32-byte Ed25519 public key");
    let trusted = TrustedIndexKey::new(KEY_ID, public_bytes).expect("trusted test key");
    let trust = ManagedTrustStore::new([trusted]);
    let envelope: SignedManagedProviderIndex =
        serde_json::from_slice(&fs::read(signed).expect("read signed index"))
            .expect("parse signed index");

    let verified = trust
        .verify_index(envelope.clone())
        .expect("Rust verifies Node signature");
    assert_eq!(verified.signer_key_id(), KEY_ID);

    let mut tampered = envelope;
    tampered.signed.packages[0].agent.name = "Tampered".into();
    let error = trust
        .verify_index(tampered)
        .expect_err("tampering must fail");
    assert_eq!(error.code, ManagedTrustErrorCode::InvalidSignature);
}
