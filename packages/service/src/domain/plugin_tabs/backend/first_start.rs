//! The `ready` budget of one start: [`FIRST_READY_TIMEOUT`] the first time
//! this Cadencr process runs a given binary, [`READY_TIMEOUT`] after.
//!
//! macOS assesses an executable on its first launch (Gatekeeper, XProtect),
//! seconds before its `main` runs for a large freshly written binary — a
//! marketplace install or a local rebuild. A binary is identified by its file
//! (device, inode, size, modification time): a new revision, a reinstall or
//! a rebuild is a new file, and so a new first start.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use super::handshake::{FIRST_READY_TIMEOUT, READY_TIMEOUT};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BinaryKey {
    device: u64,
    inode: u64,
    len: u64,
    modified: Option<SystemTime>,
}

/// The binaries started since this process began; a handful per session.
static STARTED: LazyLock<Mutex<HashSet<BinaryKey>>> = LazyLock::new(Default::default);

/// The `ready` budget for starting `executable` now; records it as started.
/// An unreadable file (it is about to fail to start anyway) gets the lenient
/// budget.
pub(super) fn ready_budget(executable: &Path) -> Duration {
    let Ok(metadata) = executable.metadata() else {
        return FIRST_READY_TIMEOUT;
    };
    let key = key_of(&metadata);
    // Inserting is the whole update, so a poisoned set is still usable.
    let first = STARTED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key);
    if first {
        FIRST_READY_TIMEOUT
    } else {
        READY_TIMEOUT
    }
}

#[cfg(unix)]
fn key_of(metadata: &std::fs::Metadata) -> BinaryKey {
    use std::os::unix::fs::MetadataExt as _;
    BinaryKey {
        device: metadata.dev(),
        inode: metadata.ino(),
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

#[cfg(not(unix))]
fn key_of(metadata: &std::fs::Metadata) -> BinaryKey {
    BinaryKey {
        device: 0,
        inode: 0,
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_binarys_first_start_gets_the_lenient_budget() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("backend");
        std::fs::write(&binary, b"one").unwrap();
        assert_eq!(ready_budget(&binary), FIRST_READY_TIMEOUT);
        assert_eq!(ready_budget(&binary), READY_TIMEOUT);
        // A rebuild at the same path is a new binary.
        std::fs::write(&binary, b"rebuilt").unwrap();
        assert_eq!(ready_budget(&binary), FIRST_READY_TIMEOUT);
        // So is a copy elsewhere, even of the same bytes.
        let copy = temp.path().join("copy");
        std::fs::copy(&binary, &copy).unwrap();
        assert_eq!(ready_budget(&copy), FIRST_READY_TIMEOUT);
        assert_eq!(
            ready_budget(&temp.path().join("missing")),
            FIRST_READY_TIMEOUT
        );
    }
}
