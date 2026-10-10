use serde_json::{json, Value};
use std::process::{Command, Output};

fn diagnostic(output: Output, message: &str) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let diagnostic: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(diagnostic["code"], "REGISTRY_PIPELINE_FAILED");
    assert!(
        diagnostic["message"].as_str().unwrap().contains(message),
        "{diagnostic}"
    );
}

#[test]
fn protected_pipeline_requires_all_six_explicit_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["--json", "registry", "publish-registry"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    for flag in [
        "--request",
        "--directory",
        "--repository",
        "--registry-commit",
        "--private-key",
        "--confirm-request-sha256",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag));
    }
}

#[test]
fn request_digest_repository_policy_and_keys_precede_credentials_and_state_writes() {
    let root = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(root.path()).unwrap();
    let script = r#"
import {generateKeyPairSync,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const base=process.argv[1],{privateKey,publicKey}=generateKeyPairSync('ed25519');
writeFileSync(join(base,'private.pem'),privateKey.export({type:'pkcs8',format:'pem'}));
writeFileSync(join(base,'public.pem'),publicKey.export({type:'spki',format:'pem'}));
const source='https://github.com/acme/provider/releases/download/v1/provider.tgz';
const submission={schema_version:1,package:{agent:{id:'acme',name:'Acme',version:'1.0.0',description:'Agent',license:'MIT',repository:'https://github.com/acme/provider',distribution:{binary:{'linux-x86_64':{archive:source,cmd:'bin/provider',sha256:createHash('sha256').update('archive').digest('hex')}}}},host:{publisher:'acme',compatibility:{min_app_version:'0.12.0'},assets:{icon:'icon.svg',readme:'README.md',license:'LICENSE'}}},source:{repository:'https://github.com/acme/provider',commit:'a'.repeat(40),tag:'v1'},changelog:'Release'};
writeFileSync(join(base,'submission.json'),JSON.stringify(submission));
const date=d=>new Date(Date.now()+d).toISOString().replace(/\.\d{3}Z$/,'Z');
writeFileSync(join(base,'request.json'),JSON.stringify({schema_version:1,repository:'cadencr/registry',key_id:'test-key',discovery_branch:'main',generated_at:date(-60000),expires_at:date(86400000),previous_index:'bootstrap',public_key:'public.pem',publications:[{submission:'submission.json'}]}));
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(&base)
        .output()
        .unwrap();
    assert!(output.status.success());
    let run = |digest: &str, repository: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
        command
            .args(["--json", "registry", "publish-registry", "--request"])
            .arg(base.join("request.json"))
            .arg("--directory")
            .arg(base.join("state"))
            .args([
                "--repository",
                repository,
                "--registry-commit",
                &"b".repeat(40),
                "--private-key",
            ])
            .arg(base.join("private.pem"))
            .args(["--confirm-request-sha256", digest])
            .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
            .output()
            .unwrap()
    };
    let hash = || {
        let output=Command::new("node").args(["-e","const{readFileSync}=require('fs');const{createHash}=require('crypto');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))"]).arg(base.join("request.json")).output().unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    diagnostic(
        run(&"0".repeat(64), "cadencr/registry"),
        "SHA-256 confirmation",
    );
    diagnostic(run(&hash(), "other/registry"), "repository does not match");
    diagnostic(
        run(&hash(), "cadencr/registry"),
        "CADENCR_REGISTRY_GITHUB_TOKEN is required",
    );
    let mut request: Value =
        serde_json::from_slice(&std::fs::read(base.join("request.json")).unwrap()).unwrap();
    request["publications"][0]["submission"] = json!("../escape.json");
    std::fs::write(
        base.join("request.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    diagnostic(run(&hash(), "cadencr/registry"), "safe relative path");
    assert!(!base.join("state").exists());
}
