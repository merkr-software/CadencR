mod baseline;
mod entry;
#[cfg(test)]
pub(crate) mod fixture;
mod manifest;

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::binding::ExpectedArtifact;
use crate::{Downloader, PublisherError};
use manifest::{absolute_lexical, read_manifest, validate_manifest};

pub(super) const MAX_SUBMISSION_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_INPUT_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) fn validate_manifest_repository(
    path: &Path,
    repository: &str,
) -> Result<(), PublisherError> {
    let manifest = read_manifest(&absolute_lexical(path)?)?;
    validate_manifest(&manifest)?;
    if manifest.repository != repository {
        return Err(PublisherError::new(
            "publication manifest repository does not match catalog snapshot",
        ));
    }
    Ok(())
}

struct PreparedEntry {
    directory: PathBuf,
    expected: Vec<ExpectedArtifact>,
    package: Value,
}

#[bon::builder]
pub(crate) fn prepare(
    manifest: &Path,
    generated_at: &str,
    expires_at: &str,
    downloader: &impl Downloader,
    expected_repository: Option<&str>,
) -> Result<cadencr_registry_core::PreparedSigningPayload, PublisherError> {
    let manifest_file = absolute_lexical(manifest)?;
    let manifest = read_manifest(&manifest_file)?;
    validate_manifest(&manifest)?;
    if expected_repository.is_some_and(|expected| expected != manifest.repository) {
        return Err(PublisherError::new(
            "publication manifest repository does not match catalog snapshot",
        ));
    }
    let base = manifest_file
        .parent()
        .ok_or_else(|| PublisherError::new("publication manifest has no parent directory"))?;
    let mut input_bytes = 0_u64;
    let mut entries = Vec::with_capacity(manifest.publications.len());
    for (position, publication) in manifest.publications.iter().enumerate() {
        let entry = entry::prepare(
            publication,
            position,
            &manifest.repository,
            base,
            &mut input_bytes,
        )?;
        entries.push(entry);
    }
    let mut packages = Vec::with_capacity(entries.len());
    let mut verifications = Vec::with_capacity(entries.len());
    for entry in entries {
        packages.push(entry.package);
        verifications.push((entry.directory, entry.expected));
    }
    let payload = baseline::prepare(&manifest, base, packages, generated_at, expires_at)?;
    for (directory, expected) in verifications {
        crate::promote::public::verify(&expected, &directory, downloader)?;
    }
    Ok(payload)
}

