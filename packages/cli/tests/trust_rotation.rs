use serde_json::Value;
use std::process::Command;

#[path = "support/catalog.rs"]
mod catalog;

fn cli(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(args)
        .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
        .output()
        .unwrap()
}

fn rotation() -> catalog::Fixture {
    let mut fixture = catalog::Fixture::new();
    let output = Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args(["--input-type=module", "-e", r#"
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalJson} from './tooling/marketplace-registry/scripts/lib.mjs';
const root=process.argv[1];
const pair=()=>generateKeyPairSync('ed25519');
const a=pair(),b=pair(),offline=pair();
const env=JSON.parse(readFileSync(join(root,'catalog.json')));
const previous=structuredClone(env.signed);
previous.generated_at=new Date(Date.now()-120000).toISOString().replace(/\.\d{3}Z$/,'Z');
const envelope=(signed,key,id)=>({signed,signature:{algorithm:'ed25519',key_id:id,value:sign(null,Buffer.from(canonicalJson(signed)),key).toString('base64')}});
writeFileSync(join(root,'previous.json'),canonicalJson(envelope(previous,a.privateKey,'prior-a'))+'\n');
const bytes=canonicalJson(envelope(env.signed,b.privateKey,'fixture-key'))+'\n';
writeFileSync(join(root,'catalog.json'),bytes);
writeFileSync(join(root,'public.pem'),b.publicKey.export({format:'pem',type:'spki'}));
writeFileSync(join(root,'root-public.pem'),offline.publicKey.export({format:'pem',type:'spki'}));
writeFileSync(join(root,'root-private.pem'),offline.privateKey.export({format:'pem',type:'pkcs8'}));
const raw=(k)=>k.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
writeFileSync(join(root,'trust-payload.json'),JSON.stringify({schema_version:1,kind:'registry-trust',generation:2,keys:[{key_id:'prior-a',public_key_base64:raw(a.publicKey),retired_at:new Date().toISOString()},{key_id:'fixture-key',public_key_base64:raw(b.publicKey)}],revoked_key_ids:[],recovery_catalog_sha256:[]}));
console.log('catalog-'+createHash('sha256').update(bytes).digest('hex'));
"#]).arg(fixture.root.path()).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.tag = String::from_utf8(output.stdout).unwrap().trim().into();
    let root = fixture.root.path();
    let output = cli(&[
        "registry",
        "sign-trust-manifest",
        "--payload",
        root.join("trust-payload.json").to_str().unwrap(),
        "--root-private-key",
        root.join("root-private.pem").to_str().unwrap(),
        "--root-key-id",
        "offline-root",
        "--output",
        root.join("trust.json").to_str().unwrap(),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture
}

#[test]
fn cli_rotation_profile_authenticates_retired_baseline_before_credentials() {
    let fixture = rotation();
    let root = fixture.root.path();
    let previous = root.join("previous.json");
    let manifest = root.join("trust.json");
    let public = root.join("root-public.pem");
    let plain = fixture.run(
        "publish-catalog",
        &[("--previous-index", previous.to_str().unwrap())],
    );
    assert!(!plain.status.success());
    assert!(!String::from_utf8_lossy(&plain.stderr).contains("TOKEN is required"));
    let profile = [
        ("--previous-index", previous.to_str().unwrap()),
        ("--trust-manifest", manifest.to_str().unwrap()),
        ("--trust-root-public-key", public.to_str().unwrap()),
        ("--trust-root-key-id", "offline-root"),
        ("--trust-minimum-generation", "2"),
    ];
    let accepted = fixture.run("publish-catalog", &profile);
    assert!(
        String::from_utf8_lossy(&accepted.stderr).contains("TOKEN is required"),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let mut envelope: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    envelope["signed"]["generation"] = 3.into();
    std::fs::write(&manifest, serde_json::to_vec(&envelope).unwrap()).unwrap();
    let tampered = fixture.run("publish-catalog", &profile);
    assert!(!String::from_utf8_lossy(&tampered.stderr).contains("TOKEN is required"));
    assert_eq!(
        std::fs::read_dir(root.join("publication")).unwrap().count(),
        0
    );
}

#[test]
fn cli_trust_verification_and_partial_profile_fail_closed() {
    let fixture = rotation();
    let root = fixture.root.path();
    for generation in ["2", "3"] {
        let output = cli(&[
            "registry",
            "verify-trust-manifest",
            "--manifest",
            root.join("trust.json").to_str().unwrap(),
            "--root-public-key",
            root.join("root-public.pem").to_str().unwrap(),
            "--root-key-id",
            "offline-root",
            "--minimum-generation",
            generation,
        ]);
        assert_eq!(output.status.success(), generation == "2");
    }
    let partial = fixture.run(
        "publish-catalog",
        &[(
            "--trust-manifest",
            root.join("trust.json").to_str().unwrap(),
        )],
    );
    assert_eq!(partial.status.code(), Some(2));
}

#[test]
fn compromised_baseline_requires_exact_offline_root_checkpoint() {
    let fixture = rotation();
    let root = fixture.root.path();
    let payload_file = root.join("trust-payload.json");
    let manifest = root.join("trust.json");
    let previous_file = root.join("previous.json");
    let public = root.join("root-public.pem");
    let mut payload: Value =
        serde_json::from_slice(&std::fs::read(&payload_file).unwrap()).unwrap();
    payload["keys"]
        .as_array_mut()
        .unwrap()
        .retain(|key| key["key_id"] != "prior-a");
    payload["revoked_key_ids"] = serde_json::json!(["prior-a"]);
    let profile = [
        ("--previous-index", previous_file.to_str().unwrap()),
        ("--trust-manifest", manifest.to_str().unwrap()),
        ("--trust-root-public-key", public.to_str().unwrap()),
        ("--trust-root-key-id", "offline-root"),
    ];
    for checkpoint in [false, true] {
        if checkpoint {
            let previous: Value =
                serde_json::from_slice(&std::fs::read(&previous_file).unwrap()).unwrap();
            payload["recovery_catalog_sha256"] = serde_json::json!([
                cadencr_registry_core::VerifiedRegistryTrust::catalog_digest(&previous)
            ]);
        }
        std::fs::write(&payload_file, serde_json::to_vec(&payload).unwrap()).unwrap();
        let bytes = cadencr_registry_core::sign_registry_trust_manifest(
            &payload_file,
            &root.join("root-private.pem"),
            "offline-root",
        )
        .unwrap();
        std::fs::write(&manifest, bytes).unwrap();
        let result = fixture.run("publish-catalog", &profile);
        assert_eq!(
            String::from_utf8_lossy(&result.stderr).contains("TOKEN is required"),
            checkpoint,
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let mut changed: Value =
        serde_json::from_slice(&std::fs::read(&previous_file).unwrap()).unwrap();
    changed["signed"]["packages"][0]["agent"]["description"] =
        "changed compromised baseline".into();
    std::fs::write(&previous_file, serde_json::to_vec(&changed).unwrap()).unwrap();
    let changed_result = fixture.run("publish-catalog", &profile);
    assert!(!String::from_utf8_lossy(&changed_result.stderr).contains("TOKEN is required"));
}
