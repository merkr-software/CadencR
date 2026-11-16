//! Only verified staging archives are transient; immutable receipts remain intact.
use std::path::PathBuf;

use super::Entry;
use crate::fs::Identity;
use crate::PublisherError;

pub(super) struct OwnedArchives(Vec<(PathBuf, Identity)>);

impl OwnedArchives {
    pub(super) fn capture(entry: &Entry) -> Result<Self, PublisherError> {
        let mut archives = Vec::new();
        for target in entry.plan["targets"].as_array().expect("validated targets") {
            let path = entry
                .directory
                .join(target["asset"].as_str().expect("validated asset"));
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| PublisherError::io("inspect transient archive", error))?;
            let identity = Identity::from_metadata(&metadata);
            let verified = crate::fs::hash_regular(
                &path,
                crate::stage::MAX_ARCHIVE_BYTES,
                "transient archive",
            )?;
            let after = std::fs::symlink_metadata(&path)
                .map_err(|error| PublisherError::io("reinspect transient archive", error))?;
            if !identity.matches(&after)
                || verified.sha256 != target["sha256"].as_str().expect("validated digest")
            {
                return Err(PublisherError::new(
                    "transient archive changed before publication",
                ));
            }
            archives.push((path, identity));
        }
        Ok(Self(archives))
    }

    /// Called only after promotion independently verifies public bytes and receipts.
    pub(super) fn release(self) -> Result<(), PublisherError> {
        for (path, identity) in self.0 {
            crate::fs::remove_owned(&path, identity)
                .map_err(|error| PublisherError::io("remove verified transient archive", error))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_preserves_a_replacement_and_unrelated_receipts() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("archive.tar.gz");
        let receipt = root.path().join("publication-receipt.json");
        std::fs::write(&archive, b"owned").unwrap();
        std::fs::write(&receipt, b"immutable").unwrap();
        let identity = Identity::from_metadata(&std::fs::metadata(&archive).unwrap());
        let owned = OwnedArchives(vec![(archive.clone(), identity)]);
        std::fs::rename(&archive, root.path().join("old-inode")).unwrap();
        std::fs::write(&archive, b"replacement").unwrap();
        owned.release().unwrap();
        assert_eq!(std::fs::read(&archive).unwrap(), b"replacement");
        assert_eq!(std::fs::read(&receipt).unwrap(), b"immutable");
    }
}
