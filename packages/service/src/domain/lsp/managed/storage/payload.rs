//! Launch-time exact membership prevents unsigned package.json or optional JS imports.
use super::{invalid, io};
use crate::error::AppError;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub(super) fn verify(
    root: &Path,
    revision: &Path,
    files: BTreeMap<String, Vec<u8>>,
) -> Result<(), AppError> {
    let payload = revision.join("payload");
    let expected = files.keys().cloned().collect::<BTreeSet<_>>();
    let mut directories = BTreeSet::new();
    for name in &expected {
        let mut path = Path::new(name).parent();
        while let Some(parent) = path.filter(|path| !path.as_os_str().is_empty()) {
            directories.insert(parent.to_string_lossy().into_owned());
            path = parent.parent();
        }
    }
    let mut actual_files = BTreeSet::new();
    let mut actual_directories = BTreeSet::new();
    scan(
        root,
        &payload,
        &payload,
        &mut actual_files,
        &mut actual_directories,
        expected.len() + directories.len(),
    )?;
    if expected != actual_files || directories != actual_directories {
        return Err(invalid("LSP payload membership changed"));
    }
    for (name, expected) in files {
        if read_payload(&payload.join(&name), expected.len())? != expected {
            return Err(invalid(format!("LSP file changed: {name}")));
        }
    }
    Ok(())
}
fn scan(
    root: &Path,
    payload: &Path,
    directory: &Path,
    files: &mut BTreeSet<String>,
    directories: &mut BTreeSet<String>,
    limit: usize,
) -> Result<(), AppError> {
    io::with_root(root.to_path_buf(), || io::secure(directory))?;
    for entry in std::fs::read_dir(directory).map_err(invalid)? {
        let entry = entry.map_err(invalid)?;
        let path = entry.path();
        let metadata = path.symlink_metadata().map_err(invalid)?;
        let relative = path
            .strip_prefix(payload)
            .map_err(invalid)?
            .to_str()
            .ok_or_else(|| invalid("LSP payload path is not UTF-8"))?
            .to_owned();
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            directories.insert(relative);
            if files.len() + directories.len() > limit {
                return Err(invalid("LSP payload has unsigned additions"));
            }
            scan(root, payload, &path, files, directories, limit)?;
        } else if metadata.is_file() && !metadata.file_type().is_symlink() {
            files.insert(relative);
        } else {
            return Err(invalid("LSP payload contains a link or special file"));
        }
        if files.len() + directories.len() > limit {
            return Err(invalid("LSP payload has unsigned additions"));
        }
    }
    Ok(())
}
fn read_payload(path: &Path, limit: usize) -> Result<Vec<u8>, AppError> {
    use std::io::Read as _;
    let (mut file, length) =
        cadencr_plugin_core::open_regular_bounded(path, limit as u64).map_err(invalid)?;
    if length != limit as u64 {
        return Err(invalid("invalid LSP payload file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let after = file.metadata().map_err(invalid)?;
        if after.nlink() != 1
            || after.mode() & 0o022 != 0
            || after.uid() != unsafe { libc::geteuid() }
        {
            return Err(invalid("unsafe LSP payload inode"));
        }
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(invalid)?;
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn executable_payloads_keep_exact_length_and_private_single_inode_requirements() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("native-server");
        std::fs::write(&path, b"native").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(read_payload(&path, 6).unwrap(), b"native");
        assert!(read_payload(&path, 5).is_err());
        assert!(read_payload(&path, 7).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o720)).unwrap();
        assert!(read_payload(&path, 6).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let hardlink = temp.path().join("hardlink");
        std::fs::hard_link(&path, &hardlink).unwrap();
        assert!(read_payload(&path, 6).is_err());
        std::fs::remove_file(hardlink).unwrap();
        let link = temp.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(read_payload(&link, 6).is_err());
    }
}
