use crate::shared::slug::slugify;
use serde::Serialize;
use sha2::{Digest as _, Sha256};

use super::state::Inspection;
use super::PublicationRegistryPreview;
use crate::domain::projects::publication_release::contribution::submission::Documents;
use crate::domain::projects::publication_release::local::digest;
use crate::domain::projects::publication_release::plan::Plan;
use crate::error::AppError;

#[derive(Serialize)]
struct Bound<'a> {
    policy_version: u32,
    project_id: i64,
    plugin_id: &'a str,
    version: &'a str,
    bundle_id: &'a str,
    release_notes: &'a str,
    account: &'a str,
    actor_id: u64,
    registry_repository: &'a str,
    repository_id: u64,
    base_branch: &'a str,
    base_commit: &'a str,
    branch: &'a str,
    package_path: &'a str,
    package_sha256: String,
    submission_path: &'a str,
    submission_sha256: String,
    pull_request_body_sha256: String,
}

pub(super) fn build(
    release: &Plan,
    documents: &Documents,
    pull_request_body: &[u8],
    remote: &Inspection,
) -> Result<PublicationRegistryPreview, AppError> {
    let package_path = format!("packages/{}", documents.filename);
    let submission_path = format!("submissions/{}", documents.filename);
    let identity = format!(
        "{}:{}:{}",
        remote.actor_id, remote.repository_id, remote.base_commit
    );
    let mut branch_digest = Sha256::new();
    for bytes in [
        identity.as_bytes(),
        documents.package.as_slice(),
        documents.submission.as_slice(),
        pull_request_body,
    ] {
        branch_digest.update(bytes);
    }
    let branch_digest: String = branch_digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let branch = format!(
        "cadencr/{}-{}-{}",
        slugify(&release.plugin_id),
        slugify(&release.version),
        &branch_digest[..12]
    );
    let bound = Bound {
        policy_version: 1,
        project_id: release.project_id,
        plugin_id: &release.plugin_id,
        version: &release.version,
        bundle_id: &release.bundle_id,
        release_notes: &release.release_notes,
        account: &remote.account,
        actor_id: remote.actor_id,
        registry_repository: super::REGISTRY,
        repository_id: remote.repository_id,
        base_branch: &remote.base_branch,
        base_commit: &remote.base_commit,
        branch: &branch,
        package_path: &package_path,
        package_sha256: digest(&documents.package),
        submission_path: &submission_path,
        submission_sha256: digest(&documents.submission),
        pull_request_body_sha256: digest(pull_request_body),
    };
    let bytes = serde_json::to_vec(&bound)
        .map_err(|error| AppError::Internal(format!("encode registry plan: {error}")))?;
    Ok(PublicationRegistryPreview {
        project_id: release.project_id,
        plugin_id: release.plugin_id.clone(),
        version: release.version.clone(),
        bundle_id: release.bundle_id.clone(),
        release_notes: release.release_notes.clone(),
        account: remote.account.clone(),
        registry_repository: super::REGISTRY.into(),
        base_branch: remote.base_branch.clone(),
        base_commit: remote.base_commit.clone(),
        branch,
        package_path,
        submission_path,
        plan_sha256: digest(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release() -> Plan {
        Plan {
            project_id: 1,
            plugin_id: "acme".into(),
            version: "1.0.0".into(),
            prerelease: false,
            bundle_id: "00000000-0000-4000-8000-000000000000".into(),
            repository: "acme/provider".into(),
            tag: "v1.0.0".into(),
            source_commit: "a".repeat(40),
            target: "linux-x86_64".into(),
            archive_name: "acme.tgz".into(),
            archive_sha256: "b".repeat(64),
            archive_size: 1,
            metadata_sha256: "c".repeat(64),
            release_notes: "notes".into(),
        }
    }

    fn fixture_documents() -> Documents {
        Documents {
            filename: "acme-1.0.0.json".into(),
            package: b"package".to_vec(),
            submission: b"submission".to_vec(),
            markdown: b"body".to_vec(),
        }
    }

    fn fixture_remote() -> Inspection {
        Inspection {
            account: "alice".into(),
            actor_id: 7,
            repository_id: 8,
            base_branch: "main".into(),
            base_commit: "d".repeat(40),
        }
    }

    #[test]
    fn branch_segment_is_bounded_and_portable() {
        assert_eq!(slugify("hello/world 1.0"), "hello-world-1-0");
        assert!(slugify(&"a".repeat(100)).len() <= 50);
    }

    #[test]
    fn fingerprint_and_branch_bind_actor_base_and_exact_documents() {
        let release = release();
        let documents = fixture_documents();
        let remote = fixture_remote();
        let baseline = build(&release, &documents, &documents.markdown, &remote).unwrap();
        let mut changed = fixture_remote();
        changed.actor_id += 1;
        let actor = build(&release, &documents, &documents.markdown, &changed).unwrap();
        changed = fixture_remote();
        changed.base_commit = "e".repeat(40);
        let base = build(&release, &documents, &documents.markdown, &changed).unwrap();
        let mut changed_docs = fixture_documents();
        changed_docs.package.push(b'!');
        let docs = build(&release, &changed_docs, &changed_docs.markdown, &remote).unwrap();
        for candidate in [&actor, &base, &docs] {
            assert_ne!(baseline.plan_sha256, candidate.plan_sha256);
            assert_ne!(baseline.branch, candidate.branch);
        }
    }
}
