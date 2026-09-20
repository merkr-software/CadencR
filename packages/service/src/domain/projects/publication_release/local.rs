use std::io::Read as _;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use sha2::{Digest as _, Sha256};

use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::error::AppError;

use super::{Plan, MAX_ARCHIVE_BYTES, MAX_METADATA_BYTES};

pub(super) mod git;

pub(super) struct LocalRelease {
    pub plan: Plan,
    pub archive: axum::body::Bytes,
    pub metadata: axum::body::Bytes,
}

pub(super) fn load(
    project_id: i64,
    plugin_id: String,
    output_root: PathBuf,
    bundle_id: &str,
    release_notes: String,
) -> Result<LocalRelease, AppError> {
    if release_notes.contains('\0') {
        return Err(invalid("release notes contain a NUL character"));
    }
    let bundle = resolve_bundle(&output_root, project_id, bundle_id)?;
    let archive_path = bundle.join("provider.tar.gz");
    let metadata_path = bundle.join("package.json");
    let archive = read_regular(&archive_path, MAX_ARCHIVE_BYTES, "archive")?;
    let metadata = read_regular(&metadata_path, MAX_METADATA_BYTES, "metadata")?;
    let package: ManagedProviderPackage = serde_json::from_slice(&metadata)
        .map_err(|error| invalid(format!("invalid package metadata: {error}")))?;
    package
        .validate_contract()
        .map_err(|error| invalid(format!("invalid package metadata contract: {error}")))?;
    if package.agent.id != plugin_id {
        return Err(invalid(
            "package agent id does not match the project plugin id",
        ));
    }
    let (target, artifact) = single_target(&package)?;
    let repository = parse_repository(package.agent.repository.as_deref())?;
    let (tag, archive_name) = validate_archive_url(&artifact.archive, &repository)?;
    let archive_sha256 = digest(&archive);
    if artifact.sha256.as_deref() != Some(archive_sha256.as_str()) {
        return Err(invalid(
            "archive content does not match package metadata sha256",
        ));
    }
    let version = semver::Version::parse(&package.agent.version)
        .map_err(|error| invalid(format!("package version is not semantic: {error}")))?;
    Ok(LocalRelease {
        plan: Plan {
            project_id,
            plugin_id,
            prerelease: !version.pre.is_empty(),
            version: package.agent.version,
            bundle_id: bundle_id.into(),
            repository,
            tag,
            source_commit: String::new(),
            target,
            archive_name,
            archive_sha256,
            archive_size: archive.len() as u64,
            metadata_sha256: digest(&metadata),
            release_notes,
        },
        archive: archive.into(),
        metadata: metadata.into(),
    })
}

fn resolve_bundle(output_root: &Path, project_id: i64, raw: &str) -> Result<PathBuf, AppError> {
    let id = uuid::Uuid::parse_str(raw).map_err(|_| invalid("bundle_id must be a UUID"))?;
    if id.to_string() != raw {
        return Err(invalid("bundle_id must use canonical lowercase UUID form"));
    }
    let root_info = std::fs::symlink_metadata(output_root)
        .map_err(|error| invalid(format!("cannot inspect publication bundle root: {error}")))?;
    if root_info.file_type().is_symlink() || !root_info.is_dir() {
        return Err(invalid("publication bundle root must be a real directory"));
    }
    let parent = output_root.join(project_id.to_string());
    let parent_info = std::fs::symlink_metadata(&parent)
        .map_err(|error| invalid(format!("cannot inspect project bundle directory: {error}")))?;
    if parent_info.file_type().is_symlink() || !parent_info.is_dir() {
        return Err(invalid("project bundle directory must be a real directory"));
    }
    let requested = parent.join(raw);
    let kind = std::fs::symlink_metadata(&requested)
        .map_err(|_| invalid("publication bundle does not exist"))?;
    if kind.file_type().is_symlink() || !kind.is_dir() {
        return Err(invalid("publication bundle must be a real directory"));
    }
    let canonical_parent = std::fs::canonicalize(&parent)
        .map_err(|error| invalid(format!("cannot resolve bundle parent: {error}")))?;
    let canonical = std::fs::canonicalize(requested)
        .map_err(|error| invalid(format!("cannot resolve publication bundle: {error}")))?;
    if canonical.parent() != Some(canonical_parent.as_path()) {
        return Err(invalid(
            "publication bundle escapes its server-owned directory",
        ));
    }
    Ok(canonical)
}

fn read_regular(path: &Path, limit: u64, label: &str) -> Result<Vec<u8>, AppError> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|error| invalid(format!("cannot inspect {label}: {error}")))?;
    if before.file_type().is_symlink() || !before.is_file() || before.len() > limit {
        return Err(invalid(format!("{label} must be a bounded regular file")));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| invalid(format!("cannot securely open {label}: {error}")))?;
    let info = file
        .metadata()
        .map_err(|error| invalid(format!("cannot inspect open {label}: {error}")))?;
    if !info.is_file() || info.len() > limit {
        return Err(invalid(format!("{label} must be a bounded regular file")));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if before.dev() != info.dev() || before.ino() != info.ino() {
            return Err(invalid(format!(
                "{label} changed while it was being opened"
            )));
        }
    }
    let mut bytes = Vec::with_capacity((info.len().min(limit)) as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| invalid(format!("cannot read {label}: {error}")))?;
    if bytes.len() as u64 > limit {
        return Err(invalid(format!("{label} exceeds its size limit")));
    }
    Ok(bytes)
}

