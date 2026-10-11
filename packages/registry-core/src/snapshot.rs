use std::path::Path;

use chrono::Utc;
use serde_json::Value;

use crate::catalog::validate_catalog_identities_with_label;
use crate::error::RegistryError;

use crate::signing::{parse_public_key, verify_envelope_at};

pub(crate) mod continuity;
mod io;
mod output;
use continuity::validate_continuity;
use io::{parse_document, read_file, validate_inputs};
use output::{assemble_snapshot, digest};

const CATALOG_LIMIT: u64 = crate::MAX_CATALOG_BYTES as u64;
const KEY_LIMIT: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum PreviousCatalog<'a> {
    Bootstrap,
    File(&'a Path),
}

/// A verified, continuity-checked catalog snapshot ready for publication.
pub struct CatalogSnapshot {
    schema_version: u64,
    discovery_bootstrap: bool,
    canonical_payload: Vec<u8>,
    canonical_envelope: Vec<u8>,
    sha256: String,
    tag: String,
    body: String,
    expected_url: String,
    previous_sha256: Option<String>,
    generated_at: String,
    expires_at: String,
    repository: String,
    registry_commit: String,
}

#[bon::builder]
pub fn prepare_catalog_snapshot(
    catalog_file: &Path,
    previous: PreviousCatalog<'_>,
    public_key_file: &Path,
    key_id: &str,
    trust: Option<&crate::VerifiedRegistryTrust>,
    repository: &str,
    registry_commit: &str,
    #[builder(default)] allow_schema_upgrade: bool,
) -> Result<CatalogSnapshot, RegistryError> {
    validate_inputs(repository, registry_commit, key_id)?;
    let now = Utc::now();
    let key_bytes = read_file(public_key_file, KEY_LIMIT, "public key")?;
    let key = parse_public_key(&key_bytes)?;
    if let Some(trust) = trust {
        if trust.active_key(key_id)? != &key {
            return Err(RegistryError::single(
                "current signer does not match trusted generation",
            ));
        }
    }
    let candidate_bytes = read_file(catalog_file, CATALOG_LIMIT, "catalog")?;
    let candidate = parse_document(&candidate_bytes, "catalog")?;
    let canonical_payload = verify_envelope_at(&candidate, &key, key_id, false, now)?;
    let candidate_signed = signed(&candidate);

    let mut namespace_upgrade = false;
    let previous_sha256 = match previous {
        PreviousCatalog::Bootstrap => None,
        PreviousCatalog::File(path) => {
            let bytes = read_file(path, CATALOG_LIMIT, "previous index")?;
            let baseline = parse_document(&bytes, "previous index")?;
            match trust {
                Some(trust) => {
                    trust.verify_catalog(&baseline, crate::CatalogTrustPurpose::Baseline, now)?;
                }
                None => {
                    verify_envelope_at(&baseline, &key, key_id, true, now)?;
                }
            }
            if signed(&baseline)["schema_version"] != candidate_signed["schema_version"]
                && !allow_schema_upgrade
            {
                return Err(RegistryError::single(
                    "catalog schema transition requires explicit upgrade",
                ));
            }
            validate_continuity(signed(&baseline), candidate_signed)?;
            namespace_upgrade =
                signed(&baseline)["schema_version"] == 1 && candidate_signed["schema_version"] == 2;
            Some(digest(&bytes))
        }
    };
    validate_catalog_identities_with_label(packages(candidate_signed), "source")?;
    let mut snapshot = assemble_snapshot(
        candidate,
        canonical_payload,
        previous_sha256,
        repository,
        registry_commit,
    )?;
    snapshot.discovery_bootstrap |= namespace_upgrade;
    Ok(snapshot)
}

