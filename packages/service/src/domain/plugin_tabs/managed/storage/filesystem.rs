use super::invalid;
use crate::error::AppError;
use std::path::Path;

pub fn secure(root: &Path, path: &Path) -> Result<(), AppError> {
    if !path.starts_with(root) {
        return Err(invalid("managed tab path escapes storage"));
    }
    if path != root {
        secure(
            root,
            path.parent()
                .ok_or_else(|| invalid("storage parent missing"))?,
        )?;
    }
    match path.symlink_metadata() {
        Ok(meta) => {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(invalid("tab directory must be real"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt as _;
                if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
                    return Err(invalid("tab storage must be owner-only"));
                }
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            crate::remote::secure_fs::create_dir_owner_only(path).map_err(invalid)
        }
        Err(e) => Err(invalid(e)),
    }
}
pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    write_new(path, bytes, 0o600)
}
/// [`write_file`] for a backend executable: owner-only and executable
/// (0700), never the quarantine-marked file Gatekeeper would hold back.
pub(super) fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    write_new(path, bytes, 0o700)?;
    crate::shared::quarantine::strip(path).map_err(invalid)
}
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<(), AppError> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(not(unix))]
    let _ = mode;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(mode).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(invalid)?;
    file.write_all(bytes).map_err(invalid)?;
    file.sync_all().map_err(invalid)
}

/// SHA-256 and length of a managed file too large to read into memory (see
/// [`check_private_file`]). Reads at most `limit` bytes of the inode it
/// checked, symlinks never followed.
pub(super) fn hash_private_file(
    path: &Path,
    limit: u64,
    executable: bool,
) -> Result<(String, u64), AppError> {
    use sha2::Digest as _;
    use std::io::Read as _;
    let mut reader = open_private_file(path, limit, executable)?.take(limit.saturating_add(1));
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut length = 0_u64;
    loop {
        let read = reader.read(&mut buffer).map_err(invalid)?;
        if read == 0 {
            break;
        }
        length += read as u64;
        hasher.update(&buffer[..read]);
    }
    if length > limit {
        return Err(invalid("managed tab file exceeds its size limit"));
    }
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((digest, length))
}

/// Open a managed file of at most `limit` bytes after checking, on the opened
/// descriptor, that it is a regular, single-link file of this user,
/// owner-only, with the owner's exec bit exactly when `executable`.
pub(super) fn open_private_file(
    path: &Path,
    limit: u64,
    executable: bool,
) -> Result<std::fs::File, AppError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if path
        .symlink_metadata()
        .map_err(invalid)?
        .file_type()
        .is_symlink()
    {
        return Err(invalid("managed tab file is a symlink"));
    }
    let file = options.open(path).map_err(invalid)?;
    let meta = file.metadata().map_err(invalid)?;
    if !meta.is_file() || meta.len() > limit {
        return Err(invalid("managed tab file is not a bounded regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let mode = meta.mode();
        if meta.uid() != unsafe { libc::geteuid() }
            || mode & 0o077 != 0
            || meta.nlink() != 1
            || (mode & 0o100 != 0) != executable
        {
            return Err(invalid(
                "managed tab file ownership or permissions are unsafe",
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = (meta, executable);
    Ok(file)
}

pub(super) fn check_directory(root: &Path, path: &Path) -> Result<(), AppError> {
    if !path.starts_with(root) {
        return Err(invalid("tab directory escapes storage"));
    }
    for ancestor in path.ancestors() {
        let meta = ancestor.symlink_metadata().map_err(invalid)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid("tab storage contains a symlink or non-directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
                return Err(invalid("tab storage permissions are unsafe"));
            }
        }
        if ancestor == root {
            break;
        }
    }
    Ok(())
}

/// Make a finished revision tree read-only, its owner included: directories
/// and executables 0500, other files 0400. A backend runs with the tab folder
/// as its working directory; a write there would change the signed revision
/// (and make retention keep it forever). `top` (the folder being published)
/// is sealed by the caller once it is in place; see [`seal_directory`].
pub(super) fn seal_contents(top: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(top).map_err(invalid)? {
        let path = entry.map_err(invalid)?.path();
        let meta = path.symlink_metadata().map_err(invalid)?;
        if meta.is_dir() {
            seal_contents(&path)?;
            seal_directory(&path)?;
        } else if meta.is_file() {
            seal_file(&path)?;
        } else {
            return Err(invalid("tab revision contains a non-regular file"));
        }
    }
    Ok(())
}

/// A sealed file: 0500 when the owner may execute it, else 0400.
pub(super) fn seal_file(path: &Path) -> Result<(), AppError> {
    set_mode(path, Kind::File, |mode| {
        if mode & 0o100 != 0 {
            0o500
        } else {
            0o400
        }
    })
}

/// A sealed directory: 0500.
pub(super) fn seal_directory(path: &Path) -> Result<(), AppError> {
    set_mode(path, Kind::Directory, |_| 0o500)
}

/// Whether a published directory is sealed (no owner write); a revision
/// stored before sealing existed is not.
pub(super) fn is_sealed_directory(path: &Path) -> Result<bool, AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let meta = path.symlink_metadata().map_err(invalid)?;
        Ok(meta.permissions().mode() & 0o200 == 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(true)
    }
}

/// Give the owner back write permission on one sealed directory (0700), so
/// retention can unlink what it proved is ours, or a control file can be
/// replaced.
pub(super) fn unseal_directory(path: &Path) -> Result<(), AppError> {
    set_mode(path, Kind::Directory, |_| 0o700)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
}

/// `chmod` through a descriptor opened without following a symlink, on a
/// file or directory of this user only.
#[cfg(unix)]
fn set_mode(path: &Path, kind: Kind, mode: impl Fn(u32) -> u32) -> Result<(), AppError> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
    let mut options = std::fs::OpenOptions::new();
    let directory = if kind == Kind::Directory {
        libc::O_DIRECTORY
    } else {
        0
    };
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | directory);
    let file = options.open(path).map_err(invalid)?;
    let meta = file.metadata().map_err(invalid)?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.is_dir() != (kind == Kind::Directory) {
        return Err(invalid("tab revision file ownership is unsafe"));
    }
    file.set_permissions(std::fs::Permissions::from_mode(mode(meta.mode() & 0o777)))
        .map_err(invalid)
}

/// Windows has no owner-write bit to drop (a read-only attribute would only
/// get in retention's way): revisions stay as written.
#[cfg(not(unix))]
fn set_mode(_path: &Path, _kind: Kind, _mode: impl Fn(u32) -> u32) -> Result<(), AppError> {
    Ok(())
}
