use std::path::Path;

use cadencr_registry_core::{RegistryTrustFiles, VerifiedRegistryTrust};

use crate::PublisherError;

pub(super) struct Inputs {
    pub(super) manifest: Vec<u8>,
    pub(super) root_public_key: Vec<u8>,
    pub(super) verified: VerifiedRegistryTrust,
}

pub(super) fn validate(files: &RegistryTrustFiles) -> Result<(), PublisherError> {
    for path in [&files.manifest, &files.root_public_key] {
        super::request::relative(
            path.to_str()
                .ok_or_else(|| PublisherError::new("trust input path must be UTF-8"))?,
        )?;
    }
    cadencr_registry_core::validate_signing_key_id(&files.root_key_id)?;
    if files.minimum_generation == 0 {
        return Err(PublisherError::new(
            "trust minimum generation must be positive",
        ));
    }
    Ok(())
}

pub(super) fn prepare(
    base: &Path,
    files: Option<&RegistryTrustFiles>,
) -> Result<Option<Inputs>, PublisherError> {
    let Some(files) = files else { return Ok(None) };
    validate(files)?;
    let manifest = super::request::trusted_file(
        base,
        files.manifest.to_str().unwrap(),
        cadencr_registry_core::MAX_TRUST_MANIFEST_BYTES,
        "trust manifest",
    )?;
    let root_public_key = super::request::trusted_file(
        base,
        files.root_public_key.to_str().unwrap(),
        16 * 1024,
        "offline root public key",
    )?;
    let verified = files.load_bytes(&manifest, &root_public_key)?;
    Ok(Some(Inputs {
        manifest,
        root_public_key,
        verified,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::fixture::{Fixture, PUBLIC};
    use serde_json::json;

    fn rotate(fixture: &mut Fixture) {
        fixture.run().unwrap();
        let base = fixture.request.parent().unwrap();
        std::fs::write(
            base.join("previous.json"),
            std::fs::read(fixture.state.join("managed-index.json")).unwrap(),
        )
        .unwrap();
        fixture.state = base.join("rotated-state");
        let output = std::process::Command::new("node").args(["--input-type=module", "-e", r#"
import {generateKeyPairSync,createPublicKey} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const base=process.argv[1], old=createPublicKey(readFileSync(join(base,'public.pem')));
const current=generateKeyPairSync('ed25519'), root=generateKeyPairSync('ed25519');
writeFileSync(join(base,'private.pem'),current.privateKey.export({format:'pem',type:'pkcs8'}));
writeFileSync(join(base,'public.pem'),current.publicKey.export({format:'pem',type:'spki'}));
writeFileSync(join(base,'root-private.pem'),root.privateKey.export({format:'pem',type:'pkcs8'}));
writeFileSync(join(base,'root-public.pem'),root.publicKey.export({format:'pem',type:'spki'}));
const raw=k=>k.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
writeFileSync(join(base,'trust-payload.json'),JSON.stringify({schema_version:1,kind:'registry-trust',generation:2,keys:[{key_id:'release-2026',public_key_base64:raw(old),retired_at:new Date().toISOString()},{key_id:'current-b',public_key_base64:raw(current.publicKey)}],revoked_key_ids:[],recovery_catalog_sha256:[]}));
"#]).arg(base).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let bytes = cadencr_registry_core::sign_registry_trust_manifest(
            &base.join("trust-payload.json"),
            &base.join("root-private.pem"),
            "offline-root",
        )
        .unwrap();
        std::fs::write(base.join("trust.json"), bytes).unwrap();
        let mut request = fixture.request_value();
        request["previous_index"] = "previous.json".into();
        request["key_id"] = "current-b".into();
        request["publications"] = json!([]);
        let generated =
            chrono::DateTime::parse_from_rfc3339(request["generated_at"].as_str().unwrap())
                .unwrap()
                + chrono::Duration::seconds(30);
        request["generated_at"] = generated
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            .into();
        fixture.write_request(request);
        fixture.client.requests.borrow_mut().clear();
    }

    #[test]
    fn pipeline_rotation_is_local_root_verified_and_resume_binds_exact_inputs() {
        let mut fixture = Fixture::new();
        rotate(&mut fixture);
        assert!(fixture.prepare().is_err());
        assert!(fixture.client.requests.borrow().is_empty());
        let mut request = fixture.request_value();
        request["trust"] = json!({"manifest":"trust.json","root_public_key":"root-public.pem","root_key_id":"offline-root","minimum_generation":2});
        fixture.write_request(request);
        let prepared = fixture.prepare().unwrap();
        crate::pipeline::state::ensure_directory(&fixture.state).unwrap();
        crate::pipeline::state::materialize(&prepared).unwrap();
        let manifest = crate::pipeline::state::manifest(&prepared);
        assert_eq!(
            manifest["baseline"]["trust"]["manifest"],
            "inputs/trust-manifest.json"
        );
        let manifest_file = fixture.state.join("publication-manifest.json");
        crate::pipeline::state::write_json_once(&manifest_file, &manifest).unwrap();
        let signed =
            crate::pipeline::catalog::prepare_candidate(&prepared, &manifest_file, &fixture.client)
                .unwrap();
        assert_eq!(
            signed.canonical_payload(),
            crate::pipeline::request::candidate_payload(&prepared)
                .unwrap()
                .canonical_payload()
        );
        assert!(fixture.prepare().is_ok());
        let base = fixture.request.parent().unwrap();
        let payload_path = base.join("trust-payload.json");
        let mut payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&payload_path).unwrap()).unwrap();
        payload["generation"] = 3.into();
        std::fs::write(&payload_path, serde_json::to_vec(&payload).unwrap()).unwrap();
        let changed = cadencr_registry_core::sign_registry_trust_manifest(
            &payload_path,
            &base.join("root-private.pem"),
            "offline-root",
        )
        .unwrap();
        std::fs::write(base.join("trust.json"), changed).unwrap();
        assert!(fixture.prepare().is_err());
        assert!(fixture.client.requests.borrow().is_empty());
        std::fs::write(base.join("root-public.pem"), PUBLIC).unwrap();
        assert!(fixture.prepare().is_err());
    }

    #[test]
    fn pipeline_trust_paths_cannot_escape_or_silently_skip_generation() {
        for path in ["../trust.json", "/trust.json", "a\\trust.json", ""] {
            let files = RegistryTrustFiles {
                manifest: path.into(),
                root_public_key: "root.pem".into(),
                root_key_id: "root".into(),
                minimum_generation: 1,
            };
            assert!(validate(&files).is_err());
        }
    }
}
