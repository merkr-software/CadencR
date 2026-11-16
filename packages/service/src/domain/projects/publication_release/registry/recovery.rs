use super::*;
use crate::domain::projects::publication_operations::journal::confirmed::{self, RegistryPlan};
use crate::domain::projects::publication_release::contribution::submission::Documents;
use crate::domain::projects::publication_release::plan::Plan;

pub(super) async fn recover(
    release: &Plan,
    documents: &Documents,
    account: &str,
    current: Option<String>,
) -> Result<Option<RegistryPlan>, AppError> {
    let identity = confirmed::RegistryIdentity::builder()
        .plugin_id(release.plugin_id.clone())
        .version(release.version.clone())
        .build();
    let plans = confirmed::recover(release.project_id, current, identity).await?;
    select(plans, release, documents, account)
}

fn select(
    plans: Vec<RegistryPlan>,
    release: &Plan,
    documents: &Documents,
    account: &str,
) -> Result<Option<RegistryPlan>, AppError> {
    let mut matching = plans.into_iter().filter(|plan| {
        plan.preview.plugin_id == release.plugin_id && plan.preview.version == release.version
    });
    let Some(original) = matching.next() else {
        return Ok(None);
    };
    if matching.next().is_some() {
        return Err(changed());
    }
    let mut reviewed = plan::build(
        release,
        documents,
        &documents.markdown,
        &state::Inspection {
            account: original.preview.account.clone(),
            actor_id: original.actor_id,
            repository_id: original.repository_id,
            base_branch: original.preview.base_branch.clone(),
            base_commit: original.preview.base_commit.clone(),
        },
    )?;
    reviewed.operation_id = original.preview.operation_id.clone();
    if reviewed != original.preview
        || account != original.preview.account
        || documents.package != original.package.as_bytes()
        || documents.submission != original.submission.as_bytes()
        || documents.markdown != original.markdown.as_bytes()
    {
        return Err(changed());
    }
    Ok(Some(original))
}

pub(super) async fn persist(prepared: &PreparedRegistry) -> Result<(), AppError> {
    let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).map_err(|_| changed());
    confirmed::persist(
        prepared.preview.project_id,
        RegistryPlan {
            preview: prepared.preview.clone(),
            actor_id: prepared.actor_id,
            repository_id: prepared.repository_id,
            package: text(&prepared.documents.package)?,
            submission: text(&prepared.documents.submission)?,
            markdown: text(&prepared.documents.markdown)?,
        },
    )
    .await
}

fn changed() -> AppError {
    conflict("PUBLICATION_REGISTRY_CONFIRMED_INTENT_CHANGED",
        "This plugin version already has a confirmed registry operation with different contents. Reconcile the original operation; a new preview cannot authorize a duplicate.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_preview_and_retry_keep_the_original_confirmed_identity_not_current_main() {
        let release = Plan {
            project_id: 7,
            plugin_id: "acme".into(),
            version: "1.0.0".into(),
            prerelease: false,
            bundle_id: "bundle".into(),
            repository: "acme/provider".into(),
            tag: "v1.0.0".into(),
            source_commit: "a".repeat(40),
            target: "linux-x86_64".into(),
            archive_name: "acme.tgz".into(),
            archive_sha256: "b".repeat(64),
            archive_size: 1,
            metadata_sha256: "c".repeat(64),
            archives: Vec::new(),
            release_notes: "notes".into(),
        };
        let documents = Documents {
            filename: "acme-1.0.0.json".into(),
            package: b"package".to_vec(),
            submission: b"submission".to_vec(),
            markdown: b"body".to_vec(),
        };
        let mut remote = state::Inspection {
            account: "alice".into(),
            actor_id: 11,
            repository_id: 1,
            base_branch: "main".into(),
            base_commit: "d".repeat(40),
        };
        let mut preview = plan::build(&release, &documents, &documents.markdown, &remote).unwrap();
        preview.operation_id = "e".repeat(64);
        let original = RegistryPlan {
            preview: preview.clone(),
            actor_id: 11,
            repository_id: 1,
            package: "package".into(),
            submission: "submission".into(),
            markdown: "body".into(),
        };
        remote.base_commit = "f".repeat(40);
        let fresh_plan = plan::build(&release, &documents, &documents.markdown, &remote).unwrap();
        assert_ne!(fresh_plan.branch, preview.branch);
        assert_ne!(fresh_plan.plan_sha256, preview.plan_sha256);
        for _ in 0..2 {
            let recovered = select(vec![original.clone()], &release, &documents, "alice")
                .unwrap()
                .unwrap();
            assert_eq!(recovered.preview.branch, preview.branch);
            assert_eq!(recovered.preview.operation_id, preview.operation_id);
            assert_eq!(recovered.preview.plan_sha256, preview.plan_sha256);
            assert_eq!(recovered.preview.base_commit, preview.base_commit);
        }
        assert!(select(vec![original.clone()], &release, &documents, "bob").is_err());
        let mut changed = release;
        changed.release_notes.push('!');
        assert!(select(vec![original.clone()], &changed, &documents, "alice").is_err());
    }
}
