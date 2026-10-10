use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::path::{Component, Path, PathBuf};

use super::{state, Entry, PipelineRequest, PreparedPipeline};
use crate::PublisherError;

pub(super) const INPUT_LIMIT: u64 = 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) schema_version: u64,
    pub(super) repository: String,
    pub(super) key_id: String,
    pub(super) discovery_branch: String,
    pub(super) generated_at: String,
    pub(super) expires_at: String,
    pub(super) previous_index: String,
    pub(super) public_key: String,
    publications: Vec<Publication>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    submission: String,
    #[serde(
        default,
        deserialize_with = "present_registry_commit",
        skip_serializing_if = "Option::is_none"
    )]
    registry_commit: Option<String>,
}

// Missing is optional; a present field must be a string, never JSON null.
fn present_registry_commit<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

pub(super) fn prepare(input: PipelineRequest<'_>) -> Result<PreparedPipeline, PublisherError> {
    crate::validate_registry_commit(input.registry_commit)?;
    if !cadencr_registry_core::valid_publication_repository(input.repository) {
        return Err(PublisherError::new("repository is invalid"));
    }
    let bytes = crate::fs::read_bounded(input.request, INPUT_LIMIT, "publication request")?;
    if input.confirm_request_sha256.len() != 64
        || crate::hex(&Sha256::digest(&bytes)) != input.confirm_request_sha256
    {
        return Err(PublisherError::new(
            "publication request SHA-256 confirmation does not match",
        ));
    }
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new("pipeline input must be valid JSON"))?;
    let request: Request = serde_json::from_value(value.clone())
        .map_err(|_| PublisherError::new("publication request schema is invalid"))?;
    validate_request(&request, input.repository)?;
    let request_file = absolute(input.request)?;
    let base = request_file
        .parent()
        .ok_or_else(|| PublisherError::new("request has no parent"))?;
    state::inspect_directory(base, true)?;
    let public_key = trusted_file(base, &request.public_key, 16 * 1024, "public key")?;
    let previous = if request.previous_index == "bootstrap" {
        None
    } else {
        Some(trusted_file(
            base,
            &request.previous_index,
            INPUT_LIMIT,
            "previous index",
        )?)
    };
    let directory = absolute(input.directory)?;
    state::inspect_directory(&directory, false)?;
    let mut entries = Vec::new();
    let mut aggregate = 0_u64;
    for (index, publication) in request.publications.iter().enumerate() {
        let bytes = trusted_file(base, &publication.submission, INPUT_LIMIT, "submission")?;
        aggregate += bytes.len() as u64;
        if aggregate > 32 * INPUT_LIMIT {
            return Err(PublisherError::new("submission inputs exceed 32 MiB"));
        }
        let submission = cadencr_registry_core::parse_json_bytes(&bytes)
            .map_err(|_| PublisherError::new("pipeline input must be valid JSON"))?;
        let plan = cadencr_registry_core::create_publication_plan(&submission, input.repository)?;
        entries.push(Entry {
            submission,
            bytes,
            plan,
            registry_commit: publication
                .registry_commit
                .clone()
                .unwrap_or_else(|| input.registry_commit.into()),
            directory: directory
                .join("publications")
                .join(format!("{:03}", index + 1)),
            require_published: false,
        });
    }
    let private_key = std::fs::canonicalize(input.private_key)
        .map_err(|e| PublisherError::io("resolve private key", e))?;
    if private_key.starts_with(&directory) {
        return Err(PublisherError::new(
            "private key must be outside pipeline state directory",
        ));
    }
    let mut prepared = PreparedPipeline {
        request,
        directory,
        private_key,
        public_key,
        previous,
        entries,
        registry_commit: input.registry_commit.into(),
        binding: json!({"schema_version":1,
            "request_sha256":input.confirm_request_sha256,"repository":input.repository,
            "registry_commit":input.registry_commit,"request":value}),
    };
    let required = validate_catalog(&prepared)?;
    for entry in &mut prepared.entries {
        entry.require_published = required.contains(&identity(&entry.plan["mirrored_package"]));
    }
    state::preflight(&prepared)?;
    Ok(prepared)
}

pub(super) fn revalidate(prepared: &PreparedPipeline) -> Result<(), PublisherError> {
    state::inspect_directory(&prepared.directory, false)?;
    if prepared.private_key.starts_with(&prepared.directory) {
        return Err(PublisherError::new(
            "private key must be outside pipeline state directory",
        ));
    }
    validate_catalog(prepared)?;
    state::preflight(prepared)
}

