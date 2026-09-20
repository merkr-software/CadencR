use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize)]
pub(super) struct Plan {
    pub project_id: i64,
    pub plugin_id: String,
    pub version: String,
    pub prerelease: bool,
    pub bundle_id: String,
    pub repository: String,
    pub tag: String,
    pub source_commit: String,
    pub target: String,
    pub archive_name: String,
    pub archive_sha256: String,
    pub archive_size: u64,
    pub metadata_sha256: String,
    pub release_notes: String,
}

#[derive(Serialize)]
struct BoundPlan<'a> {
    policy_version: u32,
    plan: &'a Plan,
    account: &'a str,
    repository_id: u64,
    release_title: &'a str,
    make_latest: bool,
}

pub(super) fn plan_sha(plan: &Plan, account: &str, repository_id: u64) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(&BoundPlan {
        policy_version: 1,
        plan,
        account,
        repository_id,
        release_title: &plan.tag,
        make_latest: false,
    })
    .map_err(|error| AppError::Internal(format!("encode publication plan: {error}")))?;
    Ok(super::local::digest(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(notes: &str, archive: &str, head: &str) -> Plan {
        Plan {
            project_id: 1,
            plugin_id: "acme".into(),
            version: "1.0.0".into(),
            prerelease: false,
            bundle_id: "00000000-0000-4000-8000-000000000000".into(),
            repository: "acme/provider".into(),
            tag: "v1.0.0".into(),
            source_commit: head.into(),
            target: "linux-x86_64".into(),
            archive_name: "acme-linux.tgz".into(),
            archive_sha256: archive.into(),
            archive_size: 42,
            metadata_sha256: "metadata".into(),
            release_notes: notes.into(),
        }
    }

    #[test]
    fn fingerprint_binds_actor_repository_content_notes_and_head() {
        let base = plan("notes", "archive", "a");
        let digest = plan_sha(&base, "alice", 7).unwrap();
        assert_ne!(digest, plan_sha(&base, "bob", 7).unwrap());
        assert_ne!(digest, plan_sha(&base, "alice", 8).unwrap());
        assert_ne!(
            digest,
            plan_sha(&plan("changed", "archive", "a"), "alice", 7).unwrap()
        );
        assert_ne!(
            digest,
            plan_sha(&plan("notes", "changed", "a"), "alice", 7).unwrap()
        );
        assert_ne!(
            digest,
            plan_sha(&plan("notes", "archive", "b"), "alice", 7).unwrap()
        );
    }
}
