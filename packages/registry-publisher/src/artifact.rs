use std::path::Path;

use crate::fs::{hash_regular, remove_owned, Identity};
use crate::stage::{StageArtifact, Target};
use crate::{Downloaded, PublisherError};

pub(crate) fn finish_target(
    target: &Target,
    partial: &Path,
    partial_identity: Identity,
    final_path: &Path,
    downloaded: Downloaded,
    max_bytes: u64,
) -> Result<StageArtifact, PublisherError> {
    let actual = hash_regular(partial, max_bytes, "downloaded asset")?;
    if downloaded != actual {
        return Err(PublisherError::new(format!(
            "downloaded asset result is dishonest: {}",
            target.asset
        )));
    }
    let verified = artifact_from_verified(target, actual)?;
    match std::fs::hard_link(partial, final_path) {
        Ok(()) => verify_published_target(target, final_path, partial_identity, verified),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let winner = hash_regular(final_path, max_bytes, "existing asset")?;
            artifact_from_verified(target, winner)
        }
        Err(error) => Err(PublisherError::io("publish staged asset", error)),
    }
}

fn verify_published_target(
    target: &Target,
    final_path: &Path,
    partial_identity: Identity,
    verified: StageArtifact,
) -> Result<StageArtifact, PublisherError> {
    let metadata = std::fs::symlink_metadata(final_path)
        .map_err(|error| PublisherError::io("inspect published asset", error))?;
    if partial_identity.matches(&metadata) {
        // The hard link references the independently hashed partial. Staging
        // requires a trusted directory; a third hash cannot prevent later writes.
        return Ok(verified);
    }
    let cleanup = remove_owned(final_path, partial_identity);
    let primary = PublisherError::new(format!(
        "published asset changed while being verified: {}",
        target.asset
    ));
    match cleanup {
        Ok(()) => Err(primary),
        Err(_) => Err(PublisherError::cleanup(primary, 1)),
    }
}

pub(crate) fn artifact_from_verified(
    target: &Target,
    verified: Downloaded,
) -> Result<StageArtifact, PublisherError> {
    if verified.sha256 != target.sha256.to_ascii_lowercase() {
        return Err(PublisherError::new(format!(
            "existing asset conflicts: {}",
            target.asset
        )));
    }
    Ok(StageArtifact {
        asset: target.asset.clone(),
        sha256: verified.sha256,
        size: verified.size,
    })
}

#[cfg(test)]
mod tests {
    use sha2::{Digest as _, Sha256};

    use super::*;

    fn fixture() -> (tempfile::TempDir, Target, String) {
        let root = tempfile::tempdir().unwrap();
        let digest = crate::hex(&Sha256::digest(b"same"));
        let target = Target {
            asset: "asset".into(),
            source_url: "unused".into(),
            destination_url: "unused".into(),
            sha256: digest.clone(),
        };
        (root, target, digest)
    }

    #[test]
    fn existing_equal_winner_is_accepted_and_different_winner_conflicts() {
        for (winner, accepted) in [(&b"same"[..], true), (&b"other"[..], false)] {
            let (root, target, digest) = fixture();
            let partial = root.path().join("partial");
            let final_path = root.path().join("asset");
            std::fs::write(&partial, b"same").unwrap();
            std::fs::write(&final_path, winner).unwrap();
            let identity = Identity::from_metadata(&std::fs::symlink_metadata(&partial).unwrap());
            let result = finish_target(
                &target,
                &partial,
                identity,
                &final_path,
                Downloaded {
                    sha256: digest,
                    size: 4,
                },
                crate::stage::MAX_ARCHIVE_BYTES,
            );
            assert_eq!(result.is_ok(), accepted);
            assert_eq!(std::fs::read(&final_path).unwrap(), winner);
        }
    }

    #[test]
    fn published_inode_mismatch_preserves_foreign_final() {
        let (root, target, digest) = fixture();
        let partial = root.path().join("partial");
        let final_path = root.path().join("asset");
        std::fs::write(&partial, b"same").unwrap();
        let identity = Identity::from_metadata(&std::fs::symlink_metadata(&partial).unwrap());
        std::fs::write(&final_path, b"foreign").unwrap();
        assert!(verify_published_target(
            &target,
            &final_path,
            identity,
            StageArtifact {
                asset: "asset".into(),
                sha256: digest,
                size: 4
            },
        )
        .is_err());
        assert_eq!(std::fs::read(final_path).unwrap(), b"foreign");
    }
}