fn single_target(
    package: &ManagedProviderPackage,
) -> Result<
    (
        String,
        &crate::domain::agents::providers::installed::descriptor::AcpBinaryTarget,
    ),
    AppError,
> {
    let binary = package
        .agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.binary.as_ref())
        .ok_or_else(|| invalid("package must declare a binary distribution"))?;
    if binary.len() != 1 {
        return Err(invalid("package must declare exactly one binary target"));
    }
    binary
        .iter()
        .next()
        .map(|(target, artifact)| (target.clone(), artifact))
        .ok_or_else(|| invalid("package binary target is missing"))
}

fn parse_repository(raw: Option<&str>) -> Result<String, AppError> {
    let raw = raw.ok_or_else(|| invalid("package repository is required"))?;
    validate_text("repository", raw)?;
    let url = reqwest::Url::parse(raw).map_err(|_| invalid("repository must be a URL"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "repository must be an exact public github.com HTTPS URL",
        ));
    }
    let path = url.path().trim_matches('/');
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|value| invalid_segment(value))
        || raw != format!("https://github.com/{}/{}", parts[0], parts[1])
        || raw.contains('%')
    {
        return Err(invalid(
            "repository must identify one GitHub owner/repository",
        ));
    }
    Ok(format!("{}/{}", parts[0], parts[1]))
}

fn validate_archive_url(raw: &str, repository: &str) -> Result<(String, String), AppError> {
    validate_text("archive URL", raw)?;
    let url = reqwest::Url::parse(raw).map_err(|_| invalid("archive URL is invalid"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw.to_ascii_lowercase().contains("%2f")
    {
        return Err(invalid(
            "archive URL must be an exact public github.com release URL",
        ));
    }
    let prefix = format!("/{repository}/releases/download/");
    let remainder = url
        .path()
        .strip_prefix(&prefix)
        .ok_or_else(|| invalid("archive URL does not match package repository"))?;
    let (tag, name) = remainder
        .split_once('/')
        .filter(|(tag, name)| !tag.is_empty() && !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| invalid("archive URL must contain exactly one tag and asset name"))?;
    let lower = name.to_ascii_lowercase();
    if name.len() > 128
        || name.eq_ignore_ascii_case("package.json")
        || (!lower.ends_with(".tar.gz") && !lower.ends_with(".tgz"))
        || invalid_segment(name)
        || invalid_segment(tag)
    {
        return Err(invalid("release asset name or tag is invalid"));
    }
    Ok((tag.to_string(), name.to_string()))
}

fn validate_text(label: &str, value: &str) -> Result<(), AppError> {
    if value.chars().any(char::is_control) {
        return Err(invalid(format!("{label} contains control characters")));
    }
    Ok(())
}

fn invalid_segment(value: &str) -> bool {
    value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::coded(
        StatusCode::BAD_REQUEST,
        "PUBLICATION_RELEASE_INVALID",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_a_server_owned_bundle_into_an_immutable_release_plan() {
        let fixture = tempfile::tempdir().unwrap();
        let output = fixture.path().join("bundles");
        let id = "00000000-0000-4000-8000-000000000000";
        let bundle = output.join("1").join(id);
        std::fs::create_dir_all(&bundle).unwrap();
        let archive = b"bounded archive bytes";
        let sha = digest(archive);
        std::fs::write(bundle.join("provider.tar.gz"), archive).unwrap();
        let metadata = serde_json::json!({
            "agent": {"id":"acme","name":"Acme","version":"1.2.3-beta.1","description":"ACP",
                "repository":"https://github.com/acme/provider",
                "distribution":{"binary":{"linux-x86_64":{"archive":"https://github.com/acme/provider/releases/download/v1.2.3-beta.1/acme-linux.tgz","cmd":"bin/acme","sha256":sha}}}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"},"assets":{"icon":"icon.svg"}}
        });
        std::fs::write(
            bundle.join("package.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        let loaded = load(1, "acme".into(), output, id, "line one\nline two".into()).unwrap();
        assert_eq!(loaded.plan.archive_name, "acme-linux.tgz");
        assert_eq!(loaded.plan.tag, "v1.2.3-beta.1");
        assert!(loaded.plan.prerelease);
        assert_eq!(loaded.archive.as_ref(), archive.as_slice());
    }

    #[test]
    fn repository_and_archive_urls_reject_unsafe_or_mismatched_inputs() {
        assert!(parse_repository(Some("https://user@github.com/acme/provider")).is_err());
        assert!(parse_repository(Some("https://github.com/acme/provider?token=x")).is_err());
        assert!(validate_archive_url(
            "https://github.com/acme/provider/releases/download/v1/acme-v1.tgz",
            "acme/provider"
        )
        .is_ok());
        assert!(validate_archive_url(
            "https://github.com/acme/provider/releases/download/v1/package.json",
            "acme/provider"
        )
        .is_err());
        assert!(validate_archive_url(
            "https://github.com/acme/other/releases/download/v1/acme.tgz",
            "acme/provider"
        )
        .is_err());
    }
}
