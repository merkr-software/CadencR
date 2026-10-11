use std::path::Path;
use std::process::{Command, Output};

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub tag: String,
}

impl Fixture {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let output = Command::new("node")
            .current_dir(repository)
            .args(["--input-type=module", "-e", r#"
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './tooling/marketplace-registry/scripts/lib.mjs';
const root = process.argv[1];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pkg = JSON.parse(readFileSync('./tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture'));
const timestamp = (delta) => new Date(Date.now() + delta).toISOString().replace(/\.\d{3}Z$/, 'Z');
const signed = { schema_version: 1, generated_at: timestamp(-60000), expires_at: timestamp(86400000), packages: [pkg] };
const envelope = { signed, signature: { algorithm: 'ed25519', key_id: 'fixture-key', value: sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString('base64') } };
const bytes = canonicalJson(envelope) + '\n';
writeFileSync(join(root, 'catalog.json'), bytes);
writeFileSync(join(root, 'public.pem'), publicKey.export({format: 'pem', type: 'spki'}));
writeFileSync(join(root, 'manifest.json'), JSON.stringify({schema_version: 1, repository: 'acme/registry', publications: [{submission: 'submission.json', directory: 'staged', registry_commit: 'a'.repeat(40)}]}));
mkdirSync(join(root, 'publication'));
console.log('catalog-' + createHash('sha256').update(bytes).digest('hex'));
"#])
            .arg(root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self {
            root,
            tag: String::from_utf8(output.stdout).unwrap().trim().into(),
        }
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
            args.iter_mut().find(|(flag, _)| flag == name).unwrap().1 = (*value).into();
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
