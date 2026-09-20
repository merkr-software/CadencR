use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use super::BuiltArchive;
use crate::RegistryError;

/// Owns a private temporary inode beside the destination until the complete,
/// synced archive is ready to publish with create-new semantics.
pub(super) struct CreatedOutput {
    temporary: tempfile::NamedTempFile,
    destination: PathBuf,
}

impl CreatedOutput {
    pub(super) fn create(output: &Path) -> Result<Self, RegistryError> {
        let parent = output
            .parent()
            .filter(|value| !value.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent = std::fs::canonicalize(parent)
            .map_err(|error| bad(format!("cannot resolve archive output directory: {error}")))?;
        let name = output
            .file_name()
            .ok_or_else(|| bad("archive output must name a file"))?;
        let destination = parent.join(name);
        match std::fs::symlink_metadata(&destination) {
            Ok(_) => return Err(bad("cannot create package archive: output already exists")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        let temporary = tempfile::NamedTempFile::new_in(&parent).map_err(io_error)?;
        set_archive_permissions(temporary.as_file())?;
        Ok(Self {
            temporary,
            destination,
        })
    }

    pub(super) fn try_clone(&self) -> Result<File, RegistryError> {
        self.temporary.as_file().try_clone().map_err(io_error)
    }

    pub(super) fn publish(self, result: BuiltArchive) -> Result<BuiltArchive, RegistryError> {
        self.temporary
            .persist_noclobber(&self.destination)
            .map(|_| result)
            .map_err(|error| {
                bad(format!(
                    "cannot publish package archive without overwriting: {}",
                    error.error
                ))
            })
    }
}

#[cfg(unix)]
fn set_archive_permissions(file: &File) -> Result<(), RegistryError> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(std::fs::Permissions::from_mode(0o644))
        .map_err(io_error)
}

#[cfg(not(unix))]
fn set_archive_permissions(_file: &File) -> Result<(), RegistryError> {
    Ok(())
}

fn bad(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

fn io_error(error: io::Error) -> RegistryError {
    bad(format!("package archive I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result() -> BuiltArchive {
        BuiltArchive {
            sha256: "0".repeat(64),
            size: 0,
        }
    }

    #[test]
    fn failed_private_output_never_publishes_a_partial_destination() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("provider.tar.gz");
        let created = CreatedOutput::create(&path).unwrap();
        drop(created);
        assert!(!path.exists());
    }

    #[test]
    fn late_replacement_survives_no_clobber_publication_failure() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("provider.tar.gz");
        let created = CreatedOutput::create(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        assert!(created.publish(result()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"replacement");
    }
}
