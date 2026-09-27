use std::path::Path;
use std::process::{Command, Output};

const CODE: &str = "REGISTRY_CATALOG_PUBLICATION_FAILED";

fn diagnostic(output: Output, expected: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], CODE);
    assert!(
        value["message"].as_str().unwrap().contains(expected),
        "{value}"
    );
}

struct Fixture {
    root: tempfile::TempDir,
    tag: String,
}

impl Fixture {
    fn new() -> Self {
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

    fn run(&self, overrides: &[(&str, &str)]) -> Output {
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
        for (name, value) in overrides {
            args.iter_mut().find(|(flag, _)| flag == name).unwrap().1 = (*value).into();
        }
        let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
        command.args(["--json", "registry", "publish-catalog"]);
        for (flag, value) in args {
            command.arg(flag).arg(value);
        }
        command
            .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
            .output()
            .unwrap()
    }
}

#[test]
fn catalog_publication_requires_ten_explicit_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "publish-catalog"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["code"], "CLI_USAGE_ERROR");
    for flag in [
        "--catalog",
        "--previous-index",
        "--public-key",
        "--key-id",
        "--manifest",
        "--repository",
        "--registry-commit",
        "--directory",
        "--confirm-repository",
        "--confirm-publish",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn explicit_bindings_and_signature_precede_credentials() {
    let fixture = Fixture::new();
    diagnostic(
        fixture.run(&[("--confirm-repository", "other/repository")]),
        "repository confirmation",
    );
    diagnostic(
        fixture.run(&[("--registry-commit", "main")]),
        "40 lowercase hex",
    );
    diagnostic(fixture.run(&[("--key-id", "bad key")]), "key id");
    diagnostic(
        fixture.run(&[("--confirm-publish", "catalog-wrong")]),
        "publish confirmation",
    );
    diagnostic(
        fixture.run(&[]),
        "CADENCR_REGISTRY_GITHUB_TOKEN is required",
    );
    let path = fixture.root.path().join("catalog.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["signed"]["packages"][0]["agent"]["name"] = "tampered".into();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    diagnostic(fixture.run(&[]), "signature verification");
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn manifest_repository_binding_precedes_credentials() {
    let fixture = Fixture::new();
    let path = fixture.root.path().join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["repository"] = "other/registry".into();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    diagnostic(fixture.run(&[]), "repository");
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(unix)]
#[test]
fn symlink_publication_directory_is_refused_without_locking_target() {
    let fixture = Fixture::new();
    let link = fixture.root.path().join("linked");
    std::os::unix::fs::symlink(fixture.root.path().join("publication"), &link).unwrap();
    diagnostic(
        fixture.run(&[("--directory", link.to_str().unwrap())]),
        "non-symlink directory",
    );
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join("publication"))
            .unwrap()
            .count(),
        0
    );
}
