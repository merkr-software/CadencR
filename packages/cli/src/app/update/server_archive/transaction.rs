//! Update locking and replacement of a server installation.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt as _, FileExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use crate::app::install::{read_server_manifest, SERVER_MANIFEST};
use crate::{operation_error, Diagnostic};

const PREVIOUS: &str = "previous";
const WORKSPACE_PREFIX: &str = "workspace-";

pub(in super::super) struct ServerUpdate {
    root: PathBuf,
    state: PathBuf,
    lock: File,
    from_previous: bool,
}

impl ServerUpdate {
    pub(in super::super) fn detect() -> Result<Option<Self>, Diagnostic> {
        let executable = std::env::current_exe()
            .map_err(|error| operation_error("CLI_INSTALL_NOT_FOUND", error))?;
        Self::from_executable(&executable)
    }

    pub(super) fn from_executable(executable: &Path) -> Result<Option<Self>, Diagnostic> {
        let resolved = match fs::canonicalize(executable) {
            Ok(resolved) => resolved,
            // The stable lock is still reachable if the live directory just moved.
            Err(error) if error.kind() == ErrorKind::NotFound => executable.to_path_buf(),
            Err(error) => return Err(operation_error("CLI_INSTALL_NOT_FOUND", error)),
        };
        let Some(root) = resolved.parent().and_then(Path::parent) else {
            return Ok(None);
        };
        // Linux can report the moved executable under its new path.
        if let Some(origin) = backup_origin(root) {
            let state = state_dir(&origin)?;
            if let Some(lock) = open_lock(&state, false)? {
                if lock_matches(&lock, root)? {
                    return Self::claim(origin, state, lock, true).map(Some);
                }
            }
        }
        let manifest = manifest_path(root);
        let create = manifest
            .try_exists()
            .map_err(|error| file_error(&manifest, error))?;
        let state = state_dir(root)?;
        open_lock(&state, create)?
            .map(|lock| Self::claim(root.to_path_buf(), state, lock, false))
            .transpose()
    }

    pub(in super::super) fn begin(root: &Path) -> Result<Self, Diagnostic> {
        let state = state_dir(root)?;
        let lock = open_lock(&state, true)?.expect("creating the lock returns a file");
        Self::claim(root.to_path_buf(), state, lock, false)
    }

