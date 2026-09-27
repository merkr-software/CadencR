use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs::read_bounded;
use crate::{PublisherError, StageReceipt};

mod prebinding;
mod receipt;
pub(crate) use prebinding::{build_publication_prebinding, PublicationPrebinding};
pub use receipt::PublicationReceipt;
pub(crate) use receipt::{
    build_publication_receipt, publication_receipt_identity_matches, read_publication_receipt,
    read_unbound_publication_receipt, validate_publication_receipt,
};

pub(crate) const MAX_PUBLICATION_METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MIRROR_RECEIPT: &str = "mirror-receipt.json";
pub(crate) const PUBLICATION_RECEIPT: &str = "publication-receipt.json";

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
#[serde(deny_unknown_fields)]
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

pub(crate) fn build_publication_binding(
    staged: &StageReceipt,
    repository: &str,
    registry_commit: &str,
    directory: &Path,
) -> Result<PublicationBinding, PublisherError> {
    build_publication_prebinding(&staged.plan, repository, registry_commit)?.bind(staged, directory)
}

impl PublicationPrebinding {
    pub(crate) fn bind(
        self,
        staged: &StageReceipt,
        directory: &Path,
    ) -> Result<PublicationBinding, PublisherError> {
        if staged.artifacts.len() + 1 != self.expected.len() {
            return Err(PublisherError::new(
                "staged artifacts do not match publication plan",
            ));
        }
        let mut expected = Vec::with_capacity(self.expected.len());
        for (artifact, target) in staged.artifacts.iter().zip(&self.expected) {
            if target.name != artifact.asset
                || target.sha256 != artifact.sha256
                || target.size.is_some()
            {
                return Err(PublisherError::new(
                    "staged artifact does not match publication plan",
                ));
            }
            expected.push(ExpectedArtifact {
                name: artifact.asset.clone(),
                sha256: artifact.sha256.clone(),
                size: artifact.size,
                source: ArtifactSource::File(directory.join(&artifact.asset)),
                expected_url: target.expected_url.clone(),
            });
        }
        let provenance = self
            .expected
            .into_iter()
            .last()
            .ok_or_else(|| PublisherError::new("publication provenance is missing"))?;
        expected.push(ExpectedArtifact {
            name: provenance.name,
            sha256: provenance.sha256,
            size: provenance
                .size
                .ok_or_else(|| PublisherError::new("publication provenance size is missing"))?,
            source: ArtifactSource::Bytes(self.provenance_bytes),
            expected_url: provenance.expected_url,
        });
        Ok(PublicationBinding {
            tag: self.tag,
            plan_sha256: self.plan_sha256,
            body: self.body,
            expected,
        })
    }
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
    let valid = mirror_receipt_identity_matches(
        &receipt,
        repository,
        registry_commit,
        &binding.tag,
        &binding.plan_sha256,
    ) && receipt.artifacts == compact_artifacts(&binding.expected);
    if !valid {
        return Err(PublisherError::new(
            "existing mirror receipt conflicts with publication",
        ));
    }
    Ok(Some(receipt))
}

pub(crate) fn mirror_receipt_identity_matches(
    receipt: &MirrorReceipt,
    repository: &str,
    registry_commit: &str,
    release_tag: &str,
    plan_sha256: &str,
) -> bool {
    receipt.schema_version == 1
        && matches!(
            receipt.status.as_str(),
            "draft_verified" | "published_recovered"
        )
        && receipt.repository == repository
        && receipt.registry_commit == registry_commit
        && receipt.release_tag == release_tag
        && receipt.plan_sha256 == plan_sha256
        && valid_release_id(receipt.release_id)
}

pub(crate) fn valid_release_id(value: u64) -> bool {
    (1..=9_007_199_254_740_991).contains(&value)
}

pub(super) fn read_optional<T: serde::de::DeserializeOwned>(
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

#[cfg(test)]
mod tests {
    use std::process::Command;

    use serde_json::json;
    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::StageArtifact;

    #[test]
    fn binding_matches_javascript_oracle_including_newline_hashes() {
        let directory = tempfile::tempdir().unwrap();
        let staged = StageReceipt {
            schema_version: 1,
            plan: json!({
                "release":{"tag":"provider-acme-v1"},
                "targets":[{"asset":"provider.tgz","sha256":"11".repeat(32),"destination_url":"https://github.com/cadencr/registry/releases/download/provider-acme-v1/provider.tgz"}]
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
            crate::hex(&Sha256::digest(
                cadencr_registry_core::canonical_json_bytes(&staged.plan)
            )),
            binding.plan_sha256
        );
        assert_ne!(binding.plan_sha256, binding.expected.last().unwrap().sha256);
    }
}
