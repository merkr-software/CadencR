//! Filesystem helpers for the remote-access secrets (TLS private key, device
//! pepper). Both must never be world/group-readable, and must never *briefly*
//! be readable either — so we create them `0600` from the first byte rather
//! than writing at the umask default and tightening afterwards.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Write secret `bytes` to `path`, owner-read/write only (`0600`). On Unix the
/// file is created with that mode atomically via `OpenOptions::mode`, closing
/// the window where it would otherwise exist at the umask default; the explicit
/// re-chmod afterwards covers the case where the file already existed (open with
/// `create` keeps a pre-existing file's mode). On non-Unix this is a plain write.
pub fn write_secret(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file = open_owner_only(path, true)?;
    // Tighten before writing even when the file already exists.
    file.set_len(0)
        .with_context(|| format!("truncate {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", path.display()))
}

/// Open a regular file without following a final symlink; never truncate it.
/// chmod acts on the opened descriptor, so a renamed path cannot redirect it.
pub fn open_owner_only(path: &Path, create: bool) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .with_context(|| format!("open private file {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "not a regular file: {}", path.display());
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        anyhow::ensure!(
            metadata.nlink() == 1,
            "refusing hard-linked private file: {}",
            path.display()
        );
        if metadata.permissions().mode() & 0o7777 != 0o600 {
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("chmod 600 {}", path.display()))?;
        }
    }
    Ok(file)
}

/// Only the known Cadencr roots are ours to tighten; custom ancestors are not.
/// The roots come from `app_paths`: `~/.cadencr` on macOS, the XDG data,
/// config and cache dirs on Linux.
pub fn secure_app_home(path: &Path) -> Result<()> {
    use crate::shared::app_paths;
    let roots: Vec<PathBuf> = [
        app_paths::data_dir(),
        app_paths::config_dir(),
        app_paths::cache_dir(),
    ]
    .into_iter()
    .filter_map(|root| root.ok())
    .collect();
    for root in app_roots_containing(path, &roots) {
        create_dir_owner_only(root)?;
    }
    Ok(())
}

fn app_roots_containing<'a>(path: &Path, roots: &'a [PathBuf]) -> Vec<&'a PathBuf> {
    roots
        .iter()
        .filter(|root| path.starts_with(root) && path != root.as_path())
        .collect()
}

/// Create missing directories privately without changing existing ancestors.
pub fn create_missing_dirs(dir: &Path) -> Result<()> {
    if dir.as_os_str().is_empty() || dir.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        create_missing_dirs(parent)?;
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(()),
        Err(error) => Err(error).with_context(|| format!("create dir {}", dir.display())),
    }
}

/// Create and tighten the designated private directory, never its ancestors.
pub fn create_dir_owner_only(dir: &Path) -> Result<()> {
    secure_app_home(dir)?;
    create_missing_dirs(dir)?;
    let metadata = std::fs::symlink_metadata(dir)?;
    anyhow::ensure!(
        metadata.is_dir(),
        "not a regular directory: {}",
        dir.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(dir)?;
        if file.metadata()?.permissions().mode() & 0o7777 != 0o700 {
            file.set_permissions(std::fs::Permissions::from_mode(0o700))
                .with_context(|| format!("chmod 700 {}", dir.display()))?;
        }
    }
    Ok(())
}

/// Re-assert private permissions without following symlinks or changing data.
pub fn ensure_owner_only(path: &Path) -> Result<()> {
    open_owner_only(path, false).map(drop)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn app_roots_cover_xdg_and_macos_layouts_but_not_custom_paths() {
        let linux = [
            PathBuf::from("/home/u/.local/share/cadencr"),
            PathBuf::from("/home/u/.config/cadencr"),
            PathBuf::from("/home/u/.cache/cadencr"),
        ];
        let db = Path::new("/home/u/.local/share/cadencr/database/cadencr.db");
        assert_eq!(app_roots_containing(db, &linux), vec![&linux[0]]);
        let settings = Path::new("/home/u/.config/cadencr/settings");
        assert_eq!(app_roots_containing(settings, &linux), vec![&linux[1]]);
        assert!(app_roots_containing(&linux[0], &linux).is_empty());
        assert!(app_roots_containing(Path::new("/srv/custom/x.db"), &linux).is_empty());

        let macos = [
            PathBuf::from("/Users/u/.cadencr"),
            PathBuf::from("/Users/u/.cadencr/config"),
            PathBuf::from("/Users/u/.cadencr/cache"),
        ];
        let db = Path::new("/Users/u/.cadencr/database/cadencr.db");
        assert_eq!(app_roots_containing(db, &macos), vec![&macos[0]]);
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn already_private_files_and_directories_keep_metadata_unchanged() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempdir().unwrap();
        let private_dir = dir.path().join("private");
        create_dir_owner_only(&private_dir).unwrap();
        let path = private_dir.join("secret");
        write_secret(&path, b"secret").unwrap();
        let file_before = std::fs::metadata(&path).unwrap();
        let dir_before = std::fs::metadata(&private_dir).unwrap();
        ensure_owner_only(&path).unwrap();
        create_dir_owner_only(&private_dir).unwrap();
        let file_after = std::fs::metadata(&path).unwrap();
        let dir_after = std::fs::metadata(&private_dir).unwrap();
        assert_eq!(
            (file_before.ctime(), file_before.ctime_nsec()),
            (file_after.ctime(), file_after.ctime_nsec())
        );
        assert_eq!(
            (dir_before.ctime(), dir_before.ctime_nsec()),
            (dir_after.ctime(), dir_after.ctime_nsec())
        );
    }

    #[test]
    fn rejects_symlinks_without_changing_their_targets() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(write_secret(&link, b"replacement").is_err());
        assert!(ensure_owner_only(&link).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
        assert_eq!(mode(&target), 0o644);
        let linked_dir = dir.path().join("linked-dir");
        symlink(dir.path(), &linked_dir).unwrap();
        assert!(create_dir_owner_only(&linked_dir).is_err());
    }

    #[test]
    fn writes_new_secret_owner_only() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secret");
        write_secret(&path, b"top secret").unwrap();
        assert_eq!(mode(&path), 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"top secret");
    }

    #[test]
    fn creates_and_tightens_owner_only_dir() {
        let dir = tempdir().unwrap();
        let secret_dir = dir.path().join("nested/diagnostics");
        create_dir_owner_only(&secret_dir).unwrap();
        assert_eq!(mode(&secret_dir), 0o700);
        assert_eq!(mode(&dir.path().join("nested")), 0o700);

        // Loosened afterwards, a second call re-tightens it.
        std::fs::set_permissions(&secret_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        create_dir_owner_only(&secret_dir).unwrap();
        assert_eq!(mode(&secret_dir), 0o700, "re-run must re-tighten dir perms");
    }

    #[test]
    fn tightens_a_loose_preexisting_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secret");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_secret(&path, b"new").unwrap();
        assert_eq!(mode(&path), 0o600, "rewrite must re-tighten perms");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        ensure_owner_only(&path).unwrap();
        assert_eq!(mode(&path), 0o600, "load-time tighten must fix perms");
    }
}
