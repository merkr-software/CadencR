//! Moving the project folder itself.
//!
//! Within one volume the folder is renamed in one step and never replaces
//! anything. Across volumes a rename is impossible, so the folder is copied
//! and the original is left in place for the user to delete: Cadencr never
//! deletes a project's files.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::shared::no_replace_rename::rename_no_replace;
use crate::shared::path_rebase::same_file;

/// How the folder reached its new place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Moved {
    Renamed,
    /// Another volume: the original is still at the old place.
    Copied,
}

pub(super) async fn move_folder(from: &Path, to: &Path) -> Result<Moved, AppError> {
    let (from, to) = (from.to_path_buf(), to.to_path_buf());
    tokio::task::spawn_blocking(move || move_blocking(&from, &to))
        .await
        .map_err(|error| AppError::internal(format!("folder move task failed: {error}")))?
}

/// Undo [`move_folder`]: rename back, or remove the copy it made.
pub(super) async fn undo(from: &Path, to: &Path, moved: Moved) -> Result<(), String> {
    let (from, to) = (from.to_path_buf(), to.to_path_buf());
    tokio::task::spawn_blocking(move || match moved {
        Moved::Renamed => {
            rename_no_replace(&to, &from).map_err(|error| failed("move back", &to, &from, &error))
        }
        Moved::Copied => std::fs::remove_dir_all(&to)
            .map_err(|error| format!("could not remove the copy at {}: {error}", to.display())),
    })
    .await
    .map_err(|error| format!("folder move undo task failed: {error}"))?
}

fn move_blocking(from: &Path, to: &Path) -> Result<Moved, AppError> {
    if same_file(from, to) {
        return change_case(from, to)
            .map(|()| Moved::Renamed)
            .map_err(AppError::internal);
    }
    let renamed = match rename_no_replace(from, to) {
        // Some filesystems (NFS, SMB, exFAT, some FUSE) refuse the no-replace
        // flag itself; a plain rename then never replaces a folder that is
        // not there.
        Err(error) if flag_refused(&error) && std::fs::symlink_metadata(to).is_err() => {
            std::fs::rename(from, to)
        }
        renamed => renamed,
    };
    match renamed {
        Ok(()) => Ok(Moved::Renamed),
        Err(error) if is_cross_device(&error) => copy_across(from, to)
            .map(|()| Moved::Copied)
            .map_err(AppError::internal),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(AppError::Conflict(format!(
            "{} already exists",
            to.display()
        ))),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            Err(AppError::BadRequest(failed("move", from, to, &error)))
        }
        Err(error) => Err(AppError::internal(failed("move", from, to, &error))),
    }
}

fn flag_refused(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::InvalidInput | ErrorKind::Unsupported
    )
}

/// A case-insensitive volume sees `to` as `from` already: go through a free
/// name so the new spelling is the one recorded.
fn change_case(from: &Path, to: &Path) -> Result<(), String> {
    let staging = staging_name(from);
    rename_no_replace(from, &staging).map_err(|error| failed("move", from, &staging, &error))?;
    rename_no_replace(&staging, to).map_err(|error| {
        let restored = rename_no_replace(&staging, from);
        let note = match restored {
            Ok(()) => String::new(),
            Err(_) => format!(" (the folder is now at {})", staging.display()),
        };
        format!("{}{note}", failed("move", &staging, to, &error))
    })
}

fn staging_name(from: &Path) -> PathBuf {
    let name = from
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    from.with_file_name(format!("{name}.cadencr-rename-{}", std::process::id()))
}

fn copy_across(from: &Path, to: &Path) -> Result<(), String> {
    // Created here, not in the copy, so that a folder someone else put at
    // `to` in the meantime is refused and never removed below.
    std::fs::create_dir(to).map_err(|error| failed("create", from, to, &error))?;
    let copied = copy_contents(from, to);
    if let Err(error) = &copied {
        // The copy is Cadencr's own half-written folder; the original is intact.
        if let Err(cleanup) = std::fs::remove_dir_all(to) {
            return Err(format!(
                "{error}; the partial copy at {} could not be removed: {cleanup}",
                to.display()
            ));
        }
    }
    copied
}

