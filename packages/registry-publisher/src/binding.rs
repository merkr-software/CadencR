use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::fs::read_bounded;
use crate::{PublisherError, StageReceipt};

pub(crate) const MAX_PUBLICATION_METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MIRROR_RECEIPT: &str = "mirror-receipt.json";
const PROVENANCE: &str = "publication-plan.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactArtifact {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArtifactSource {
    File(PathBuf),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExpectedArtifact {
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub source: ArtifactSource,
    pub expected_url: String,
}

pub(crate) struct PublicationBinding {
    pub tag: String,
    pub plan_sha256: String,
    pub body: String,
    pub expected: Vec<ExpectedArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorReceipt {
    pub schema_version: u64,
    pub status: String,
    pub repository: String,
    pub registry_commit: String,
    pub release_id: u64,
    pub release_tag: String,
    pub plan_sha256: String,
    pub artifacts: Vec<CompactArtifact>,
}

#[derive(Deserialize)]
struct PlanView {
    release: ReleaseView,
    targets: Vec<TargetView>,
}

#[derive(Deserialize)]
struct ReleaseView {
    tag: String,
}

#[derive(Deserialize)]
struct TargetView {
    asset: String,
    destination_url: String,
}

pub(crate) fn build_publication_binding(
    staged: &StageReceipt,
    repository: &str,
    registry_commit: &str,
    directory: &Path,
) -> Result<PublicationBinding, PublisherError> {
    let mut plan_bytes = cadencr_registry_core::canonical_json_bytes(&staged.plan);
    let plan_sha256 = digest(&plan_bytes);
    plan_bytes.push(b'\n');
    if plan_bytes.len() as u64 > MAX_PUBLICATION_METADATA_BYTES {
        return Err(PublisherError::new("publication plan exceeds 4 MiB"));
    }
    let plan: PlanView = serde_json::from_value(staged.plan.clone())
        .map_err(|_| PublisherError::new("publication plan binding is invalid"))?;
    let mut expected = Vec::with_capacity(staged.artifacts.len() + 1);
    for artifact in &staged.artifacts {
        let target = plan
            .targets
            .iter()
            .find(|target| target.asset == artifact.asset)
            .ok_or_else(|| {
                PublisherError::new("staged artifact is absent from publication plan")
            })?;
        expected.push(ExpectedArtifact {
            name: artifact.asset.clone(),
            sha256: artifact.sha256.clone(),
            size: artifact.size,
            source: ArtifactSource::File(directory.join(&artifact.asset)),
            expected_url: target.destination_url.clone(),
        });
    }
    expected.push(ExpectedArtifact {
        name: PROVENANCE.to_owned(),
        sha256: digest(&plan_bytes),
        size: plan_bytes.len() as u64,
        source: ArtifactSource::Bytes(plan_bytes.clone()),
        expected_url: format!(
            "https://github.com/{repository}/releases/download/{}/{PROVENANCE}",
            plan.release.tag
        ),
    });
    let body = format!(
        "cadencr-registry-mirror-v1\nplan-sha256:{plan_sha256}\nregistry-commit:{registry_commit}"
    );
    Ok(PublicationBinding {
        tag: plan.release.tag,
        plan_sha256,
        body,
        expected,
    })
}

pub(crate) fn compact_artifacts(expected: &[ExpectedArtifact]) -> Vec<CompactArtifact> {
    expected
        .iter()
        .map(|artifact| CompactArtifact {
            name: artifact.name.clone(),
            sha256: artifact.sha256.clone(),
            size: artifact.size,
        })
        .collect()
}

pub(crate) fn read_mirror_receipt(
    directory: &Path,
    binding: &PublicationBinding,
    repository: &str,
    registry_commit: &str,
) -> Result<Option<MirrorReceipt>, PublisherError> {
    let Some(receipt) =
        read_optional::<MirrorReceipt>(directory, MIRROR_RECEIPT, "mirror receipt")?
    else {
        return Ok(None);
    };
    let valid = receipt.schema_version == 1
        && matches!(
            receipt.status.as_str(),
            "draft_verified" | "published_recovered"
        )
        && receipt.repository == repository
        && receipt.registry_commit == registry_commit
        && receipt.release_tag == binding.tag
        && receipt.plan_sha256 == binding.plan_sha256
        && (1..=9_007_199_254_740_991).contains(&receipt.release_id)
        && receipt.artifacts == compact_artifacts(&binding.expected);
    if !valid {
        return Err(PublisherError::new(
            "existing mirror receipt conflicts with publication",
        ));
    }
    Ok(Some(receipt))
}

fn read_optional<T: serde::de::DeserializeOwned>(
    directory: &Path,
    name: &str,
    label: &str,
) -> Result<Option<T>, PublisherError> {
    let path = directory.join(name);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(PublisherError::io(&format!("inspect {label}"), error)),
        Ok(_) => {}
    }
    let bytes = read_bounded(&path, MAX_PUBLICATION_METADATA_BYTES, label)?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new(format!("existing {label} is invalid")))?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| PublisherError::new(format!("existing {label} is invalid")))
}

fn digest(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use serde_json::json;

    use super::*;
    use crate::StageArtifact;

    #[test]
    fn binding_matches_javascript_oracle_including_newline_hashes() {
        let directory = tempfile::tempdir().unwrap();
        let staged = StageReceipt {
            schema_version: 1,
            plan: json!({
                "release":{"tag":"provider-acme-v1"},
                "targets":[{"asset":"provider.tgz","destination_url":"https://github.com/cadencr/registry/releases/download/provider-acme-v1/provider.tgz"}]
            }),
            artifacts: vec![StageArtifact {
                asset: "provider.tgz".to_owned(),
                sha256: "11".repeat(32),
                size: 7,
            }],
        };
        let binding = build_publication_binding(
            &staged,
            "cadencr/registry",
            &"b".repeat(40),
            directory.path(),
        )
        .unwrap();
        let module = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tooling/marketplace-registry/scripts/publication/binding.mjs");
        let script = r#"
import { pathToFileURL } from 'node:url';
const { buildPublicationBinding } = await import(pathToFileURL(process.argv[1]));
const staged = JSON.parse(process.argv[2]);
const value = buildPublicationBinding(staged, 'cadencr/registry', 'b'.repeat(40), process.argv[3]);
process.stdout.write(JSON.stringify({tag:value.tag,planSha256:value.planSha256,body:value.body,expected:value.expected.map(({name,sha256,size,expectedUrl})=>({name,sha256,size,expectedUrl}))}));
"#;
        let output = Command::new("node")
            .args(["--input-type=module", "-e", script])
            .arg(module)
            .arg(serde_json::to_string(&staged).unwrap())
            .arg(directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let expected = json!({
            "tag":binding.tag,
            "planSha256":binding.plan_sha256,
            "body":binding.body,
            "expected":binding.expected.iter().map(|item| json!({"name":&item.name,"sha256":&item.sha256,"size":item.size,"expectedUrl":&item.expected_url})).collect::<Vec<_>>()
        });
        assert_eq!(actual, expected);
        assert_eq!(
            digest(&cadencr_registry_core::canonical_json_bytes(&staged.plan)),
            binding.plan_sha256
        );
        assert_ne!(binding.plan_sha256, binding.expected.last().unwrap().sha256);
    }
}