fn signed(envelope: &Value) -> &Value {
    &envelope["signed"]
}
fn packages(value: &Value) -> &[Value] {
    value["packages"].as_array().expect("verified packages")
}
fn required_timestamp<'a>(value: &'a Value, field: &str) -> Result<&'a str, RegistryError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| RegistryError::single(format!("index.{field} is required")))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::canonical_json_bytes;
    use base64::Engine as _;
    use chrono::{Duration, SecondsFormat};
    use ed25519_dalek::pkcs8::DecodePrivateKey as _;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;
    use std::process::Command;

    const PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\n\
        MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n\
        -----END PRIVATE KEY-----\n";
    const PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\n\
        MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n\
        -----END PUBLIC KEY-----\n";

    fn package(version: &str) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        value["agent"]["version"] = Value::String(version.into());
        value
    }

    fn envelope(directory: &Path, name: &str, generated: &str, packages: Vec<Value>) -> Vec<u8> {
        let key = directory.join("private.pem");
        std::fs::write(&key, PRIVATE_KEY).unwrap();
        let expires = (chrono::DateTime::parse_from_rfc3339(generated).unwrap()
            + Duration::days(1))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
        let payload = json!({
            "schema_version": 1, "generated_at": generated,
            "expires_at": expires, "packages": packages,
        });
        let bytes = crate::sign_index_payload(&payload, &key, "release-2026").unwrap();
        std::fs::write(directory.join(name), &bytes).unwrap();
        bytes
    }

    fn unchecked_envelope(generated: &str, expires: &str, packages: Vec<Value>) -> Vec<u8> {
        let payload = json!({"schema_version":1,"generated_at":generated,"expires_at":expires,"packages":packages});
        let pem = pem_rfc7468::decode_vec(PRIVATE_KEY.as_bytes()).unwrap().1;
        let key = SigningKey::from_pkcs8_der(&pem).unwrap();
        let signature = key.sign(&canonical_json_bytes(&payload));
        let envelope = json!({"signed":payload,"signature":{"algorithm":"ed25519","key_id":"release-2026","value":base64::prelude::BASE64_STANDARD.encode(signature.to_bytes())}});
        let mut bytes = canonical_json_bytes(&envelope);
        bytes.push(b'\n');
        bytes
    }

    fn prepare_result<'a>(
        directory: &'a Path,
        previous: PreviousCatalog<'a>,
    ) -> Result<CatalogSnapshot, RegistryError> {
        let catalog = directory.join("candidate.json");
        let public_key = directory.join("public.pem");
        prepare_catalog_snapshot()
            .catalog_file(&catalog)
            .previous(previous)
            .public_key_file(&public_key)
            .key_id("release-2026")
            .repository("cadencr/registry")
            .registry_commit(&"a".repeat(40))
            .call()
    }

    fn prepare<'a>(directory: &'a Path, previous: PreviousCatalog<'a>) -> CatalogSnapshot {
        prepare_result(directory, previous).unwrap()
    }

    #[test]
    fn exact_binding_matches_node_oracle_and_hashes_raw_previous_bytes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("public.pem"), PUBLIC_KEY).unwrap();
        let generated =
            (Utc::now() - Duration::minutes(2)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let prior = envelope(
            root.path(),
            "previous.json",
            &generated,
            vec![package("0.0.1")],
        );
        let next_generated =
            (Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        envelope(
            root.path(),
            "candidate.json",
            &next_generated,
            vec![package("0.0.1"), package("0.1.0")],
        );
        std::fs::write(
            root.path().join("previous.json"),
            [prior.as_slice(), b" "].concat(),
        )
        .unwrap();
        let snapshot = prepare(
            root.path(),
            PreviousCatalog::File(&root.path().join("previous.json")),
        );
        assert_eq!(
            snapshot.previous_sha256(),
            Some(digest(&[prior.as_slice(), b" "].concat()).as_str())
        );
        assert_eq!(snapshot.sha256(), digest(snapshot.canonical_envelope()));
        assert_eq!(snapshot.tag(), format!("catalog-{}", snapshot.sha256()));
        assert!(snapshot
            .body()
            .ends_with(snapshot.previous_sha256().unwrap()));
        assert_eq!(snapshot.size(), snapshot.canonical_envelope().len());
        assert_eq!(snapshot.repository(), "cadencr/registry");
        assert_eq!(snapshot.registry_commit(), "a".repeat(40));
        snapshot.revalidate_freshness().unwrap();

        let script = r#"import{prepareCatalogSnapshot}from'../../tooling/marketplace-registry/scripts/publication/snapshot.mjs';let r=await prepareCatalogSnapshot({catalogFile:process.argv[1],previousIndex:process.argv[2],publicKeyFile:process.argv[3],keyId:'release-2026',repository:'cadencr/registry',registryCommit:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'});console.log(JSON.stringify({bytes:r.bytes.toString('base64'),sha:r.sha256,tag:r.tag,body:r.body,url:r.expectedUrl}))"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "-e",
                script,
                root.path().join("candidate.json").to_str().unwrap(),
                root.path().join("previous.json").to_str().unwrap(),
                root.path().join("public.pem").to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            base64::prelude::BASE64_STANDARD
                .decode(oracle["bytes"].as_str().unwrap())
                .unwrap(),
            snapshot.canonical_envelope()
        );
        assert_eq!(oracle["sha"], snapshot.sha256());
        assert_eq!(oracle["tag"], snapshot.tag());
        assert_eq!(oracle["body"], snapshot.body());
        assert_eq!(oracle["url"], snapshot.expected_url());
    }

    #[test]
    fn rejects_tampering_and_bounded_inputs_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let public = root.path().join("public.pem");
        std::fs::write(&public, PUBLIC_KEY).unwrap();
        let generated =
            (Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let bytes = envelope(
            root.path(),
            "candidate.json",
            &generated,
            vec![package("0.1.0")],
        );
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["signed"]["packages"][0]["agent"]["name"] = json!("tampered");
        std::fs::write(
            root.path().join("candidate.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let error = prepare_catalog_snapshot()
            .catalog_file(&root.path().join("candidate.json"))
            .previous(PreviousCatalog::Bootstrap)
            .public_key_file(&public)
            .key_id("release-2026")
            .repository("cadencr/registry")
            .registry_commit(&"a".repeat(40))
            .call()
            .err()
            .unwrap();
        assert!(error.to_string().contains("signature verification"));

        std::fs::write(&public, vec![b'x'; KEY_LIMIT as usize + 1]).unwrap();
        let error = prepare_result(root.path(), PreviousCatalog::Bootstrap)
            .err()
            .unwrap();
        assert!(error.to_string().contains("16384-byte file limit"));
        std::fs::write(&public, PUBLIC_KEY).unwrap();
        std::fs::write(root.path().join("candidate.json"), &bytes).unwrap();
        let previous = root.path().join("previous.json");
        std::fs::write(&previous, vec![b' '; CATALOG_LIMIT as usize + 1]).unwrap();
        let error = prepare_result(root.path(), PreviousCatalog::File(&previous))
            .err()
            .unwrap();
        assert!(error
            .to_string()
            .contains(&format!("{CATALOG_LIMIT}-byte file limit")));
        std::fs::write(
            root.path().join("candidate.json"),
            vec![b' '; CATALOG_LIMIT as usize + 1],
        )
        .unwrap();
        let error = prepare_result(root.path(), PreviousCatalog::Bootstrap)
            .err()
            .unwrap();
        assert!(error
            .to_string()
            .contains(&format!("{CATALOG_LIMIT}-byte file limit")));
    }

    #[test]
    fn baseline_alone_may_be_expired_while_timestamp_policy_remains_strict() {
        let root = tempfile::tempdir().unwrap();
        let public = root.path().join("public.pem");
        std::fs::write(&public, PUBLIC_KEY).unwrap();
        let old = unchecked_envelope(
            "2026-09-01T00:00:00Z",
            "2026-09-02T00:00:00Z",
            vec![package("0.0.1")],
        );
        let previous = root.path().join("previous.json");
        std::fs::write(&previous, old).unwrap();
        let generated =
            (Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        envelope(
            root.path(),
            "candidate.json",
            &generated,
            vec![package("0.0.1")],
        );
        prepare_result(root.path(), PreviousCatalog::File(&previous)).unwrap();

        let expired = unchecked_envelope(
            "2026-09-03T00:00:00Z",
            "2026-09-04T00:00:00Z",
            vec![package("0.0.1")],
        );
        std::fs::write(root.path().join("candidate.json"), expired).unwrap();
        assert!(prepare_result(root.path(), PreviousCatalog::Bootstrap)
            .err()
            .unwrap()
            .to_string()
            .contains("expired"));
        envelope(
            root.path(),
            "candidate.json",
            &generated,
            vec![package("0.0.1")],
        );
        let fractional = unchecked_envelope(
            "2026-09-03T00:00:00.1Z",
            "2026-09-04T00:00:00Z",
            vec![package("0.0.1")],
        );
        std::fs::write(&previous, fractional).unwrap();
        assert!(
            prepare_result(root.path(), PreviousCatalog::File(&previous))
                .err()
                .unwrap()
                .to_string()
                .contains("whole-second")
        );
    }
    #[test]
    fn explicit_upgrade_bootstraps_only_new_namespace_and_keeps_baseline_provenance() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("public.pem"), PUBLIC_KEY).unwrap();
        let generated =
            (Utc::now() - Duration::minutes(2)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let previous = envelope(
            root.path(),
            "previous.json",
            &generated,
            vec![package("1.0.0")],
        );
        let generated =
            (Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let expires = (Utc::now() + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let payload = crate::prepare_incremental_publication_index()
            .previous_bytes(&previous)
            .public_key_bytes(PUBLIC_KEY.as_bytes())
            .key_id("release-2026")
            .schema_version(2)
            .allow_schema_upgrade(true)
            .packages(Vec::new())
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap();
        let signed =
            crate::sign_prepared_index(payload, &root.path().join("private.pem"), "release-2026")
                .unwrap();
        std::fs::write(root.path().join("candidate.json"), signed).unwrap();
        let snapshot = prepare_catalog_snapshot()
            .catalog_file(&root.path().join("candidate.json"))
            .previous(PreviousCatalog::File(&root.path().join("previous.json")))
            .public_key_file(&root.path().join("public.pem"))
            .key_id("release-2026")
            .repository("cadencr/registry")
            .registry_commit(&"a".repeat(40))
            .allow_schema_upgrade(true)
            .call()
            .unwrap();
        assert!(snapshot.previous_sha256().is_some());
        assert!(snapshot.discovery_bootstrap());
        assert!(!crate::assess_discovery_head(&snapshot, None).unwrap());
        assert!(snapshot.tag().starts_with("marketplace-v2-"));
        assert_eq!(
            std::fs::read(root.path().join("previous.json")).unwrap(),
            previous
        );
    }
}
