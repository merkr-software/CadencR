use std::collections::BTreeSet;
use std::path::PathBuf;

use super::{digest, invalid, load, LocalRelease};
use crate::domain::projects::publication_release::remote::GitHubArchive;
use crate::domain::projects::publication_release::PublicationReleaseArchive;
use crate::error::AppError;

pub(in crate::domain::projects::publication_release) fn load_candidate(
    project_id: i64,
    plugin_id: String,
    output_root: PathBuf,
    bundle_id: &str,
    additional: &[String],
    release_notes: String,
) -> Result<LocalRelease, AppError> {
    if additional.len() > 5 {
        return Err(invalid(
            "a release candidate supports at most six platform bundles",
        ));
    }
    let mut ids = vec![bundle_id.to_owned()];
    ids.extend_from_slice(additional);
    ids.sort();
    let mut seen_ids = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut candidate: Option<LocalRelease> = None;
    for id in ids {
        if !seen_ids.insert(id.clone()) {
            return Err(invalid("release candidate contains duplicate bundle ids"));
        }
        let local = load(
            project_id,
            plugin_id.clone(),
            output_root.clone(),
            &id,
            release_notes.clone(),
        )?;
        if !targets.insert(local.plan.target.clone())
            || !names.insert(local.plan.archive_name.clone())
        {
            return Err(invalid(
                "release candidate targets and archive names must be unique",
            ));
        }
        let archive = PublicationReleaseArchive {
            bundle_id: id,
            target: local.plan.target.clone(),
            archive_name: local.plan.archive_name.clone(),
            archive_sha256: local.plan.archive_sha256.clone(),
            archive_size: local.plan.archive_size,
        };
        if let Some(current) = &mut candidate {
            merge_metadata(current, &local)?;
            current.additional_archives.push(GitHubArchive {
                name: local.plan.archive_name,
                sha256: local.plan.archive_sha256,
                file: local.archive_file,
            });
            current.plan.archives.push(archive);
        } else {
            let mut local = local;
            local.plan.archives.push(archive);
            candidate = Some(local);
        }
    }
    let mut candidate = candidate.ok_or_else(|| invalid("release candidate is empty"))?;
    // Preserve the caller's primary bundle identifier, independent of canonical order.
    candidate.plan.bundle_id = bundle_id.into();
    let expected: BTreeSet<_> = candidate.declared_targets.iter().cloned().collect();
    if targets != expected {
        return Err(invalid(
            "release candidate must include every declared platform exactly once",
        ));
    }
    candidate.plan.metadata_sha256 = digest(&candidate.metadata);
    Ok(candidate)
}

fn merge_metadata(current: &mut LocalRelease, other: &LocalRelease) -> Result<(), AppError> {
    if current.declared_metadata != other.declared_metadata {
        return Err(invalid(
            "release candidate platform declarations differ beyond built digests",
        ));
    }
    if current.declared_targets.iter().collect::<BTreeSet<_>>()
        != other.declared_targets.iter().collect::<BTreeSet<_>>()
    {
        return Err(invalid(
            "release candidate bundles must declare the same platform set",
        ));
    }
    if current.plan.version != other.plan.version
        || current.plan.repository != other.plan.repository
        || current.plan.tag != other.plan.tag
    {
        return Err(invalid(
            "release candidate bundles must share version, repository and tag",
        ));
    }
    let mut left: serde_json::Value = serde_json::from_slice(&current.metadata)
        .map_err(|error| invalid(format!("cannot decode candidate metadata: {error}")))?;
    let mut right: serde_json::Value = serde_json::from_slice(&other.metadata)
        .map_err(|error| invalid(format!("cannot decode bundle metadata: {error}")))?;
    let left_binary = left["agent"]["distribution"]["binary"].take();
    let right_binary = right["agent"]["distribution"]["binary"].take();
    if left != right {
        return Err(invalid(
            "release candidate bundles must share all non-platform metadata",
        ));
    }
    let mut binary = left_binary
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("candidate binary map is missing"))?;
    binary.extend(
        right_binary
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("bundle binary map is missing"))?,
    );
    left["agent"]["distribution"]["binary"] = serde_json::Value::Object(binary);
    current.metadata = serde_json::to_vec_pretty(&left)
        .map_err(|error| invalid(format!("cannot encode candidate metadata: {error}")))?
        .into();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bundle(root: &std::path::Path, id: &str, target: &str, bytes: &[u8]) {
        let dir = root.join("1").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let artifact = |platform: &str| {
            json!({
                "archive":format!("https://github.com/acme/provider/releases/download/v1.0.0/{platform}.tgz"),
                "cmd":"bin/acme", "sha256": if platform == target { digest(bytes) } else { "0".repeat(64) }
            })
        };
        let metadata = json!({
            "agent":{"id":"acme","name":"Acme","version":"1.0.0","description":"ACP",
                "repository":"https://github.com/acme/provider", "distribution":{"binary":{
                    "linux-x86_64":artifact("linux-x86_64"),"darwin-aarch64":artifact("darwin-aarch64")}}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"},"assets":{"icon":"icon.svg"}}
        });
        std::fs::write(dir.join("provider.tar.gz"), bytes).unwrap();
        std::fs::write(dir.join("target.json"), serde_json::to_vec(target).unwrap()).unwrap();
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn candidate_is_complete_unique_and_order_independent() {
        let root = tempfile::tempdir().unwrap();
        let first = "00000000-0000-4000-8000-000000000001";
        let second = "00000000-0000-4000-8000-000000000002";
        bundle(root.path(), first, "linux-x86_64", b"linux");
        bundle(root.path(), second, "darwin-aarch64", b"darwin");
        let call = |primary: &str, extras: &[String]| {
            load_candidate(
                1,
                "acme".into(),
                root.path().into(),
                primary,
                extras,
                "notes".into(),
            )
        };
        assert!(call(first, &[]).is_err(), "partial candidate accepted");
        assert!(call(first, &[first.into()]).is_err(), "duplicate accepted");
        let candidate = call(first, &[second.into()]).unwrap();
        let reversed = call(second, &[first.into()]).unwrap();
        assert_eq!(candidate.metadata, reversed.metadata);
        assert_eq!(candidate.plan.archives.len(), 2);
        assert_eq!(candidate.additional_archives.len(), 1);
        let value: serde_json::Value = serde_json::from_slice(&candidate.metadata).unwrap();
        assert_eq!(
            value["agent"]["distribution"]["binary"]["linux-x86_64"]["sha256"],
            digest(b"linux")
        );
        assert_eq!(
            value["agent"]["distribution"]["binary"]["darwin-aarch64"]["sha256"],
            digest(b"darwin")
        );
        let path = root.path().join("1").join(second).join("package.json");
        let mut changed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        changed["host"]["publisher"] = json!("other");
        std::fs::write(path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(
            call(first, &[second.into()]).is_err(),
            "metadata mismatch accepted"
        );
    }
}