    fn claim(
        root: PathBuf,
        state: PathBuf,
        lock: File,
        from_previous: bool,
    ) -> Result<Self, Diagnostic> {
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                root,
                state,
                lock,
                from_previous,
            }),
            Err(TryLockError::WouldBlock) => Err(operation_error(
                "CLI_UPDATE_IN_PROGRESS",
                format!("An update is already in progress for {}.", root.display()),
            )),
            Err(TryLockError::Error(error)) => Err(file_error(&state.join("lock"), error)),
        }
    }

    pub(in super::super) fn prepare(&self) -> Result<String, Diagnostic> {
        let root = &self.root;
        match fs::symlink_metadata(root) {
            Ok(_) if self.from_previous => {
                return Err(operation_error(
                    "CLI_UPDATE_FAILED",
                    format!("Run the updater from {}/bin/cadencr.", root.display()),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let previous = sibling(root, PREVIOUS)?;
                if !lock_matches(&self.lock, &previous)? {
                    return Err(file_error(root, error));
                }
                fs::rename(&previous, root).map_err(|error| {
                    file_error(
                        &previous,
                        format!("cannot restore {}: {error}", root.display()),
                    )
                })?;
            }
            Err(error) => return Err(file_error(root, error)),
        }
        for entry in fs::read_dir(&self.state).map_err(|error| file_error(&self.state, error))? {
            let entry = entry.map_err(|error| file_error(&self.state, error))?;
            if entry
                .file_name()
                .as_encoded_bytes()
                .starts_with(WORKSPACE_PREFIX.as_bytes())
            {
                remove_dir(&entry.path())?;
            }
        }
        Ok(read_server_manifest(&manifest_path(root))?.version)
    }

    pub(super) fn workspace(&self) -> Result<tempfile::TempDir, Diagnostic> {
        tempfile::Builder::new()
            .prefix(WORKSPACE_PREFIX)
            .tempdir_in(&self.state)
            .map_err(|error| file_error(&self.state, error))
    }

    pub(super) fn back_up(&self) -> Result<PathBuf, Diagnostic> {
        let previous = sibling(&self.root, PREVIOUS)?;
        let identity =
            directory_identity(&self.root).map_err(|error| file_error(&self.root, error))?;
        remove_dir(&previous)?;
        // Record the directory we are about to move so a retry can identify it.
        self.lock
            .write_all_at(&identity, 0)
            .map_err(|error| file_error(&self.state.join("lock"), error))?;
        fs::rename(&self.root, &previous).map_err(|error| file_error(&self.root, error))?;
        Ok(previous)
    }
}

fn backup_origin(root: &Path) -> Option<PathBuf> {
    let (name, suffix) = root
        .file_name()?
        .to_str()?
        .strip_prefix('.')?
        .rsplit_once('.')?;
    (suffix == PREVIOUS && !matches!(name, "" | "." | "..")).then(|| root.with_file_name(name))
}

fn state_dir(root: &Path) -> Result<PathBuf, Diagnostic> {
    sibling(root, "update-state")
}

pub(super) fn manifest_path(root: &Path) -> PathBuf {
    root.join("lib").join(SERVER_MANIFEST)
}

fn open_lock(state: &Path, create: bool) -> Result<Option<File>, Diagnostic> {
    if create {
        match fs::DirBuilder::new().mode(0o700).create(state) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(file_error(state, error)),
        }
    }
    match fs::symlink_metadata(state) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(file_error(state, "expected an update state directory")),
        Err(error) if !create && error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(file_error(state, error)),
    }
    // Keep this inode even after the file descriptor releases the OS lock.
    let path = state.join("lock");
    let open = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path);
    match open {
        Ok(lock)
            if lock
                .metadata()
                .map_err(|error| file_error(&path, error))?
                .is_file() =>
        {
            Ok(Some(lock))
        }
        Ok(_) => Err(file_error(&path, "expected a regular lock file")),
        Err(error) if !create && error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(file_error(&path, error)),
    }
}

fn directory_identity(path: &Path) -> std::io::Result<[u8; 16]> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "expected an installation directory",
        ));
    }
    let mut identity = [0; 16];
    identity[..8].copy_from_slice(&metadata.dev().to_le_bytes());
    identity[8..].copy_from_slice(&metadata.ino().to_le_bytes());
    Ok(identity)
}

fn lock_matches(lock: &File, path: &Path) -> Result<bool, Diagnostic> {
    let mut recorded = [0; 16];
    match lock.read_exact_at(&mut recorded, 0) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(false),
        Err(error) => return Err(file_error(path, error)),
    }
    match directory_identity(path) {
        Ok(identity) => Ok(identity == recorded),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::InvalidData) => {
            Ok(false)
        }
        Err(error) => Err(file_error(path, error)),
    }
}

pub(super) fn swap(update: &ServerUpdate, replacement: &Path) -> Result<(), Diagnostic> {
    let root = &update.root;
    let previous = update.back_up()?;
    if let Err(error) = std::fs::rename(replacement, root) {
        let restored = std::fs::rename(&previous, root);
        return Err(operation_error(
            "CLI_UPDATE_FAILED",
            match restored {
                Ok(()) => format!("{}: {error}; the installation is unchanged", root.display()),
                Err(restore) => format!(
                    "{}: {error}; restoring it from {} also failed: {restore}",
                    root.display(),
                    previous.display()
                ),
            },
        ));
    }
    Ok(())
}

