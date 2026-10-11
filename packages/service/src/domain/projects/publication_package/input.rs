use std::path::{Path, PathBuf};

use crate::domain::agents::providers::installed::descriptor::ACP_BINARY_TARGETS;
use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::error::AppError;

use super::{PreparePublicationPackageRequest, MAX_METADATA_BYTES};

pub(super) struct PreparedInputs {
    pub project_id: i64,
    pub project_root: PathBuf,
    pub plugin_id: String,
    pub staging: PathBuf,
    pub target: String,
    pub package: ManagedProviderPackage,
    pub metadata: serde_json::Value,
    pub output_root: PathBuf,
    pub output_parent: PathBuf,
}

pub(super) fn prepare(
    project_id: i64,
    project_root: PathBuf,
    plugin_id: String,
    output_root: PathBuf,
    body: PreparePublicationPackageRequest,
) -> Result<PreparedInputs, AppError> {
    if body.metadata_json.len() > MAX_METADATA_BYTES {
        return Err(AppError::BadRequest(
            "publication metadata exceeds 64 KiB".into(),
        ));
    }
    let metadata: serde_json::Value = serde_json::from_str(&body.metadata_json)
        .map_err(|error| AppError::BadRequest(format!("invalid publication metadata: {error}")))?;
    let package: ManagedProviderPackage = serde_json::from_value(metadata.clone())
        .map_err(|error| AppError::BadRequest(format!("invalid publication metadata: {error}")))?;
    package.validate_contract().map_err(|error| {
        AppError::BadRequest(format!("invalid publication metadata contract: {error}"))
    })?;
    if package.agent.id != plugin_id {
        return Err(AppError::BadRequest(format!(
            "metadata agent id {:?} does not match project plugin id {plugin_id:?}",
            package.agent.id
        )));
    }
    validate_target(&package, &body.target)?;
    let staging = validate_staging(&body.staging_directory, &project_root)?;
    let output_parent =
        super::super::publication_storage::child_path(&output_root, &project_id.to_string())
            .map_err(|error| {
                AppError::Internal(format!("invalid publication bundle parent: {error}"))
            })?;
    reject_output_overlap(&output_parent, &staging, &project_root)?;
    Ok(PreparedInputs {
        project_id,
        project_root,
        plugin_id,
        staging,
        target: body.target,
        package,
        metadata,
        output_root,
        output_parent,
    })
}

fn validate_target(package: &ManagedProviderPackage, target: &str) -> Result<(), AppError> {
    if !ACP_BINARY_TARGETS.contains(&target) {
        return Err(AppError::BadRequest(format!(
            "unsupported publication target {target:?}"
        )));
    }
    let binary = package
        .agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.binary.as_ref())
        .ok_or_else(|| {
            AppError::BadRequest("metadata must declare a binary distribution".into())
        })?;
    if binary.len() != 1 {
        return Err(AppError::BadRequest(
            "E2 prepares one platform per bundle; metadata must declare exactly one binary target"
                .into(),
        ));
    }
    let selected = binary.get(target).ok_or_else(|| {
        AppError::BadRequest(format!(
            "metadata does not declare requested target {target:?}"
        ))
    })?;
    let archive_url = reqwest::Url::parse(&selected.archive).map_err(|error| {
        AppError::BadRequest(format!("invalid archive URL for requested target: {error}"))
    })?;
    let path = archive_url.path().to_ascii_lowercase();
    if !path.ends_with(".tar.gz") && !path.ends_with(".tgz") {
        return Err(AppError::BadRequest(
            "requested target archive URL must end in .tar.gz or .tgz".into(),
        ));
    }
    Ok(())
}

fn validate_staging(raw: &str, project: &Path) -> Result<PathBuf, AppError> {
    let requested = PathBuf::from(raw);
    if !requested.is_absolute() {
        return Err(AppError::BadRequest(
            "staging_directory must be absolute".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&requested).map_err(|error| {
        AppError::BadRequest(format!("cannot inspect staging_directory: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::BadRequest(
            "staging_directory must be a real directory, not a symlink".into(),
        ));
    }
    let staging = std::fs::canonicalize(&requested).map_err(|error| {
        AppError::BadRequest(format!("cannot resolve staging_directory: {error}"))
    })?;
    let home = dirs::home_dir().and_then(|path| std::fs::canonicalize(path).ok());
    if home.as_deref() == Some(staging.as_path())
        || staging.starts_with(project)
        || project.starts_with(&staging)
    {
        return Err(AppError::BadRequest(
            "staging_directory must be outside the project tree and must not be the home directory"
                .into(),
        ));
    }
    Ok(staging)
}

pub(super) fn reject_output_overlap(
    output: &Path,
    staging: &Path,
    project: &Path,
) -> Result<(), AppError> {
    let absolute = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| AppError::Internal(error.to_string()))?
            .join(output)
    };
    if absolute.starts_with(staging)
        || staging.starts_with(&absolute)
        || absolute.starts_with(project)
        || project.starts_with(&absolute)
    {
        return Err(AppError::BadRequest(
            "publication output directory overlaps staging or project directory".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(id: &str, targets: serde_json::Value) -> String {
        serde_json::json!({
            "agent": {"id": id, "name":"Acme", "version":"1.0.0", "description":"ACP",
                "distribution":{"binary":targets}},
            "host":{"publisher":"acme", "compatibility":{"min_app_version":"0.1.0"},
                "assets":{"icon":"icon.svg"}}
        })
        .to_string()
    }

    fn request(
        metadata_json: String,
        staging: &Path,
        target: &str,
    ) -> PreparePublicationPackageRequest {
        PreparePublicationPackageRequest {
            metadata_json,
            staging_directory: staging.display().to_string(),
            target: target.into(),
        }
    }

    #[test]
    fn validates_identity_target_count_and_archive_suffix() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let staging = root.path().join("staging");
        let output = root.path().join("output");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&staging).unwrap();
        let target = |archive: &str| serde_json::json!({"archive":archive,"cmd":"bin/acme","sha256":"0".repeat(64)});
        let call = |json, id: &str, target_name: &str| {
            prepare(
                1,
                project.canonicalize().unwrap(),
                id.into(),
                output.clone(),
                request(json, &staging, target_name),
            )
        };
        assert!(call("{".into(), "acme", "linux-x86_64").is_err());
        assert!(call(
            metadata(
                "wrong",
                serde_json::json!({"linux-x86_64":target("https://x/acme.tar.gz")})
            ),
            "acme",
            "linux-x86_64"
        )
        .is_err());
        assert!(call(metadata("acme", serde_json::json!({"linux-x86_64":target("https://x/a.tgz"),"darwin-aarch64":target("https://x/b.tgz")})), "acme", "linux-x86_64").is_err());
        assert!(call(
            metadata(
                "acme",
                serde_json::json!({"linux-x86_64":target("https://x/acme.zip")})
            ),
            "acme",
            "linux-x86_64"
        )
        .is_err());
        assert!(call(
            metadata(
                "acme",
                serde_json::json!({"linux-x86_64":target("https://x/acme.tgz")})
            ),
            "acme",
            "plan9-riscv"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_project_staging_and_symlink_roots() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let child = project.join("stage");
        let outside = root.path().join("outside");
        let link = root.path().join("link");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, &link).unwrap();
        assert!(
            validate_staging(child.to_str().unwrap(), &project.canonicalize().unwrap()).is_err()
        );
        assert!(
            validate_staging(link.to_str().unwrap(), &project.canonicalize().unwrap()).is_err()
        );
    }
}