pub(super) fn validate_catalog(prepared: &PreparedPipeline) -> Result<Vec<String>, PublisherError> {
    let payload = cadencr_registry_core::prepare_publication_index()
        .packages(
            prepared
                .entries
                .iter()
                .map(|entry| entry.plan["mirrored_package"].clone())
                .collect(),
        )
        .generated_at(&prepared.request.generated_at)
        .expires_at(&prepared.request.expires_at)
        .call()?;
    cadencr_registry_core::preflight_publication_pipeline()
        .payload(&payload)
        .maybe_previous_bytes(prepared.previous.as_deref())
        .public_key_bytes(&prepared.public_key)
        .private_key_file(&prepared.private_key)
        .key_id(&prepared.request.key_id)
        .call()
        .map_err(Into::into)
}

fn validate_request(request: &Request, repository: &str) -> Result<(), PublisherError> {
    if request.schema_version != 1 || request.repository != repository {
        return Err(PublisherError::new(
            "request schema version or repository does not match",
        ));
    }
    cadencr_registry_core::validate_signing_key_id(&request.key_id)?;
    cadencr_registry_core::validate_discovery_branch(&request.discovery_branch)?;
    if request.publications.is_empty() || request.publications.len() > 100 {
        return Err(PublisherError::new(
            "request publications must contain between 1 and 100 entries",
        ));
    }
    relative(&request.public_key)?;
    if request.previous_index != "bootstrap" {
        relative(&request.previous_index)?;
    }
    for publication in &request.publications {
        relative(&publication.submission)?;
        if let Some(commit) = &publication.registry_commit {
            crate::validate_registry_commit(commit)?;
        }
    }
    Ok(())
}

fn relative(value: &str) -> Result<(), PublisherError> {
    if value.is_empty()
        || value.contains(['\0', '\\'])
        || Path::new(value).is_absolute()
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        Err(PublisherError::new(
            "request input must be a safe relative path",
        ))
    } else {
        Ok(())
    }
}

fn trusted_file(
    base: &Path,
    value: &str,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, PublisherError> {
    relative(value)?;
    let path = base.join(value);
    let mut cursor = base.to_path_buf();
    for part in Path::new(value).components() {
        cursor.push(part);
        let metadata = std::fs::symlink_metadata(&cursor)
            .map_err(|e| PublisherError::io("inspect request input", e))?;
        if metadata.file_type().is_symlink() {
            return Err(PublisherError::new(
                "request input path contains symbolic link",
            ));
        }
    }
    crate::fs::read_bounded(&path, limit, label)
}

pub(super) fn absolute(path: &Path) -> Result<PathBuf, PublisherError> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| PublisherError::io("resolve current directory", e))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    Ok(normalized)
}

fn identity(package: &Value) -> String {
    format!(
        "{}@{}",
        package["agent"]["id"].as_str().expect("validated id"),
        package["agent"]["version"]
            .as_str()
            .expect("validated version")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(publication: Value) -> Value {
        json!({"schema_version":1,"repository":"cadencr/registry","key_id":"test-key",
            "discovery_branch":"main","generated_at":"2026-10-10T00:00:00Z",
            "expires_at":"2026-10-11T00:00:00Z","previous_index":"bootstrap",
            "public_key":"public.pem","publications":[publication]})
    }

    #[test]
    fn publication_commit_accepts_omission_and_exact_lowercase_hex() {
        for publication in [
            json!({"submission":"submission.json"}),
            json!({"submission":"submission.json","registry_commit":"a".repeat(40)}),
        ] {
            let parsed: Request = serde_json::from_value(request(publication.clone())).unwrap();
            validate_request(&parsed, "cadencr/registry").unwrap();
            assert_eq!(
                serde_json::to_value(parsed).unwrap()["publications"][0],
                publication
            );
        }
    }

    #[test]
    fn publication_commit_rejects_null_wrong_types_and_unknown_fields() {
        for value in [Value::Null, json!(false), json!(40), json!([]), json!({})] {
            assert!(serde_json::from_value::<Request>(request(json!({
                "submission":"submission.json","registry_commit":value
            })))
            .is_err());
        }
        assert!(serde_json::from_value::<Request>(request(json!({
            "submission":"submission.json","unknown":true
        })))
        .is_err());
        let mut unknown = request(json!({"submission":"submission.json"}));
        unknown["unknown"] = json!(true);
        assert!(serde_json::from_value::<Request>(unknown).is_err());
    }

    #[test]
    fn publication_commit_rejects_non_exact_strings() {
        for value in [
            "a".repeat(39),
            "a".repeat(41),
            "A".repeat(40),
            "g".repeat(40),
        ] {
            let parsed: Request = serde_json::from_value(request(json!({
                "submission":"submission.json","registry_commit":value
            })))
            .unwrap();
            assert!(validate_request(&parsed, "cadencr/registry").is_err());
        }
    }
}