fn checked_budget(
    current: u64,
    added: u64,
    maximum: u64,
    message: &str,
) -> Result<u64, PublisherError> {
    let total = current
        .checked_add(added)
        .ok_or_else(|| PublisherError::new(message))?;
    if total > maximum {
        return Err(PublisherError::new(message));
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::process::Command;

    use super::fixture::{build as fixture, Mode};
    use super::*;

    fn window() -> Vec<String> {
        let output = Command::new("node")
            .args(["-e", "const now=Math.floor(Date.now()/1000)*1000;console.log(JSON.stringify([new Date(now-60000).toISOString().replace('.000Z','Z'),new Date(now+86400000).toISOString().replace('.000Z','Z')]))"])
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn prepare_fixture(
        value: &fixture::Fixture,
    ) -> Result<cadencr_registry_core::PreparedSigningPayload, PublisherError> {
        let window = window();
        prepare()
            .manifest(&value.manifest)
            .generated_at(&window[0])
            .expires_at(&window[1])
            .downloader(&value.downloader)
            .call()
    }

    #[test]
    fn published_delta_needs_no_local_archives_and_history_needs_no_downloads() {
        let value = fixture(1, Mode::Good);
        value.add_baseline(120);
        value.remove_archives();
        let payload = prepare_fixture(&value).unwrap();
        let candidate: Value = serde_json::from_slice(payload.canonical_payload()).unwrap();
        assert_eq!(candidate["packages"].as_array().unwrap().len(), 121);
        assert_eq!(value.downloader.calls.get(), 2);
        assert!(value
            .downloader
            .requests
            .borrow()
            .iter()
            .all(|url| !url.contains("historical")));
    }

    #[test]
    fn renewal_with_empty_delta_authenticates_history_without_downloads() {
        let value = fixture(0, Mode::Good);
        value.add_baseline(120);
        let payload = prepare_fixture(&value).unwrap();
        let candidate: Value = serde_json::from_slice(payload.canonical_payload()).unwrap();
        let prior: Value = serde_json::from_slice(
            &std::fs::read(value.directory().join("previous-index.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(candidate["packages"], prior["signed"]["packages"]);
        assert_eq!(value.downloader.calls.get(), 0);
    }

    #[test]
    fn baseline_authentication_and_receipt_tampering_fail_before_download() {
        for mutation in 0..9 {
            let value = fixture(1, Mode::Good);
            value.add_baseline(2);
            let path = match mutation {
                0..=2 => value.directory().join("previous-index.json"),
                3 => value.receipt_files[0].clone(),
                _ => value.receipt_files[0]
                    .parent()
                    .unwrap()
                    .join(crate::binding::MIRROR_RECEIPT),
            };
            let mut data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            match mutation {
                0 => data["signature"]["value"] = "A".repeat(88).into(),
                1 => data["signature"]["key_id"] = "other-key".into(),
                2 => data["signed"]["packages"][0]["agent"]["description"] = "mutated".into(),
                3 => data["release_id"] = 99.into(),
                4 => data["artifacts"][0]["sha256"] = "0".repeat(64).into(),
                5 => data["artifacts"][0]["size"] = (crate::stage::MAX_ARCHIVE_BYTES + 1).into(),
                6 => data["artifacts"][1]["size"] = 0.into(),
                7 => data["artifacts"][0]["name"] = "publication-plan.json".into(),
                _ => data["artifacts"][1]["sha256"] = data["plan_sha256"].clone(),
            }
            std::fs::write(path, serde_json::to_vec(&data).unwrap()).unwrap();
            assert!(prepare_fixture(&value).is_err(), "mutation {mutation}");
            assert_eq!(value.downloader.calls.get(), 0, "mutation {mutation}");
        }
    }

    #[test]
    fn aggregate_budgets_accept_exact_limits_and_reject_overflow() {
        assert_eq!(checked_budget(3, 2, 5, "budget").unwrap(), 5);
        assert!(checked_budget(3, 3, 5, "budget").is_err());
        assert!(checked_budget(u64::MAX, 1, u64::MAX, "budget").is_err());
    }

    #[test]
    fn all_local_receipts_are_validated_before_public_downloads() {
        for tampered in [false, true] {
            let value = fixture(2, Mode::Good);
            if tampered {
                std::fs::write(&value.receipt_files[1], b"{}").unwrap();
            } else {
                std::fs::remove_file(&value.receipt_files[1]).unwrap();
            }
            assert!(prepare_fixture(&value).is_err());
            assert_eq!(value.downloader.calls.get(), 0);
        }
    }

    #[test]
    fn public_digest_size_and_request_set_are_exact() {
        for mode in [Mode::WrongDigest, Mode::WrongSize] {
            let value = fixture(1, mode);
            assert!(prepare_fixture(&value).is_err());
            assert!(value.downloader.calls.get() > 0);
        }
        let value = fixture(2, Mode::Good);
        prepare_fixture(&value).unwrap();
        let mut expected = value.downloader.values.keys().cloned().collect::<Vec<_>>();
        let mut actual = value.downloader.requests.borrow().clone();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
        assert_eq!(actual.len(), 4);
        assert_eq!(
            actual
                .iter()
                .filter(|url| url.ends_with("/publication-plan.json"))
                .count(),
            2
        );
    }

    #[test]
    fn payload_matches_javascript_catalog_oracle() {
        let fixture = fixture(2, Mode::Good);
        let root = fixture.manifest.parent().unwrap();
        let window = window();
        let generated = &window[0];
        let expires = &window[1];
        let rust = prepare()
            .manifest(&fixture.manifest)
            .generated_at(generated)
            .expires_at(expires)
            .downloader(&fixture.downloader)
            .call()
            .unwrap();
        let module = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tooling/marketplace-registry/scripts/publication/catalog.mjs");
        let encoded: HashMap<_, _> = fixture
            .downloader
            .values
            .iter()
            .map(|(key, value)| (key, crate::hex(value)))
            .collect();
        let script = r#"import{pathToFileURL}from'node:url';import{readFile,writeFile}from'node:fs/promises';const{readPublicationManifest,preparePublishedCatalog}=await import(pathToFileURL(process.argv[1]));const manifest=await readPublicationManifest(process.argv[2]);const values=JSON.parse(process.argv[3]);const payload=await preparePublishedCatalog(manifest,{baseDirectory:process.argv[4],generatedAt:process.argv[5],expiresAt:process.argv[6],now:new Date(),download:async({url,outputPath})=>{const bytes=Buffer.from(values[url],'hex');await writeFile(outputPath,bytes,{flag:'wx'});return{size:bytes.length}}});process.stdout.write(JSON.stringify(payload));"#;
        let output = Command::new("node")
            .args(["--input-type=module", "-e", script])
            .arg(module)
            .arg(&fixture.manifest)
            .arg(serde_json::to_string(&encoded).unwrap())
            .arg(root)
            .arg(generated)
            .arg(expires)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(rust.canonical_payload()).unwrap(),
            serde_json::from_slice::<Value>(&output.stdout).unwrap()
        );
        // Synthetic fixture key; never used as a release credential.
        let key = root.join("private.pem");
        std::fs::write(&key, "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n").unwrap();
        let rust_envelope =
            cadencr_registry_core::sign_prepared_index(rust, &key, "test-key").unwrap();
        let signing = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tooling/marketplace-registry/scripts/publication/signing.mjs");
        let library = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tooling/marketplace-registry/scripts/lib.mjs");
        let sign_script = r#"import{pathToFileURL}from'node:url';const{signIndexPayload}=await import(pathToFileURL(process.argv[1]));const{canonicalJson}=await import(pathToFileURL(process.argv[2]));const envelope=await signIndexPayload(JSON.parse(process.argv[3]),{privateKeyFile:process.argv[4],keyId:'test-key'});process.stdout.write(`${canonicalJson(envelope)}\n`);"#;
        let javascript_envelope = Command::new("node")
            .args(["--input-type=module", "-e", sign_script])
            .arg(signing)
            .arg(library)
            .arg(String::from_utf8(output.stdout).unwrap())
            .arg(&key)
            .output()
            .unwrap();
        assert!(
            javascript_envelope.status.success(),
            "{}",
            String::from_utf8_lossy(&javascript_envelope.stderr)
        );
        assert_eq!(rust_envelope, javascript_envelope.stdout);
    }
}
