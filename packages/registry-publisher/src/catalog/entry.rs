use std::path::Path;

use super::manifest::{resolve_input, Publication};
use super::{checked_budget, PreparedEntry, MAX_INPUT_BYTES, MAX_SUBMISSION_BYTES};
use crate::binding::{build_publication_prebinding, read_publication_receipt};
use crate::fs::read_bounded;
use crate::{PublisherError, StageArtifact, StageReceipt};

pub(super) fn prepare(
    publication: &Publication,
    position: usize,
    repository: &str,
    base: &Path,
    input_bytes: &mut u64,
) -> Result<PreparedEntry, PublisherError> {
    let submission_file = resolve_input(base, &publication.submission);
    let directory = resolve_input(base, &publication.directory);
    crate::publication_local::validate_existing_directory(&directory, "catalog signing")?;
    let bytes = read_bounded(
        &submission_file,
        MAX_SUBMISSION_BYTES,
        &format!("submission {}", position + 1),
    )?;
    *input_bytes = checked_budget(
        *input_bytes,
        bytes.len() as u64,
        MAX_INPUT_BYTES,
        "catalog inputs exceed 32 MiB",
    )?;
    let submission = cadencr_registry_core::parse_json_bytes(&bytes).map_err(|_| {
        PublisherError::new(format!("submission {} must be valid JSON", position + 1))
    })?;
    let plan = cadencr_registry_core::create_publication_plan(&submission, repository)?;
    let prebinding = build_publication_prebinding(&plan, repository, &publication.registry_commit)?;
    let receipts = crate::recover::local::prebound_receipts(
        &directory,
        &prebinding,
        repository,
        &publication.registry_commit,
    )?;
    let mirror = receipts
        .mirror
        .ok_or_else(|| PublisherError::new("mirror receipt is required for catalog signing"))?;
    // Archive sizes come only from strictly prebound receipts. Binding constructs
    // source paths but catalog verification never opens those historical paths.
    let staged = StageReceipt {
        schema_version: 1,
        plan,
        artifacts: mirror
            .artifacts
            .iter()
            .take(prebinding.expected.len() - 1)
            .map(|artifact| StageArtifact {
                asset: artifact.name.clone(),
                sha256: artifact.sha256.clone(),
                size: artifact.size,
            })
            .collect(),
    };
    let binding = prebinding.bind(&staged, &directory)?;
    read_publication_receipt()
        .directory(&directory)
        .binding(&binding)
        .repository(repository)
        .registry_commit(&publication.registry_commit)
        .release_id(mirror.release_id)
        .call()?
        .ok_or_else(|| {
            PublisherError::new("publication receipt is required for catalog signing")
        })?;
    let package = staged
        .plan
        .get("mirrored_package")
        .cloned()
        .ok_or_else(|| PublisherError::new("publication plan mirrored package is missing"))?;
    Ok(PreparedEntry {
        directory,
        expected: binding.expected,
        package,
    })
}
