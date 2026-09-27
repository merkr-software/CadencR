use sha2::{Digest as _, Sha256};

use crate::{valid_publication_repository, CatalogSnapshot, RegistryError};

pub const DISCOVERY_FILENAME: &str = "managed-index.json";
pub const MAX_DISCOVERY_BYTES: usize = 1024 * 1024;

pub fn validate_discovery_branch(branch: &str) -> Result<(), RegistryError> {
    let mut bytes = branch.bytes();
    let valid = (1..=64).contains(&branch.len())
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(RegistryError::single("discovery branch is invalid"))
    }
}

pub fn discovery_url(repository: &str, branch: &str) -> Result<String, RegistryError> {
    if !valid_publication_repository(repository) {
        return Err(RegistryError::single("discovery repository is invalid"));
    }
    validate_discovery_branch(branch)?;
    Ok(format!(
        "https://raw.githubusercontent.com/{repository}/refs/heads/{branch}/{DISCOVERY_FILENAME}"
    ))
}

/// Assess an authenticated discovery head before a compare-and-swap update.
///
/// `true` means the exact candidate bytes are already current. `false` means
/// the absent/bootstrap or exact-baseline head is safe to advance.
pub fn assess_discovery_head(
    snapshot: &CatalogSnapshot,
    head: Option<&[u8]>,
) -> Result<bool, RegistryError> {
    let Some(bytes) = head else {
        return if snapshot.previous_sha256().is_none() {
            Ok(false)
        } else {
            Err(RegistryError::single(
                "discovery does not match the signed baseline",
            ))
        };
    };
    if bytes.len() > MAX_DISCOVERY_BYTES {
        return Err(RegistryError::single("discovery exceeds 1 MiB"));
    }
    if bytes == snapshot.canonical_envelope() {
        return Ok(true);
    }
    let Some(previous) = snapshot.previous_sha256() else {
        return Err(RegistryError::single(
            "discovery is not absent for bootstrap",
        ));
    };
    if digest(bytes) == previous {
        Ok(false)
    } else {
        Err(RegistryError::single(
            "discovery does not match the signed baseline",
        ))
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    use chrono::{Duration, SecondsFormat, Utc};
    use serde_json::{json, Value};

    use super::*;

    // Deterministic synthetic 0x07 fixture key; never a production credential.
    const PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\n\
        MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n\
        -----END PRIVATE KEY-----\n";
    const PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\n\
        MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n\
        -----END PUBLIC KEY-----\n";

    fn package() -> Value {
        serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap()
    }

    fn signed(directory: &std::path::Path, name: &str, minute: i64) -> Vec<u8> {
        let generated = Utc::now() - Duration::minutes(minute);
        let payload = json!({
            "schema_version":1,
            "generated_at":generated.to_rfc3339_opts(SecondsFormat::Secs, true),
            "expires_at":(generated + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
            "packages":[package()],
        });
        let private = directory.join("private.pem");
        std::fs::write(&private, PRIVATE_KEY).unwrap();
        let bytes = crate::sign_index_payload(&payload, &private, "release-2026").unwrap();
        std::fs::write(directory.join(name), &bytes).unwrap();
        bytes
    }

    fn snapshot(
        previous: Option<&std::path::Path>,
    ) -> (tempfile::TempDir, CatalogSnapshot, Vec<u8>) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("public.pem"), PUBLIC_KEY).unwrap();
        let candidate = signed(directory.path(), "candidate.json", 1);
        let prior = previous.map_or(
            crate::PreviousCatalog::Bootstrap,
            crate::PreviousCatalog::File,
        );
        let value = crate::prepare_catalog_snapshot()
            .catalog_file(&directory.path().join("candidate.json"))
            .previous(prior)
            .public_key_file(&directory.path().join("public.pem"))
            .key_id("release-2026")
            .repository("cadencr/registry")
            .registry_commit(&"a".repeat(40))
            .call()
            .unwrap();
        (directory, value, candidate)
    }

    #[test]
    fn strict_branch_and_url_match_javascript() {
        for valid in ["catalog", "A", "a_b-9", &"x".repeat(64)] {
            assert!(validate_discovery_branch(valid).is_ok());
        }
        for invalid in ["", "-bad", "_bad", "bad/slash", "bad.dot", &"x".repeat(65)] {
            assert!(validate_discovery_branch(invalid).is_err());
        }
        assert_eq!(discovery_url("cadencr/registry", "catalog").unwrap(), "https://raw.githubusercontent.com/cadencr/registry/refs/heads/catalog/managed-index.json");
        assert!(discovery_url("invalid", "catalog").is_err());
    }

    #[test]
    fn bootstrap_requires_absence_but_exact_candidate_replays() {
        let (_directory, snapshot, candidate) = snapshot(None);
        assert!(!assess_discovery_head(&snapshot, None).unwrap());
        assert!(assess_discovery_head(&snapshot, Some(&candidate)).unwrap());
        assert!(assess_discovery_head(&snapshot, Some(br#"{}"#))
            .unwrap_err()
            .to_string()
            .contains("not absent"));
    }

    #[test]
    fn baseline_uses_exact_raw_digest_and_enforces_bounds() {
        let source = tempfile::tempdir().unwrap();
        let baseline = signed(source.path(), "baseline.json", 2);
        let baseline_path = source.path().join("baseline.json");
        let mut padded = baseline.clone();
        padded.extend_from_slice(b" \n");
        std::fs::write(&baseline_path, &padded).unwrap();
        let (_directory, snapshot, candidate) = snapshot(Some(&baseline_path));
        assert!(!assess_discovery_head(&snapshot, Some(&padded)).unwrap());
        assert!(assess_discovery_head(&snapshot, Some(&candidate)).unwrap());
        for invalid in [baseline.as_slice(), b"not json", br#"{"foreign":true}"#] {
            assert!(assess_discovery_head(&snapshot, Some(invalid)).is_err());
        }
        assert!(
            assess_discovery_head(&snapshot, Some(&vec![b' '; MAX_DISCOVERY_BYTES + 1]))
                .unwrap_err()
                .to_string()
                .contains("1 MiB")
        );
    }

    #[test]
    fn node_oracle_matches_url_and_raw_digest() {
        let source = br#"{ "z": 1, "a": {"y":2,"b":3} }"#;
        let script = "import{discoveryUrl}from'../../tooling/marketplace-registry/scripts/publication/discovery-location.mjs';import{createHash}from'node:crypto';let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({url:discoveryUrl('cadencr/registry','catalog'),digest:createHash('sha256').update(s).digest('hex')})))";
        let mut child = Command::new("node")
            .args(["--input-type=module", "-e", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(source).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            oracle["url"],
            discovery_url("cadencr/registry", "catalog").unwrap()
        );
        assert_eq!(oracle["digest"], digest(source));
    }
}