/// `<parent>/.<installation name>.<suffix>`: same filesystem, so the renames
/// are atomic.
fn sibling(root: &Path, suffix: &str) -> Result<PathBuf, Diagnostic> {
    let name = root.file_name().and_then(|name| name.to_str());
    match (root.parent(), name) {
        (Some(parent), Some(name)) => Ok(parent.join(format!(".{name}.{suffix}"))),
        _ => Err(operation_error(
            "CLI_UPDATE_FAILED",
            format!("cannot update an installation at {}", root.display()),
        )),
    }
}

fn remove_dir(path: &Path) -> Result<(), Diagnostic> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(file_error(path, error)),
        _ => Ok(()),
    }
}

pub(super) fn file_error(path: &Path, error: impl std::fmt::Display) -> Diagnostic {
    operation_error("CLI_UPDATE_FAILED", format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::super::tests::server_tree;
    use super::*;

    #[test]
    fn one_updater_owns_the_installation_even_after_its_binary_moves() {
        let dir = tempfile::tempdir().unwrap();
        let root = server_tree(dir.path(), "1.0.0");
        let executable = root.join("bin/cadencr");
        let update = ServerUpdate::from_executable(&executable).unwrap().unwrap();
        let workspace = update.workspace().unwrap().keep();
        fs::write(workspace.join("archive.tar.gz"), b"interrupted").unwrap();
        let other = server_tree(&dir.path().join("other"), "2.0.0");
        let other_root = root.with_file_name("another-server");
        fs::rename(other, &other_root).unwrap();
        let sibling_update = ServerUpdate::begin(&other_root).unwrap();
        assert_eq!(sibling_update.prepare().unwrap(), "2.0.0");
        let sibling_workspace = sibling_update.workspace().unwrap();

        let previous = update.back_up().unwrap();
        let backup_executable = previous.join("bin/cadencr");
        // A contender can see either the captured path or the moved executable.
        for path in [&executable, &backup_executable] {
            let error = ServerUpdate::from_executable(path).err().unwrap();
            assert_eq!(error.code, "CLI_UPDATE_IN_PROGRESS");
        }
        assert!(manifest_path(&previous).is_file());
        assert!(workspace.join("archive.tar.gz").is_file());
        drop(update);

        // Retry from the surviving CLI after an interruption between renames.
        let recovered = ServerUpdate::from_executable(&backup_executable)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.prepare().unwrap(), "1.0.0");
        assert!(!previous.exists());
        assert!(!workspace.exists());
        assert!(sibling_workspace.path().is_dir());
        let next = recovered.workspace().unwrap();
        assert_ne!(workspace, next.path());
        let path = next.path().to_path_buf();
        next.close().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn an_empty_lock_does_not_identify_an_independent_installation_as_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let moved = dir.path().join("server");
        drop(ServerUpdate::begin(&moved).unwrap());
        let tree = server_tree(dir.path(), "1.0.0");
        let independent = dir.path().join(".server.previous");
        fs::rename(tree, &independent).unwrap();
        let update = ServerUpdate::from_executable(&independent.join("bin/cadencr"))
            .unwrap()
            .unwrap();
        assert_eq!(update.prepare().unwrap(), "1.0.0");
        assert!(manifest_path(&independent).is_file());
        assert!(!moved.exists());
    }

    #[test]
    fn a_failed_replacement_rename_restores_the_current_version() {
        let dir = tempfile::tempdir().unwrap();
        let root = server_tree(dir.path(), "1.0.0");
        let update = ServerUpdate::begin(&root).unwrap();
        let workspace = update.workspace().unwrap();
        let error = swap(&update, &workspace.path().join("missing")).unwrap_err();
        workspace.close().unwrap();
        assert_eq!(error.code, "CLI_UPDATE_FAILED");
        assert_eq!(update.prepare().unwrap(), "1.0.0");
        assert!(!sibling(&root, PREVIOUS).unwrap().exists());
    }
}
