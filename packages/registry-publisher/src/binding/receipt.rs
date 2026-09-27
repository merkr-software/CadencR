use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{
    compact_artifacts, read_optional, CompactArtifact, PublicationBinding, PUBLICATION_RECEIPT,
};
use crate::PublisherError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationReceipt {
    pub schema_version: u64,
    pub status: String,
    pub repository: String,
    pub registry_commit: String,
    pub release_id: u64,
    pub release_tag: String,
    pub tag_commit: String,
    pub plan_sha256: String,
    pub artifacts: Vec<CompactArtifact>,
}

#[bon::builder]
pub(crate) fn build_publication_receipt(
    binding: &PublicationBinding,
    repository: &str,
    registry_commit: &str,
    release_id: u64,
) -> PublicationReceipt {
    PublicationReceipt {
        schema_version: 1,
        status: "published_verified".to_owned(),
        repository: repository.to_owned(),
        registry_commit: registry_commit.to_owned(),
        release_id,
        release_tag: binding.tag.clone(),
        tag_commit: registry_commit.to_owned(),
        plan_sha256: binding.plan_sha256.clone(),
        artifacts: compact_artifacts(&binding.expected),
    }
}

#[bon::builder]
pub(crate) fn read_publication_receipt(
    directory: &Path,
    binding: &PublicationBinding,
    repository: &str,
    registry_commit: &str,
    release_id: u64,
) -> Result<Option<PublicationReceipt>, PublisherError> {
    validate_release_id(release_id)?;
    let actual = read_unbound_publication_receipt(directory)?;
    let Some(actual) = actual else {
        return Ok(None);
    };
    validate_publication_receipt(&actual, binding, repository, registry_commit, release_id)?;
    Ok(Some(actual))
}

pub(crate) fn read_unbound_publication_receipt(
    directory: &Path,
) -> Result<Option<PublicationReceipt>, PublisherError> {
    read_optional::<PublicationReceipt>(directory, PUBLICATION_RECEIPT, "publication receipt")
}

pub(crate) fn validate_publication_receipt(
    actual: &PublicationReceipt,
    binding: &PublicationBinding,
    repository: &str,
    registry_commit: &str,
    release_id: u64,
) -> Result<(), PublisherError> {
    validate_release_id(release_id)?;
    if !publication_receipt_identity_matches(
        actual,
        repository,
        registry_commit,
        &binding.tag,
        &binding.plan_sha256,
        Some(release_id),
    ) {
        return Err(PublisherError::new(
            "existing publication receipt conflicts",
        ));
    }
    if actual.artifacts != compact_artifacts(&binding.expected) {
        return Err(PublisherError::new(
            "existing publication receipt conflicts",
        ));
    }
    Ok(())
}

pub(crate) fn publication_receipt_identity_matches(
    receipt: &PublicationReceipt,
    repository: &str,
    registry_commit: &str,
    release_tag: &str,
    plan_sha256: &str,
    release_id: Option<u64>,
) -> bool {
    receipt.schema_version == 1
        && receipt.status == "published_verified"
        && receipt.repository == repository
        && receipt.registry_commit == registry_commit
        && receipt.release_tag == release_tag
        && receipt.tag_commit == registry_commit
        && receipt.plan_sha256 == plan_sha256
        && super::valid_release_id(receipt.release_id)
        && release_id.is_none_or(|expected| receipt.release_id == expected)
}

fn validate_release_id(release_id: u64) -> Result<(), PublisherError> {
    if !super::valid_release_id(release_id) {
        return Err(PublisherError::new("publication release id is invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::build_publication_binding;
    use crate::StageReceipt;
    use serde_json::json;

    #[test]
    fn publication_receipt_is_exact_and_conflicts_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let staged = StageReceipt {
            schema_version: 1,
            plan: json!({"release":{"tag":"provider-acme-v1"},"targets":[]}),
            artifacts: vec![],
        };
        let binding = build_publication_binding(
            &staged,
            "cadencr/registry",
            &"b".repeat(40),
            directory.path(),
        )
        .unwrap();
        assert!(read_publication_receipt()
            .directory(directory.path())
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&"b".repeat(40))
            .release_id(0)
            .call()
            .is_err());
        assert!(read_publication_receipt()
            .directory(directory.path())
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&"b".repeat(40))
            .release_id(7)
            .call()
            .unwrap()
            .is_none());
        let receipt = build_publication_receipt()
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&"b".repeat(40))
            .release_id(7)
            .call();
        std::fs::write(
            directory.path().join(PUBLICATION_RECEIPT),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_publication_receipt()
                .directory(directory.path())
                .binding(&binding)
                .repository("cadencr/registry")
                .registry_commit(&"b".repeat(40))
                .release_id(7)
                .call()
                .unwrap(),
            Some(receipt)
        );
        let mut extra = serde_json::to_value(
            build_publication_receipt()
                .binding(&binding)
                .repository("cadencr/registry")
                .registry_commit(&"b".repeat(40))
                .release_id(7)
                .call(),
        )
        .unwrap();
        extra["unexpected"] = json!(true);
        std::fs::write(
            directory.path().join(PUBLICATION_RECEIPT),
            serde_json::to_vec(&extra).unwrap(),
        )
        .unwrap();
        assert!(read_publication_receipt()
            .directory(directory.path())
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&"b".repeat(40))
            .release_id(7)
            .call()
            .is_err());
        std::fs::write(
            directory.path().join(PUBLICATION_RECEIPT),
            serde_json::to_vec(
                &build_publication_receipt()
                    .binding(&binding)
                    .repository("cadencr/registry")
                    .registry_commit(&"b".repeat(40))
                    .release_id(7)
                    .call(),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(read_publication_receipt()
            .directory(directory.path())
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&"c".repeat(40))
            .release_id(7)
            .call()
            .is_err());
        assert!(read_publication_receipt()
            .directory(directory.path())
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&"b".repeat(40))
            .release_id(9_007_199_254_740_992)
            .call()
            .is_err());
    }
}
