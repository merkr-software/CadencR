use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};

const KEY_ID: &str = "release-2026";

struct Fixture {
    _directory: tempfile::TempDir,
    payload: PathBuf,
    private_key: PathBuf,
    public_key: PathBuf,
    output: PathBuf,
}

fn cadencr() -> Command {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let payload = directory.path().join("index.json");
    let private_key = directory.path().join("private.pem");
    let public_key = directory.path().join("public.pem");
    let output = directory.path().join("signed.json");
    let package: Value = serde_json::from_slice(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
    )))
    .unwrap();
    let now = Utc::now();
    let payload_value = json!({
        "schema_version": 1,
        "generated_at": (now - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        "expires_at": (now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        "packages": [package],
    });
    fs::write(&payload, serde_json::to_vec(&payload_value).unwrap()).unwrap();
    let script = r#"
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(process.argv[1], privateKey.export({format:'pem', type:'pkcs8'}), {mode:0o600});
writeFileSync(process.argv[2], publicKey.export({format:'pem', type:'spki'}), {mode:0o600});
"#;
    let generated = Command::new("node")
        .args(["-e", script])
        .arg(&private_key)
        .arg(&public_key)
        .output()
        .unwrap();
    assert!(generated.status.success());
    Fixture {
        _directory: directory,
        payload,
        private_key,
        public_key,
        output,
    }
}

fn sign(files: &Fixture) -> Output {
    cadencr()
        .args(["registry", "sign-index", "--payload"])
        .arg(&files.payload)
        .arg("--private-key")
        .arg(&files.private_key)
        .args(["--key-id", KEY_ID, "--output"])
        .arg(&files.output)
        .output()
        .unwrap()
}

fn verify(files: &Fixture) -> Output {
    cadencr()
        .args(["registry", "verify-index", "--index"])
        .arg(&files.output)
        .arg("--public-key")
        .arg(&files.public_key)
        .args(["--key-id", KEY_ID])
        .output()
        .unwrap()
}

#[test]
fn rust_signature_exactly_matches_node_crypto_and_verifies() {
    let files = fixture();
    let output = sign(&files);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(verify(&files).status.success());
    let script = r#"
const { createPrivateKey, sign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const envelope = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value !== null && typeof value === 'object' ? `{${Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const actual = Buffer.from(envelope.signature.value, 'base64');
const expected = sign(null, Buffer.from(canonical(envelope.signed)), createPrivateKey(readFileSync(process.argv[2])));
process.exit(actual.equals(expected) ? 0 : 1);
"#;
    let parity = Command::new("node")
        .args(["-e", script])
        .arg(&files.output)
        .arg(&files.private_key)
        .output()
        .unwrap();
    assert!(parity.status.success(), "Node signature differs");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(&files.output).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn rejects_bad_key_without_disclosure_and_invalid_id_before_key_read() {
    let files = fixture();
    let rsa = Command::new("node")
        .args([
            "-e",
            "const {generateKeyPairSync}=require('node:crypto');const {writeFileSync}=require('node:fs');const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});writeFileSync(process.argv[1],privateKey.export({format:'pem',type:'pkcs8'}));",
        ])
        .arg(&files.private_key)
        .output()
        .unwrap();
    assert!(rsa.status.success());
    let wrong_algorithm = sign(&files);
    assert_eq!(wrong_algorithm.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&wrong_algorithm.stderr).contains("Ed25519 PKCS8 PEM"));

    let marker = "DO_NOT_PRINT_PRIVATE_MATERIAL";
    fs::write(&files.private_key, marker).unwrap();
    let malformed = sign(&files);
    assert_eq!(malformed.status.code(), Some(1));
    let diagnostics = format!(
        "{}{}",
        String::from_utf8_lossy(&malformed.stdout),
        String::from_utf8_lossy(&malformed.stderr)
    );
    assert!(diagnostics.contains("Ed25519 PKCS8 PEM"));
    assert!(!diagnostics.contains(marker));

    fs::remove_file(&files.private_key).unwrap();
    let invalid = cadencr()
        .args(["registry", "sign-index", "--payload"])
        .arg(&files.payload)
        .arg("--private-key")
        .arg(&files.private_key)
        .args(["--key-id", "invalid key", "--output"])
        .arg(&files.output)
        .output()
        .unwrap();
    assert_eq!(invalid.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&invalid.stderr);
    assert!(stderr.contains("signing key id is invalid"));
    assert!(!stderr.contains("cannot read private key"));
}

#[test]
fn rejects_tampering_noncanonical_metadata_and_empty_optionals() {
    let files = fixture();
    assert!(sign(&files).status.success());
    let mut envelope: Value = serde_json::from_slice(&fs::read(&files.output).unwrap()).unwrap();
    envelope["signed"]["packages"][0]["agent"]["name"] = json!("tampered");
    fs::write(&files.output, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert_eq!(verify(&files).status.code(), Some(1));

    fs::remove_file(&files.output).unwrap();
    let mut payload: Value = serde_json::from_slice(&fs::read(&files.payload).unwrap()).unwrap();
    payload["generated_at"] = json!("2026-09-19T12:00:00.000Z");
    fs::write(&files.payload, serde_json::to_vec(&payload).unwrap()).unwrap();
    let timestamp = sign(&files);
    assert_eq!(timestamp.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&timestamp.stderr).contains("canonical UTC whole-second"));

    payload["generated_at"] =
        json!((Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true));
    payload["packages"][0]["agent"]["authors"] = json!([]);
    fs::write(&files.payload, serde_json::to_vec(&payload).unwrap()).unwrap();
    let optional = sign(&files);
    assert_eq!(optional.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&optional.stderr).contains("empty optional field"));
}

#[test]
fn binary_argument_policy_matches_javascript_registry_validation() {
    let files = fixture();
    let cases = [
        ("version", false),
        ("models", false),
        ("run", false),
        ("acp-v1", false),
        ("--", false),
        ("--protocol", false),
        ("--protocol=acp-v2", false),
        ("--cwd", false),
        ("--cwd=/tmp", false),
        ("--format", false),
        ("--format=json", false),
        ("--session-id", true),
        ("--prompt", true),
        ("--resume", true),
        ("--continue", true),
        ("--protocolish", true),
        ("--cwdx=/tmp", true),
        ("--formatter=json", true),
        ("provider-option", true),
    ];

    for (argument, accepted) in cases {
        let mut payload: Value =
            serde_json::from_slice(&fs::read(&files.payload).unwrap()).unwrap();
        let binary = payload["packages"][0]["agent"]["distribution"]["binary"]
            .as_object_mut()
            .unwrap();
        for target in binary.values_mut() {
            target["args"] = json!([argument]);
        }
        fs::write(&files.payload, serde_json::to_vec(&payload).unwrap()).unwrap();

        let oracle_script = r#"
import { readFileSync } from 'node:fs';
import { validateIndex } from './tooling/marketplace-registry/scripts/lib.mjs';
const errors = validateIndex(JSON.parse(readFileSync(process.argv[1], 'utf8')));
process.exit(errors.length === 0 ? 0 : 1);
"#;
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let oracle = Command::new("node")
            .args(["--input-type=module", "-e", oracle_script])
            .arg(&files.payload)
            .current_dir(repository)
            .output()
            .unwrap();
        assert_eq!(
            oracle.status.success(),
            accepted,
            "JavaScript oracle disagreed with expected policy for {argument:?}"
        );

        let rust = sign(&files);
        assert_eq!(
            rust.status.success(),
            oracle.status.success(),
            "Rust signing policy differs from JavaScript for {argument:?}: {}",
            String::from_utf8_lossy(&rust.stderr)
        );
        if files.output.exists() {
            fs::remove_file(&files.output).unwrap();
        }
    }
}

#[test]
fn refuses_symlinks_size_overruns_and_output_clobbering() {
    let files = fixture();
    fs::write(&files.output, "keep").unwrap();
    assert_eq!(sign(&files).status.code(), Some(3));
    assert_eq!(fs::read_to_string(&files.output).unwrap(), "keep");
    fs::remove_file(&files.output).unwrap();

    fs::write(&files.private_key, vec![0; 16 * 1024 + 1]).unwrap();
    let oversized = sign(&files);
    assert_eq!(oversized.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&oversized.stderr).contains("16384-byte"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = files.payload.with_extension("link");
        symlink(&files.payload, &link).unwrap();
        let output = cadencr()
            .args(["registry", "sign-index", "--payload"])
            .arg(link)
            .arg("--private-key")
            .arg(&files.private_key)
            .args(["--key-id", KEY_ID, "--output"])
            .arg(&files.output)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&output.stderr).contains("regular file"));
    }
}

#[test]
fn assembles_detached_signature_and_rejects_unknown_signature_fields() {
    let files = fixture();
    assert!(sign(&files).status.success());
    let signed_bytes = fs::read(&files.output).unwrap();
    let envelope: Value = serde_json::from_slice(&signed_bytes).unwrap();
    let signature_file = files.payload.with_file_name("signature.json");
    let assembled = files.payload.with_file_name("assembled.json");
    fs::write(
        &signature_file,
        serde_json::to_vec(&envelope["signature"]).unwrap(),
    )
    .unwrap();
    fs::remove_file(&files.output).unwrap();
    let result = assemble(&files.payload, &signature_file, &assembled);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read(&assembled).unwrap(), signed_bytes);

    let mut signature = envelope["signature"].clone();
    signature["unexpected"] = json!(true);
    fs::write(&signature_file, serde_json::to_vec(&signature).unwrap()).unwrap();
    let rejected = assemble(&files.payload, &signature_file, &files.output);
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("not allowed"));
}

#[test]
fn assembly_accepts_structurally_valid_noncanonical_signing_fields() {
    let files = fixture();
    assert!(sign(&files).status.success());
    let envelope: Value = serde_json::from_slice(&fs::read(&files.output).unwrap()).unwrap();
    let signature_file = files.payload.with_file_name("signature.json");
    let assembled = files.payload.with_file_name("assembled.json");
    fs::write(
        &signature_file,
        serde_json::to_vec(&envelope["signature"]).unwrap(),
    )
    .unwrap();
    let mut payload: Value = serde_json::from_slice(&fs::read(&files.payload).unwrap()).unwrap();
    payload["generated_at"] =
        json!((Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Millis, true));
    payload["packages"][0]["agent"]["authors"] = json!([]);
    fs::write(&files.payload, serde_json::to_vec(&payload).unwrap()).unwrap();
    let result = assemble(&files.payload, &signature_file, &assembled);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    // Assembly intentionally permits structurally valid noncanonical signing fields, but Rust
    // remains stricter than JavaScript Date.parse about impossible calendar timestamps.
    fs::remove_file(&assembled).unwrap();
    payload["generated_at"] = json!("2026-02-30T12:00:00Z");
    fs::write(&files.payload, serde_json::to_vec(&payload).unwrap()).unwrap();
    let invalid_calendar = assemble(&files.payload, &signature_file, &assembled);
    assert_eq!(invalid_calendar.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&invalid_calendar.stderr).contains("RFC 3339 timestamp"));
}

#[test]
fn verification_only_allows_expired_indexes_when_explicitly_requested() {
    let files = fixture();
    assert!(sign(&files).status.success());
    let script = r#"
const { createPrivateKey, sign } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const envelope = JSON.parse(readFileSync(process.argv[1], 'utf8'));
envelope.signed.generated_at = '2026-01-01T00:00:00Z';
envelope.signed.expires_at = '2026-01-02T00:00:00Z';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value !== null && typeof value === 'object' ? `{${Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
envelope.signature.value = sign(null, Buffer.from(canonical(envelope.signed)), createPrivateKey(readFileSync(process.argv[2]))).toString('base64');
writeFileSync(process.argv[1], canonical(envelope) + '\n');
"#;
    let resigned = Command::new("node")
        .args(["-e", script])
        .arg(&files.output)
        .arg(&files.private_key)
        .output()
        .unwrap();
    assert!(resigned.status.success());
    assert_eq!(verify(&files).status.code(), Some(1));
    let allowed = cadencr()
        .args(["registry", "verify-index", "--index"])
        .arg(&files.output)
        .arg("--public-key")
        .arg(&files.public_key)
        .args(["--key-id", KEY_ID, "--allow-expired"])
        .output()
        .unwrap();
    assert!(
        allowed.status.success(),
        "{}",
        String::from_utf8_lossy(&allowed.stderr)
    );
}

fn assemble(payload: &Path, signature: &Path, output: &Path) -> Output {
    cadencr()
        .args(["registry", "assemble-signed-index", "--payload"])
        .arg(payload)
        .arg("--signature")
        .arg(signature)
        .arg("--output")
        .arg(output)
        .output()
        .unwrap()
}

#[test]
fn verification_rejects_weak_identity_key_and_forged_signature() {
    let files = fixture();
    // Identity-point Ed25519 key/R with S=0 satisfies the loose verification
    // equation for every message. Match the service's verify_strict boundary.
    let script = r#"
const fs = require('node:fs');
const identity = Buffer.alloc(32); identity[0] = 1;
const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), identity]);
fs.writeFileSync(process.argv[1], `-----BEGIN PUBLIC KEY-----\n${der.toString('base64')}\n-----END PUBLIC KEY-----\n`);
const signature = Buffer.alloc(64); signature[0] = 1;
const envelope = {signed: JSON.parse(fs.readFileSync(process.argv[2])), signature: {
  algorithm: 'ed25519', key_id: process.argv[4], value: signature.toString('base64')
}};
fs.writeFileSync(process.argv[3], JSON.stringify(envelope));
"#;
    let forged = Command::new("node")
        .args(["-e", script])
        .arg(&files.public_key)
        .arg(&files.payload)
        .arg(&files.output)
        .arg(KEY_ID)
        .output()
        .unwrap();
    assert!(forged.status.success());
    let result = verify(&files);
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).contains("signature verification failed"));
}
