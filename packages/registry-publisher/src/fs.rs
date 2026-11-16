use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Write as _};
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::{Downloaded, PublisherError};

pub(crate) struct OwnedLock {
    path: PathBuf,
    file: Option<File>,
    identity: Identity,
}

impl OwnedLock {
    pub(crate) fn acquire(path: &Path) -> Result<Self, PublisherError> {
        let file = private_create(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                PublisherError::new("staging directory is already locked")
            } else {
                PublisherError::io("create staging lock", error)
            }
        })?;
        let identity = Identity::from_metadata(
            &file
                .metadata()
                .map_err(|error| PublisherError::io("inspect staging lock", error))?,
        );
        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
            identity,
        })
    }

    pub(crate) fn release(mut self, primary: Option<PublisherError>) -> Result<(), PublisherError> {
        self.file.take();
        let cleanup = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) if self.identity.matches(&metadata) => {
                std::fs::remove_file(&self.path).err()
            }
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => Some(error),
        };
        match (primary, cleanup) {
            (Some(error), Some(_)) => Err(PublisherError::cleanup(error, 1)),
            (Some(error), None) => Err(error),
            (None, Some(error)) => Err(PublisherError::io("remove staging lock", error)),
            (None, None) => Ok(()),
        }
    }
}

pub(crate) fn ensure_directory(path: &Path) -> Result<(), PublisherError> {
    std::fs::create_dir_all(path)
        .map_err(|error| PublisherError::io("create staging directory", error))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| PublisherError::io("inspect staging directory", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PublisherError::new(
            "staging path must be a non-symlink directory",
        ));
    }
    Ok(())
}

pub(crate) fn hash_regular(
    path: &Path,
    max: u64,
    label: &str,
) -> Result<Downloaded, PublisherError> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|error| PublisherError::io(&format!("inspect {label}"), error))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(PublisherError::new(format!(
            "{label} must be a regular file"
        )));
    }
    if before.len() > max {
        return Err(PublisherError::new(format!(
            "{label} exceeds the size limit"
        )));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(
        &mut options,
        libc::O_NOFOLLOW | libc::O_NONBLOCK,
    );
    let mut file = options
        .open(path)
        .map_err(|error| PublisherError::io(&format!("open {label}"), error))?;
    let after = file
        .metadata()
        .map_err(|error| PublisherError::io(&format!("inspect opened {label}"), error))?;
    if !after.is_file() || after.len() > max || !Identity::from_metadata(&before).matches(&after) {
        return Err(PublisherError::new(format!(
            "{label} changed while being verified"
        )));
    }
    hash_reader(&mut file, max, label)
}

fn hash_reader(
    reader: &mut impl Read,
    max: u64,
    label: &str,
) -> Result<Downloaded, PublisherError> {
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| PublisherError::io(&format!("hash {label}"), error))?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| PublisherError::new(format!("{label} exceeds the size limit")))?;
        if size > max {
            return Err(PublisherError::new(format!(
                "{label} exceeds the size limit"
            )));
        }
        hash.update(&buffer[..count]);
    }
    Ok(Downloaded {
        sha256: crate::hex(&hash.finalize()),
        size,
    })
}

pub(crate) fn read_bounded(path: &Path, max: u64, label: &str) -> Result<Vec<u8>, PublisherError> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|error| PublisherError::io(&format!("inspect {label}"), error))?;
    if before.file_type().is_symlink() || !before.is_file() || before.len() > max {
        return Err(PublisherError::new(format!(
            "{label} must be a bounded regular file"
        )));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(
        &mut options,
        libc::O_NOFOLLOW | libc::O_NONBLOCK,
    );
    let mut file = options
        .open(path)
        .map_err(|error| PublisherError::io(&format!("open {label}"), error))?;
    let after = file
        .metadata()
        .map_err(|error| PublisherError::io(&format!("inspect opened {label}"), error))?;
    if !after.is_file() || !Identity::from_metadata(&before).matches(&after) {
        return Err(PublisherError::new(format!(
            "{label} changed while being read"
        )));
    }
    let capacity = usize::try_from(after.len().min(max)).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| PublisherError::io(&format!("read {label}"), error))?;
    if bytes.len() as u64 > max {
        return Err(PublisherError::new(format!(
            "{label} exceeds the size limit"
        )));
    }
    Ok(bytes)
}

pub(crate) fn write_private_synced(path: &Path, bytes: &[u8]) -> Result<Identity, PublisherError> {
    let mut file = private_create(path)
        .map_err(|error| PublisherError::io("create receipt partial", error))?;
    let identity = Identity::from_metadata(
        &file
            .metadata()
            .map_err(|error| PublisherError::io("inspect receipt partial", error))?,
    );
    let result = file
        .write_all(bytes)
        .map_err(|error| PublisherError::io("write receipt partial", error))
        .and_then(|()| {
            file.sync_all()
                .map_err(|error| PublisherError::io("sync receipt partial", error))
        });
    drop(file);
    match result {
        Ok(()) => Ok(identity),
        Err(primary) => match remove_owned(path, identity) {
            Ok(()) => Err(primary),
            Err(_) => Err(PublisherError::cleanup(primary, 1)),
        },
    }
}

pub(crate) fn private_create(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

#[derive(Clone, Copy)]
pub(crate) struct Identity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    length: u64,
}

impl Identity {
    pub(crate) fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(not(unix))]
        Self {
            length: metadata.len(),
        }
    }

    pub(crate) fn matches(self, metadata: &Metadata) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            metadata.dev() == self.device && metadata.ino() == self.inode
        }
        #[cfg(not(unix))]
        {
            metadata.is_file() && metadata.len() == self.length
        }
    }
}

pub(crate) fn remove_owned(path: &Path, identity: Identity) -> Result<(), std::io::Error> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if identity.matches(&metadata) => std::fs::remove_file(path),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn bounded_reads_reject_symlinks_and_fifos_without_blocking() {
        let directory = tempfile::tempdir().unwrap();
        let regular = directory.path().join("regular");
        let link = directory.path().join("link");
        let fifo = directory.path().join("fifo");
        std::fs::write(&regular, "bytes").unwrap();
        symlink(&regular, &link).unwrap();
        let fifo_bytes = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: `fifo_bytes` is a live, NUL-terminated path and mode has no invalid bits.
        assert_eq!(unsafe { libc::mkfifo(fifo_bytes.as_ptr(), 0o600) }, 0);
        assert!(read_bounded(&link, 32, "fixture").is_err());
        assert!(read_bounded(&fifo, 32, "fixture").is_err());
        assert_eq!(read_bounded(&regular, 32, "fixture").unwrap(), b"bytes");
    }

    #[test]
    fn lock_cleanup_preserves_an_inode_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lock");
        let lock = OwnedLock::acquire(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, "foreign").unwrap();
        lock.release(None).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "foreign");
    }
}
