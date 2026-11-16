use serde::Serialize;
use serde_json::Value;

use super::super::local::LocalRelease;
use super::{markdown, validation};
use crate::error::AppError;

const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;

pub(crate) struct Documents {
    pub filename: String,
    pub package: Vec<u8>,
    pub submission: Vec<u8>,
    pub markdown: Vec<u8>,
}

#[derive(Serialize)]
struct Submission<'a> {
    schema_version: u8,
    package: &'a Value,
    source: Source<'a>,
    changelog: &'a str,
}

#[derive(Serialize)]
struct Source<'a> {
    repository: String,
    commit: &'a str,
    tag: &'a str,
}

pub(crate) fn build(local: &LocalRelease, account: &str) -> Result<Documents, AppError> {
    let package: Value = serde_json::from_slice(&local.metadata)
        .map_err(|error| invalid(format!("cannot decode package metadata: {error}")))?;
    validation::validate(
        &package,
        &local.plan.repository,
        &local.plan.source_commit,
        &local.plan.tag,
        &local.plan.release_notes,
    )?;
    let publisher = package
        .pointer(if package.get("kind").is_some() {
            "/package/host/publisher"
        } else {
            "/host/publisher"
        })
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("package.host.publisher is required"))?;
    let filename = format!("{}-{}.json", local.plan.plugin_id, local.plan.version);
    if filename.len() > 255 || filename.contains('/') || filename.contains('\\') {
        return Err(invalid("contribution filename is not portable"));
    }
    let package_bytes = local.metadata.to_vec();
    let submission = serde_json::to_vec_pretty(&Submission {
        schema_version: if package.get("kind").is_some() { 2 } else { 1 },
        package: &package,
        source: Source {
            repository: format!("https://github.com/{}", local.plan.repository),
            commit: &local.plan.source_commit,
            tag: &local.plan.tag,
        },
        changelog: &local.plan.release_notes,
    })
    .map_err(|error| invalid(format!("cannot encode submission: {error}")))?;
    let markdown = markdown::render(local, account, &filename, publisher);
    for (label, bytes) in [
        ("package", package_bytes.as_slice()),
        ("submission", submission.as_slice()),
        ("pull request markdown", markdown.as_slice()),
    ] {
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(invalid(format!("{label} exceeds 1 MiB")));
        }
    }
    Ok(Documents {
        filename,
        package: package_bytes,
        submission,
        markdown,
    })
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "REGISTRY_CONTRIBUTION_INVALID",
        message,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::domain::projects::publication_release::plan::Plan;

    #[test]
    fn generated_documents_pass_shared_registry_validators() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/managed_provider_index/v1/valid.json"
        ))
        .unwrap();
        let mut package = fixture["signed"]["packages"][0].clone();
        package["agent"]["repository"] = json!("https://github.com/acme/provider");
        package["agent"]["license"] = json!("MIT");
        package["agent"]["x-author-note"] = json!({"preserved":true});
        let target = package["agent"]["distribution"]["binary"]["linux-x86_64"].clone();
        package["agent"]["distribution"] = json!({"binary":{"linux-x86_64":target}});
        package["agent"]["distribution"]["binary"]["linux-x86_64"]["archive"] =
            json!("https://github.com/acme/provider/releases/download/v1.2.3/provider.tgz");
        let metadata = serde_json::to_vec_pretty(&package).unwrap();
        let archive = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(archive.path(), b"x").unwrap();
        let local = LocalRelease {
            plan: Plan {
                project_id: 1,
                plugin_id: "acme-agent".into(),
                version: "1.2.3".into(),
                prerelease: false,
                bundle_id: "00000000-0000-4000-8000-000000000000".into(),
                repository: "acme/provider".into(),
                tag: "v1.2.3".into(),
                source_commit: "a".repeat(40),
                target: "linux-x86_64".into(),
                archive_name: "provider.tgz".into(),
                archive_sha256: package["agent"]["distribution"]["binary"]["linux-x86_64"]
                    ["sha256"]
                    .as_str()
                    .unwrap()
                    .into(),
                archive_size: 1,
                metadata_sha256: "b".repeat(64),
                archives: Vec::new(),
                release_notes: "Changes".into(),
            },
            declared_metadata: package.clone(),
            declared_targets: vec!["linux-x86_64".into()],
            additional_archives: Vec::new(),
            archive_file: crate::domain::projects::publication_release::remote::ArchiveFile::open(
                archive.path(),
                1,
            )
            .unwrap(),
            metadata: metadata.into(),
        };
        let documents = build(&local, "author").unwrap();
        let generated: Value = serde_json::from_slice(&documents.submission).unwrap();
        assert_eq!(
            generated["package"]["agent"]["x-author-note"],
            json!({"preserved":true})
        );
        let root = tempfile::tempdir().unwrap();
        cadencr_registry_core::validate_submission(&generated).unwrap();

        let base = root.path().join("base");
        let candidate = root.path().join("candidate");
        std::fs::create_dir_all(base.join("packages")).unwrap();
        std::fs::create_dir_all(candidate.join("packages")).unwrap();
        std::fs::create_dir_all(candidate.join("submissions")).unwrap();
        std::fs::write(
            candidate.join("packages").join(&documents.filename),
            &documents.package,
        )
        .unwrap();
        std::fs::write(
            candidate.join("submissions").join(&documents.filename),
            &documents.submission,
        )
        .unwrap();
        cadencr_registry_core::validate_contribution(&base, &candidate).unwrap();

        // A separately valid submission must still describe the exact paired package.
        let mut mismatched = generated.clone();
        mismatched["package"]["agent"]["x-author-note"] = json!({"preserved":false});
        cadencr_registry_core::validate_submission(&mismatched).unwrap();
        std::fs::write(
            candidate.join("submissions").join(&documents.filename),
            serde_json::to_vec(&mismatched).unwrap(),
        )
        .unwrap();
        let error = cadencr_registry_core::validate_contribution(&base, &candidate).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("submission.package must exactly match"),
            "{error}"
        );
    }
}
