use std::{fs, path::Path, process::Command};

use cadencr_service::domain::agents::providers::installed::managed::{
    trust::{ManagedTrustErrorCode, ManagedTrustStore, TrustedIndexKey},
    SignedManagedProviderIndex,
};
use serde_json::Value;

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

fn sign_legacy_fixture_with_node(payload: &Path, public_key: &Path, signed: &Path) {
    let script = r#"
const { generateKeyPairSync, sign } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const bytes = readFileSync(process.argv[1]);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
writeFileSync(process.argv[2], spki.subarray(spki.length - 32), { mode: 0o600 });
writeFileSync(process.argv[3], JSON.stringify({
  signed: JSON.parse(bytes),
  signature: { algorithm: 'ed25519', key_id: process.argv[4], value: sign(null, bytes, privateKey).toString('base64') },
}), { mode: 0o600 });
"#;
    run_node(&[
        "-e",
        script,
        payload.to_str().expect("UTF-8 payload path"),
        public_key.to_str().expect("UTF-8 public-key path"),
        signed.to_str().expect("UTF-8 output path"),
        KEY_ID,
    ]);
}

#[test]
fn node_crypto_signature_over_legacy_bytes_verifies_in_rust_and_rejects_tampering() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let payload = directory.path().join("index.json");
    let public_key = directory.path().join("public.raw");
    let signed = directory.path().join("signed.json");
    // Frozen registry-v1 signing bytes are an independent serialization oracle.
    let fixture = include_bytes!("fixtures/managed_provider_index/v1/valid.signing.json");
    let canonical = fixture.strip_suffix(b"\n").unwrap_or(fixture);
    let value: Value = serde_json::from_slice(canonical).expect("parse canonical fixture");
    assert_eq!(
        cadencr_registry_core::canonical_json_bytes(&value),
        canonical
    );
    fs::write(&payload, canonical).expect("write exact legacy bytes");
    sign_legacy_fixture_with_node(&payload, &public_key, &signed);

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
