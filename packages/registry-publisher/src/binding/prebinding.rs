use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use super::MAX_PUBLICATION_METADATA_BYTES;
use crate::PublisherError;

const PROVENANCE: &str = "publication-plan.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreboundArtifact {
    pub name: String,
    pub sha256: String,
    pub size: Option<u64>,
    pub expected_url: String,
}

pub(crate) struct PublicationPrebinding {
    pub tag: String,
    pub plan_sha256: String,
    pub body: String,
    pub expected: Vec<PreboundArtifact>,
    pub(super) provenance_bytes: Vec<u8>,
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
    sha256: String,
    destination_url: String,
}

pub(crate) fn build_publication_prebinding(
    plan: &serde_json::Value,
    repository: &str,
    registry_commit: &str,
) -> Result<PublicationPrebinding, PublisherError> {
    let canonical = cadencr_registry_core::canonical_json_bytes(plan);
    let plan_sha256 = digest(&canonical);
    let plan: PlanView = serde_json::from_slice(&canonical)
        .map_err(|_| PublisherError::new("publication plan binding is invalid"))?;
    let mut provenance = canonical;
    provenance.push(b'\n');
    if provenance.len() as u64 > MAX_PUBLICATION_METADATA_BYTES {
        return Err(PublisherError::new("publication plan exceeds 4 MiB"));
    }
    let mut expected = plan
        .targets
        .into_iter()
        .map(|target| PreboundArtifact {
            name: target.asset,
            sha256: target.sha256,
            size: None,
            expected_url: target.destination_url,
        })
        .collect::<Vec<_>>();
    expected.push(PreboundArtifact {
        name: PROVENANCE.to_owned(),
        sha256: digest(&provenance),
        size: Some(provenance.len() as u64),
        expected_url: format!(
            "https://github.com/{repository}/releases/download/{}/{PROVENANCE}",
            plan.release.tag
        ),
    });
    let body = format!(
        "cadencr-registry-mirror-v1\nplan-sha256:{plan_sha256}\nregistry-commit:{registry_commit}"
    );
    Ok(PublicationPrebinding {
        tag: plan.release.tag,
        plan_sha256,
        body,
        expected,
        provenance_bytes: provenance,
    })
}

fn digest(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn prebinding_defers_only_archive_sizes_and_exactly_binds_provenance() {
        let plan = json!({
            "release":{"tag":"provider-acme-v1"},
            "targets":[{
                "asset":"provider.tgz",
                "sha256":"11".repeat(32),
                "destination_url":"https://github.com/cadencr/registry/releases/download/provider-acme-v1/provider.tgz"
            }]
        });
        let binding =
            build_publication_prebinding(&plan, "cadencr/registry", &"b".repeat(40)).unwrap();
        assert_eq!(binding.tag, "provider-acme-v1");
        assert_eq!(binding.expected[0].size, None);
        assert_eq!(binding.expected[0].sha256, "11".repeat(32));
        let provenance = binding.expected.last().unwrap();
        assert_eq!(provenance.name, "publication-plan.json");
        assert_eq!(provenance.size, Some(binding.provenance_bytes.len() as u64));
        assert_eq!(provenance.sha256, digest(&binding.provenance_bytes));
        assert!(binding.provenance_bytes.ends_with(b"\n"));
    }
}