/// Copy a folder tree: files with their permissions, symlinks as symlinks.
/// Sockets and pipes are skipped — they only mean something to a running
/// process.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir(to).map_err(|error| failed("create", from, to, &error))?;
    copy_contents(from, to)
}

/// Copy what `from` holds into the existing folder `to`, then its permissions.
fn copy_contents(from: &Path, to: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(from).map_err(|error| failed("read", from, to, &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| failed("read", from, to, &error))?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry
            .file_type()
            .map_err(|error| failed("read", &source, &target, &error))?;
        if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else if kind.is_symlink() {
            copy_symlink(&source, &target)?;
        } else if kind.is_file() {
            std::fs::copy(&source, &target)
                .map_err(|error| failed("copy", &source, &target, &error))?;
        }
    }
    let permissions = std::fs::metadata(from)
        .map_err(|error| failed("read", from, to, &error))?
        .permissions();
    std::fs::set_permissions(to, permissions).map_err(|error| failed("copy", from, to, &error))
}

fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    let link =
        std::fs::read_link(source).map_err(|error| failed("read", source, target, &error))?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&link, target)
            .map_err(|error| failed("copy", source, target, &error))
    }
    #[cfg(not(unix))]
    {
        let _ = link;
        Err(format!(
            "could not copy the symlink {}: unsupported on this platform",
            source.display()
        ))
    }
}

fn is_cross_device(error: &std::io::Error) -> bool {
    error.kind() == ErrorKind::CrossesDevices || error.raw_os_error() == Some(libc::EXDEV)
}

fn failed(action: &str, from: &Path, to: &Path, error: &std::io::Error) -> String {
    format!(
        "could not {action} {} to {}: {error}",
        from.display(),
        to.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(root: &Path) -> PathBuf {
        let project = root.join("app");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/main.rs"), "fn main() {}").unwrap();
        project
    }

    #[tokio::test]
    async fn renames_within_a_volume() {
        let root = tempfile::tempdir().unwrap();
        let from = project(root.path());
        let to = root.path().join("renamed");

        let moved = move_folder(&from, &to).await.unwrap();

        assert_eq!(moved, Moved::Renamed);
        assert!(to.join("src/main.rs").is_file());
        assert!(!from.exists());

        undo(&from, &to, moved).await.unwrap();
        assert!(from.join("src/main.rs").is_file());
        assert!(!to.exists());
    }

    #[test]
    fn a_copy_keeps_files_symlinks_and_the_original() {
        let root = tempfile::tempdir().unwrap();
        let from = project(root.path());
        #[cfg(unix)]
        std::os::unix::fs::symlink("src/main.rs", from.join("link")).unwrap();
        let to = root.path().join("copy");

        copy_across(&from, &to).unwrap();

        assert_eq!(
            std::fs::read_to_string(to.join("src/main.rs")).unwrap(),
            "fn main() {}"
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(to.join("link")).unwrap(),
            Path::new("src/main.rs")
        );
        assert!(from.join("src/main.rs").is_file());
    }

    #[test]
    fn a_failed_copy_leaves_no_partial_folder() {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("missing");
        let to = root.path().join("copy");

        assert!(copy_across(&from, &to).is_err());
        assert!(!to.exists());
    }

    #[test]
    fn a_copy_never_removes_a_folder_it_did_not_create() {
        let root = tempfile::tempdir().unwrap();
        let from = project(root.path());
        let to = root.path().join("taken");
        std::fs::create_dir(&to).unwrap();
        std::fs::write(to.join("theirs.txt"), "keep").unwrap();

        assert!(copy_across(&from, &to).is_err());
        assert_eq!(
            std::fs::read_to_string(to.join("theirs.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn a_folder_that_appeared_at_the_destination_is_a_conflict() {
        let root = tempfile::tempdir().unwrap();
        let from = project(root.path());
        let to = root.path().join("taken");
        std::fs::create_dir(&to).unwrap();
        std::fs::write(to.join("theirs.txt"), "keep").unwrap();

        let error = move_blocking(&from, &to).unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
        assert!(from.is_dir());
    }

    #[test]
    fn a_change_of_case_is_a_rename() {
        let root = tempfile::tempdir().unwrap();
        let from = project(root.path());
        let to = root.path().join("App");

        move_blocking(&from, &to).unwrap();

        let names: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["App"]);
    }
}
