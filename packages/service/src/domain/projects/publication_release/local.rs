use std::io::Read as _;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use sha2::{Digest as _, Sha256};

use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::error::AppError;

use super::{Plan, MAX_ARCHIVE_BYTES, MAX_METADATA_BYTES};

mod candidate;
mod theme;
pub(super) use theme::validate_project_kind;
pub(crate) mod validation;
use validation::{parse_repository, single_target, validate_archive_url};
pub(super) mod git;
pub(super) use candidate::load_candidate;

pub(super) struct LocalRelease {
    pub plan: Plan,
    pub archive_file: super::remote::ArchiveFile,
    pub declared_metadata: serde_json::Value,
    pub declared_targets: Vec<String>,
    pub additional_archives: Vec<super::remote::GitHubArchive>,
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
    if bundle.join("theme.tar.gz").exists() {
        return theme::load(project_id, plugin_id, bundle, bundle_id, release_notes);
    }
    let archive_path = bundle.join("provider.tar.gz");
    let metadata_path = bundle.join("package.json");
    let archive_file = super::remote::ArchiveFile::open(&archive_path, MAX_ARCHIVE_BYTES)?;
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
    let binary = package
        .agent
        .distribution
        .as_ref()
        .and_then(|d| d.binary.as_ref())
        .ok_or_else(|| invalid("package binary distribution is missing"))?;
    let declared_targets = binary.keys().cloned().collect::<Vec<_>>();
    let (target, artifact) = selected_target(&bundle, &package)?;
    let repository = parse_repository(package.agent.repository.as_deref())?;
    let (tag, archive_name) = validate_archive_url(&artifact.archive, &repository)?;
    let archive_sha256 = archive_file.sha256.clone();
    if artifact.sha256.as_deref() != Some(archive_sha256.as_str()) {
        return Err(invalid(
            "archive content does not match package metadata sha256",
        ));
    }
    let version = semver::Version::parse(&package.agent.version)
        .map_err(|error| invalid(format!("package version is not semantic: {error}")))?;
    let mut selected_metadata: serde_json::Value = serde_json::from_slice(&metadata)
        .map_err(|error| invalid(format!("invalid metadata: {error}")))?;
    let declared_metadata = normalized_declaration(&selected_metadata)?;
    if binary.len() > 1 {
        selected_metadata["agent"]["distribution"]["binary"]
            .as_object_mut()
            .ok_or_else(|| invalid("binary target map missing"))?
            .retain(|key, _| key == &target);
    }
    let metadata = if binary.len() > 1 {
        serde_json::to_vec_pretty(&selected_metadata).map_err(|error| invalid(error.to_string()))?
    } else {
        metadata
    };
    Ok(LocalRelease {
        declared_metadata,
        declared_targets,
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
            archive_size: archive_file.size,
            metadata_sha256: digest(&metadata),
            archives: Vec::new(),
            release_notes,
        },
        additional_archives: Vec::new(),
        archive_file,
        metadata: metadata.into(),
    })
}

fn normalized_declaration(metadata: &serde_json::Value) -> Result<serde_json::Value, AppError> {
    let mut declaration = metadata.clone();
    let binary = declaration["agent"]["distribution"]["binary"]
        .as_object_mut()
        .ok_or_else(|| invalid("binary target map missing"))?;
    for artifact in binary.values_mut() {
        artifact
            .as_object_mut()
            .ok_or_else(|| invalid("binary artifact missing"))?
            .remove("sha256");
    }
    Ok(declaration)
}

fn selected_target<'a>(
    bundle: &Path,
    package: &'a ManagedProviderPackage,
) -> Result<
    (
        String,
        &'a crate::domain::agents::providers::installed::descriptor::AcpBinaryTarget,
    ),
    AppError,
> {
    let binary = package
        .agent
        .distribution
        .as_ref()
        .and_then(|d| d.binary.as_ref())
        .ok_or_else(|| invalid("package binary distribution is missing"))?;
    let selected_path = bundle.join("target.json");
    if selected_path.exists() {
        let selected: String =
            serde_json::from_slice(&read_regular(&selected_path, 256, "bundle target")?)
                .map_err(|error| invalid(format!("invalid bundle target: {error}")))?;
        let artifact = binary
            .get(&selected)
            .ok_or_else(|| invalid("bundle target is not declared"))?;
        Ok((selected, artifact))
    } else {
        single_target(package)
    }
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
    let canonical_root = std::fs::canonicalize(output_root)
        .map_err(|error| invalid(format!("cannot resolve publication bundle root: {error}")))?;
    let parent = crate::domain::projects::publication_storage::child_path(
        &canonical_root,
        &project_id.to_string(),
    )
    .map_err(|error| invalid(format!("invalid project bundle path: {error}")))?;
    let parent_info = std::fs::symlink_metadata(&parent)
        .map_err(|error| invalid(format!("cannot inspect project bundle directory: {error}")))?;
    if parent_info.file_type().is_symlink() || !parent_info.is_dir() {
        return Err(invalid("project bundle directory must be a real directory"));
    }
    let canonical_parent = std::fs::canonicalize(&parent)
        .map_err(|error| invalid(format!("cannot resolve bundle parent: {error}")))?;
    if canonical_parent.parent() != Some(canonical_root.as_path()) {
        return Err(invalid("project bundle directory escapes its storage root"));
    }
    let requested = crate::domain::projects::publication_storage::child_path(
        &canonical_parent,
        &id.to_string(),
    )
    .map_err(|error| invalid(format!("invalid publication bundle path: {error}")))?;
    let kind = std::fs::symlink_metadata(&requested)
        .map_err(|_| invalid("publication bundle does not exist"))?;
    if kind.file_type().is_symlink() || !kind.is_dir() {
        return Err(invalid("publication bundle must be a real directory"));
    }
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
        assert_eq!(loaded.archive_file.sha256, digest(archive));
    }

    #[test]
    fn rejects_path_like_and_noncanonical_bundle_ids() {
        let root = tempfile::tempdir().unwrap();
        for id in [
            "../outside",
            "/tmp/outside",
            r"C:\outside",
            r"..\outside",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
            "00000000000040008000000000000000",
        ] {
            assert!(resolve_bundle(root.path(), 1, id).is_err(), "accepted {id}");
        }
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_bundle_root_project_and_bundle_without_changes() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("sentinel");
        std::fs::write(&sentinel, b"keep").unwrap();
        let id = "00000000-0000-4000-8000-000000000000";
        let storage = root.path().join("custom-storage");
        symlink(outside.path(), &storage).unwrap();
        assert!(resolve_bundle(&storage, 1, id).is_err());
        std::fs::remove_file(&storage).unwrap();
        std::fs::create_dir(&storage).unwrap();
        let project = storage.join("1");
        symlink(outside.path(), &project).unwrap();
        assert!(resolve_bundle(&storage, 1, id).is_err());
        std::fs::remove_file(&project).unwrap();
        std::fs::create_dir(&project).unwrap();
        let bundle = project.join(id);
        symlink(outside.path(), &bundle).unwrap();
        assert!(resolve_bundle(&storage, 1, id).is_err());
        assert_eq!(std::fs::read(sentinel).unwrap(), b"keep");
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
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
