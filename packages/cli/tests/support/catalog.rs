use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::process::{Command, Output};

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub tag: String,
}

impl Fixture {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let package: Value = serde_json::from_slice(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        )))
        .unwrap();
        let now = Utc::now();
        let signed = json!({
            "schema_version": 1,
            "generated_at": (now - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
            "expires_at": (now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
            "packages": [package],
        });
        let payload =
            cadencr_registry_core::validate_catalog_payload_at(&signed, false, now).unwrap();
        std::fs::write(root.path().join("payload.json"), payload).unwrap();
        let output = Command::new("node")
            .args(["--input-type=module", "-e", r#"
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[1];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// Rust supplies validated canonical bytes; Node independently signs those exact bytes.
const payload = readFileSync(join(root, 'payload.json'));
const signed = JSON.parse(payload);
const envelope = { signed, signature: { algorithm: 'ed25519', key_id: 'fixture-key', value: sign(null, payload, privateKey).toString('base64') } };
writeFileSync(join(root, 'catalog.json'), JSON.stringify(envelope));
writeFileSync(join(root, 'public.pem'), publicKey.export({format: 'pem', type: 'spki'}));
writeFileSync(join(root, 'manifest.json'), JSON.stringify({schema_version: 1, repository: 'acme/registry', publications: [{submission: 'submission.json', directory: 'staged', registry_commit: 'a'.repeat(40)}]}));
mkdirSync(join(root, 'publication'));
"#])
            .arg(root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let catalog = root.path().join("catalog.json");
        cadencr_registry_core::verify_signed_index(
            &catalog,
            &root.path().join("public.pem"),
            "fixture-key",
            false,
        )
        .unwrap();
        let envelope: Value = serde_json::from_slice(&std::fs::read(&catalog).unwrap()).unwrap();
        let mut bytes = cadencr_registry_core::canonical_json_bytes(&envelope);
        bytes.push(b'\n');
        std::fs::write(&catalog, &bytes).unwrap();
        let tag = format!(
            "catalog-{}",
            Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        Self { root, tag }
    }

    pub fn run(&self, subcommand: &str, overrides: &[(&str, &str)]) -> Output {
        let mut args = vec![
            (
                "--catalog",
                self.root.path().join("catalog.json").display().to_string(),
            ),
            ("--previous-index", "bootstrap".into()),
            (
                "--public-key",
                self.root.path().join("public.pem").display().to_string(),
            ),
            ("--key-id", "fixture-key".into()),
            (
                "--manifest",
                self.root.path().join("manifest.json").display().to_string(),
            ),
            ("--repository", "acme/registry".into()),
            ("--registry-commit", "a".repeat(40)),
            (
                "--directory",
                self.root.path().join("publication").display().to_string(),
            ),
            ("--confirm-repository", "acme/registry".into()),
            ("--confirm-publish", self.tag.clone()),
        ];
        if subcommand == "advance-catalog" {
            args.push(("--discovery-branch", "catalog".into()));
            args.push(("--confirm-discovery", "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json".into()));
        }
        for (name, value) in overrides {
            if let Some((_, current)) = args.iter_mut().find(|(flag, _)| flag == name) {
                *current = (*value).into();
            } else {
                args.push((*name, (*value).into()));
            }
        }
        let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
        command.args(["--json", "registry", subcommand]);
        for (flag, value) in args {
            command.arg(flag).arg(value);
        }
        command
            .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
            .output()
            .unwrap()
    }
}
