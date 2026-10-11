use super::{fail, pass, warning};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
use crate::domain::agents::providers::installed::lifecycle;
use crate::domain::projects::models::PublicationReadinessCheck as Check;

const MAX_DESCRIPTOR_BYTES: u64 = 1024 * 1024;

pub(super) fn checks(root: &Path, plugin_id: &str, descriptor_dir: &Path) -> Vec<Check> {
    let descriptor = read_descriptor(descriptor_dir, plugin_id);
    let mut result = vec![
        marker_check(root, plugin_id),
        descriptor_check(&descriptor, plugin_id, root),
    ];
    result.extend(portable_metadata_checks(&descriptor));
    result.extend(asset_checks(root));
    result.push(executable_check(root));
    result
}

fn read_descriptor(directory: &Path, plugin_id: &str) -> Result<ProviderDescriptor, String> {
    let path =
        lifecycle::descriptor_path(directory, plugin_id).map_err(|error| error.to_string())?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("cannot read host descriptor: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_DESCRIPTOR_BYTES {
        return Err("host descriptor must be a regular file no larger than 1 MiB".into());
    }
    let bytes = read_limited(&path, MAX_DESCRIPTOR_BYTES, "host descriptor")?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid host descriptor JSON: {error}"))
}

fn marker_check(root: &Path, plugin_id: &str) -> Check {
    match bounded_regular_file(root, ".cadencr-provider-workspace", 1024) {
        Ok(bytes) if String::from_utf8_lossy(&bytes).trim() == plugin_id => pass(
            "workspace_identity",
            "Workspace identity",
            "Workspace marker matches the project's stable provider id.",
        ),
        Ok(_) => fail(
            "workspace_identity",
            "Workspace identity",
            "Workspace marker does not match the project's provider id.",
        ),
        Err(detail) => warning(
            "workspace_identity",
            "Workspace identity",
            &format!("Imported workspaces may omit the scaffold marker. {detail}"),
        ),
    }
}

fn descriptor_check(
    descriptor: &Result<ProviderDescriptor, String>,
    plugin_id: &str,
    root: &Path,
) -> Check {
    let result: Result<(), String> = descriptor.as_ref().map_err(Clone::clone).and_then(|value| {
        value.validate().map_err(|error| error.message)?;
        if value.agent.id != plugin_id {
            return Err("host descriptor id does not match the project provider id".into());
        }
        let expected = root.join("bin").join(if cfg!(windows) {
            "provider.exe"
        } else {
            "provider"
        });
        let command = value
            .installation
            .executable
            .as_ref()
            .map(|item| Path::new(&item.command));
        (command == Some(expected.as_path()))
            .then_some(())
            .ok_or_else(|| {
                "host descriptor executable does not match the stable workspace build output".into()
            })
    });
    match result {
        Ok(()) => pass(
            "host_descriptor",
            "Host descriptor",
            "Host descriptor is valid and bound to this workspace.",
        ),
        Err(detail) => fail("host_descriptor", "Host descriptor", &detail),
    }
}

fn portable_metadata_checks(descriptor: &Result<ProviderDescriptor, String>) -> Vec<Check> {
    let Ok(descriptor) = descriptor else {
        return Vec::new();
    };
    let agent = &descriptor.agent;
    vec![
        optional_metadata("repository", "Source repository", agent.repository.as_deref(), "Source repository metadata is not present in the local descriptor; final package metadata is inspected separately."),
        optional_metadata("license_metadata", "License metadata", agent.license.as_deref(), "License metadata is not present in the local descriptor; final package metadata is inspected separately."),
        match &agent.distribution {
            Some(distribution) if agent.validate_registry_entry().is_ok() && distribution.binary.is_some() => pass("distribution", "Binary distribution", "Portable descriptor declares valid binary release metadata."),
            _ => warning("distribution", "Binary distribution", "Managed package metadata is separate from the local host descriptor and was not inspected. Publication requires validated archives and checksums."),
        },
    ]
}

