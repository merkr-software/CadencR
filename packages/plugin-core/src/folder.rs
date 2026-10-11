use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::{DescriptorError, PluginValidationError, ProviderDescriptor, RejectionCode};

const MAX_DESCRIPTOR_BYTES: u64 = 1024 * 1024;
const MAX_MARKER_BYTES: u64 = 1024;
const WORKSPACE_MARKER: &str = ".cadencr-provider-workspace";

#[derive(Debug, Clone)]
pub struct ValidatedPluginFolder {
    pub folder: PathBuf,
    pub descriptor_path: PathBuf,
    pub provider_id: String,
    pub descriptor: ProviderDescriptor,
    pub executable_path: PathBuf,
}

/// Validate the existing local provider-workspace contract without executing it.
///
/// `descriptor_path` is explicit because the host descriptor normally lives in
/// Cadencr's settings directory, outside the provider source folder. A missing
/// workspace marker is accepted for imported repositories; if present, it must
/// match the descriptor identity. This is local structural validation, not a
/// publication, trust, conformance, or theme check.
pub fn validate_plugin_folder(
    folder: &Path,
    descriptor_path: &Path,
) -> Result<ValidatedPluginFolder, PluginValidationError> {
    let folder = std::fs::canonicalize(folder).map_err(|source| {
        PluginValidationError::WorkspaceUnreadable {
            path: folder.to_path_buf(),
            source,
        }
    })?;
    if !folder.is_dir() {
        return Err(PluginValidationError::WorkspaceUnreadable {
            path: folder,
            source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a directory"),
        });
    }

    let descriptor = read_descriptor(descriptor_path)?;
    descriptor
        .validate()
        .map_err(PluginValidationError::DescriptorInvalid)?;
    validate_descriptor_filename(descriptor_path, &descriptor.agent.id)?;
    validate_marker(&folder, &descriptor.agent.id)?;

    let executable_path = folder.join("bin").join(if cfg!(windows) {
        "provider.exe"
    } else {
        "provider"
    });
    let command = descriptor
        .installation
        .executable
        .as_ref()
        .map(|value| Path::new(&value.command));
    if command != Some(executable_path.as_path()) {
        return Err(PluginValidationError::ExecutableBindingMismatch {
            expected: executable_path,
        });
    }
    validate_executable(&folder, &executable_path)?;

    Ok(ValidatedPluginFolder {
        folder,
        descriptor_path: descriptor_path.to_path_buf(),
        provider_id: descriptor.agent.id.clone(),
        descriptor,
        executable_path,
    })
}

fn read_descriptor(path: &Path) -> Result<ProviderDescriptor, PluginValidationError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| {
        PluginValidationError::DescriptorUnreadable {
            path: path.to_path_buf(),
            source,
        }
    })?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err(PluginValidationError::DescriptorNotRegular {
            path: path.to_path_buf(),
        });
    }
    let bytes = read_limited(path, MAX_DESCRIPTOR_BYTES).map_err(|source| {
        PluginValidationError::DescriptorUnreadable {
            path: path.to_path_buf(),
            source,
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        if error.is_data() {
            PluginValidationError::DescriptorInvalid(DescriptorError::new(
                RejectionCode::DescriptorSchemaViolation,
                format!("could not parse descriptor: {error}"),
            ))
        } else {
            PluginValidationError::DescriptorInvalidJson(error)
        }
    })
}

fn validate_descriptor_filename(
    path: &Path,
    provider_id: &str,
) -> Result<(), PluginValidationError> {
    let expected = format!("{provider_id}.json");
    if path.file_name().and_then(|name| name.to_str()) == Some(expected.as_str()) {
        Ok(())
    } else {
        Err(PluginValidationError::DescriptorIdentityMismatch { expected })
    }
}

