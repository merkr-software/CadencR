//! A scratch directory other local users cannot pre-create, read, or swap.
//!
//! macOS hands every user a private `$TMPDIR` (`/var/folders/…`), so
//! `std::env::temp_dir()` is already safe there and stays the location. On
//! Linux `temp_dir()` is the world-writable `/tmp`: a fixed name such as
//! `/tmp/cadencr-codex-attachments` can be squatted by another user, and a
//! predictable file name can be planted ahead of time. There we create one
//! `0700` directory per process with a random name, keep it for the process
//! lifetime and remove it on shutdown.

use std::path::PathBuf;
use std::sync::Mutex;

/// Parent directory for short-lived Cadencr scratch files.
pub fn private_temp_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "macos") {
        return Ok(std::env::temp_dir());
    }
    process_private_dir()
}

/// Owned here rather than in a `static OnceLock`, whose value is never dropped:
/// shutdown takes it out so each launch does not leave a directory behind.
static PROCESS_DIR: DirSlot = Mutex::new(None);

type DirSlot = Mutex<Option<tempfile::TempDir>>;

/// The per-process `0700` directory (the non-macOS branch). Recreated with the
/// same restrictive mode if a `/tmp` cleaner removed it under a long-running
/// service; `create_dir` fails rather than adopting a directory someone else
/// made in the meantime.
fn process_private_dir() -> Result<PathBuf, String> {
    private_dir_in(&PROCESS_DIR)
}

fn private_dir_in(slot: &DirSlot) -> Result<PathBuf, String> {
    let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = match slot.as_ref() {
        Some(dir) => dir.path().to_path_buf(),
        None => {
            let created = new_process_dir()?;
            let path = created.path().to_path_buf();
            *slot = Some(created);
            path
        }
    };
    if !dir.is_dir() {
        create_owner_only_dir(&dir)?;
    }
    Ok(dir)
}

fn new_process_dir() -> Result<tempfile::TempDir, String> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("cadencr-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder
        .tempdir()
        .map_err(|error| format!("create private temp directory: {error}"))
}

/// Delete the per-process directory and everything left in it. Called once
/// the service has stopped its agents; a later caller would get a fresh one.
pub fn remove_process_private_dir() -> std::io::Result<()> {
    remove_dir_in(&PROCESS_DIR)
}

fn remove_dir_in(slot: &DirSlot) -> std::io::Result<()> {
    let taken = slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    match taken {
        Some(dir) => dir.close(),
        None => Ok(()),
    }
}

fn create_owner_only_dir(dir: &std::path::Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|error| format!("recreate private temp directory {}: {error}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_private_dir_is_stable_and_owner_only() {
        let first = process_private_dir().unwrap();
        assert_eq!(process_private_dir().unwrap(), first);
        assert!(first.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&first).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[test]
    fn shutdown_removes_the_process_dir_and_its_files() {
        // A local slot: removing the shared one would pull the directory from
        // under checkpoint and Codex tests running in parallel.
        let slot: DirSlot = Mutex::new(None);
        let dir = private_dir_in(&slot).unwrap();
        std::fs::write(dir.join("leftover"), b"x").unwrap();
        remove_dir_in(&slot).unwrap();
        assert!(!dir.exists());
        let fresh = private_dir_in(&slot).unwrap();
        assert_ne!(fresh, dir);
        assert!(fresh.is_dir());
        remove_dir_in(&slot).unwrap();
    }

    #[test]
    fn recreate_refuses_an_existing_directory() {
        let parent = tempfile::tempdir().unwrap();
        let taken = parent.path().join("taken");
        std::fs::create_dir(&taken).unwrap();
        assert!(create_owner_only_dir(&taken).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_the_per_user_tmpdir() {
        assert_eq!(private_temp_dir().unwrap(), std::env::temp_dir());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_use_the_process_private_dir() {
        assert_eq!(private_temp_dir().unwrap(), process_private_dir().unwrap());
    }
}