fn asset_checks(root: &Path) -> Vec<Check> {
    [
        ("readme", "README", "README.md"),
        ("license_file", "License file", "LICENSE"),
        ("icon", "Provider icon", "icon.svg"),
    ]
    .into_iter()
    .map(
        |(id, label, relative)| match contained_regular_metadata(root, relative) {
            Ok(metadata) if metadata.len() > 0 => pass(
                id,
                label,
                &format!("{relative} is present as a regular project file."),
            ),
            Ok(_) => warning(
                id,
                label,
                &format!("{relative} is empty; final staged assets were not inspected."),
            ),
            Err(detail) => warning(
                id,
                label,
                &format!("{detail} Final staged assets were not inspected."),
            ),
        },
    )
    .collect()
}

fn executable_check(root: &Path) -> Check {
    let relative = if cfg!(windows) {
        "bin/provider.exe"
    } else {
        "bin/provider"
    };
    match contained_regular_path(root, relative) {
        Ok(path) if executable_mode(&path) => pass(
            "executable",
            "Provider executable",
            "Stable provider build output exists and is executable.",
        ),
        Ok(_) => fail(
            "executable",
            "Provider executable",
            "Stable provider build output is not executable.",
        ),
        Err(detail) => fail("executable", "Provider executable", &detail),
    }
}

fn bounded_regular_file(root: &Path, relative: &str, max: u64) -> Result<Vec<u8>, String> {
    read_limited(&contained_regular_path(root, relative)?, max, relative)
}

fn read_limited(path: &Path, max: u64, label: &str) -> Result<Vec<u8>, String> {
    let file =
        std::fs::File::open(path).map_err(|error| format!("cannot read {label}: {error}"))?;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read {label}: {error}"))?;
    if bytes.len() as u64 > max {
        return Err(format!("{label} exceeds the local inspection limit."));
    }
    Ok(bytes)
}

fn contained_regular_metadata(root: &Path, relative: &str) -> Result<std::fs::Metadata, String> {
    std::fs::metadata(contained_regular_path(root, relative)?)
        .map_err(|error| format!("cannot inspect {relative}: {error}"))
}

fn contained_regular_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("{relative} is missing or unreadable: {error}"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(format!(
            "{relative} must be a regular file contained in the project."
        ));
    }
    Ok(path)
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

fn optional_metadata(id: &str, label: &str, value: Option<&str>, missing: &str) -> Check {
    if value.is_some_and(|value| !value.trim().is_empty()) {
        pass(id, label, "Portable metadata is present.")
    } else {
        warning(id, label, missing)
    }
}
#[cfg(test)]
mod tests {
    use super::{bounded_regular_file, descriptor_check, marker_check};
    use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
    use crate::domain::projects::models::PublicationCheckStatus as Status;
    use std::path::Path;

    #[test]
    fn matching_marker_passes_and_missing_import_marker_only_warns() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        assert_eq!(marker_check(&root, "acme").status, Status::Warning);
        std::fs::write(root.join(".cadencr-provider-workspace"), "acme\n").unwrap();
        assert_eq!(marker_check(&root, "acme").status, Status::Pass);
        assert_eq!(marker_check(&root, "other").status, Status::Fail);
    }

    #[test]
    fn bounded_files_must_stay_inside_project() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        std::fs::write(root.join("README.md"), "ok").unwrap();
        assert_eq!(bounded_regular_file(&root, "README.md", 2).unwrap(), b"ok");
        assert!(bounded_regular_file(&root, "README.md", 1).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", root.join("LICENSE")).unwrap();
            assert!(bounded_regular_file(&root, "LICENSE", 1024 * 1024).is_err());
        }
    }

    #[test]
    fn descriptor_binding_rejects_bad_identity_and_executable() {
        let root = Path::new("/tmp/acme");
        let make = |id: &str, command: &str| -> ProviderDescriptor {
            serde_json::from_value(serde_json::json!({
            "schema_version": 1, "agent": { "id": id, "name": "Acme", "version": "1.0.0", "description": "ACP" },
            "installation": { "executable": { "command": command } }
        })).unwrap()
        };
        assert_eq!(
            descriptor_check(&Err("bad JSON".into()), "acme", root).status,
            Status::Fail
        );
        assert_eq!(
            descriptor_check(&Ok(make("other", "/tmp/acme/bin/provider")), "acme", root).status,
            Status::Fail
        );
        assert_eq!(
            descriptor_check(&Ok(make("acme", "/tmp/wrong")), "acme", root).status,
            Status::Fail
        );
        assert_eq!(
            descriptor_check(&Ok(make("acme", "/tmp/acme/bin/provider")), "acme", root).status,
            Status::Pass
        );
    }
}