fn validate_marker(folder: &Path, provider_id: &str) -> Result<(), PluginValidationError> {
    let path = folder.join(WORKSPACE_MARKER);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(PluginValidationError::MarkerUnreadable(error)),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_MARKER_BYTES {
        return Err(PluginValidationError::MarkerNotRegular);
    }
    let marker =
        read_limited(&path, MAX_MARKER_BYTES).map_err(PluginValidationError::MarkerUnreadable)?;
    if String::from_utf8_lossy(&marker).trim() != provider_id {
        return Err(PluginValidationError::WorkspaceIdentityMismatch {
            provider_id: provider_id.to_owned(),
        });
    }
    Ok(())
}

fn validate_executable(folder: &Path, path: &Path) -> Result<(), PluginValidationError> {
    let resolved =
        std::fs::canonicalize(path).map_err(|error| PluginValidationError::ExecutableInvalid {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
    if !resolved.starts_with(folder) || !resolved.is_file() {
        return Err(PluginValidationError::ExecutableInvalid {
            path: path.to_path_buf(),
            detail: "must be a regular file contained in the provider workspace".into(),
        });
    }
    if !executable_mode(&resolved) {
        return Err(PluginValidationError::ExecutableNotExecutable { path: resolved });
    }
    Ok(())
}

fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    File::open(path)?.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file exceeds inspection limit",
        ));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn executable_mode(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable_mode(_path: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{validate_plugin_folder, WORKSPACE_MARKER};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn validates_external_descriptor_bound_to_workspace_without_executing_provider() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("workspace");
        std::fs::create_dir_all(folder.join("bin")).unwrap();
        let folder = folder.canonicalize().unwrap();
        let executable = folder.join(if cfg!(windows) {
            "bin/provider.exe"
        } else {
            "bin/provider"
        });
        std::fs::write(&executable, "must never be run").unwrap();
        make_executable(&executable);
        std::fs::write(folder.join(WORKSPACE_MARKER), "acme\n").unwrap();
        let descriptor = temp.path().join("acme.json");
        write_descriptor(&descriptor, &executable);

        let validated = validate_plugin_folder(&folder, &descriptor).unwrap();
        assert_eq!(validated.provider_id, "acme");
        assert_eq!(validated.executable_path, executable);
    }

    #[test]
    fn imported_workspace_may_omit_marker_but_binding_is_exact() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("workspace");
        std::fs::create_dir_all(folder.join("bin")).unwrap();
        let folder = folder.canonicalize().unwrap();
        let executable = folder.join(if cfg!(windows) {
            "bin/provider.exe"
        } else {
            "bin/provider"
        });
        std::fs::write(&executable, "provider").unwrap();
        make_executable(&executable);
        let descriptor = temp.path().join("acme.json");
        write_descriptor(&descriptor, Path::new("/wrong/provider"));

        let error = validate_plugin_folder(&folder, &descriptor).unwrap_err();
        assert_eq!(error.code(), "INVALID_EXECUTABLE_PATH");
    }

    #[test]
    fn malformed_json_and_wrong_shapes_keep_distinct_codes() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().canonicalize().unwrap();
        let descriptor = temp.path().join("acme.json");

        std::fs::write(&descriptor, "{").unwrap();
        assert_eq!(
            validate_plugin_folder(&folder, &descriptor)
                .unwrap_err()
                .code(),
            "DESCRIPTOR_INVALID_JSON"
        );
        std::fs::write(&descriptor, "{}").unwrap();
        assert_eq!(
            validate_plugin_folder(&folder, &descriptor)
                .unwrap_err()
                .code(),
            "DESCRIPTOR_SCHEMA_VIOLATION"
        );
    }

    fn write_descriptor(path: &Path, command: &Path) {
        std::fs::write(
            path,
            serde_json::to_vec(&json!({
                "schema_version": 1,
                "agent": {
                    "id": "acme",
                    "name": "Acme",
                    "version": "1.0.0",
                    "description": "ACP provider"
                },
                "installation": { "executable": { "command": command } }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}
}
