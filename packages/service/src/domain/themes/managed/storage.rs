//! Immutable revisions with verified receipts and one atomic desired revision pointer.
use super::archive::invalid;
use super::models::{Pointer, Receipt};
use crate::error::AppError;
use sha2::{Digest as _, Sha256};
use std::path::{Path, PathBuf};

pub fn staging() -> Result<tempfile::TempDir, AppError> {
    secure(&root())?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".stage-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(root()).map_err(invalid)
}
thread_local! {
    static ROOT_OVERRIDE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}
/// Carry the request's resolved storage directory into a blocking worker.
pub(super) fn with_root<T>(root: PathBuf, operation: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            ROOT_OVERRIDE.with(|slot| {
                slot.replace(self.0.take());
            });
        }
    }
    let _restore = Restore(ROOT_OVERRIDE.with(|slot| slot.replace(Some(root))));
    operation()
}
pub fn root() -> PathBuf {
    ROOT_OVERRIDE
        .with(|slot| slot.borrow().clone())
        .unwrap_or_else(|| {
            crate::domain::settings_store::dir::sibling_dir("plugins").join("managed-themes")
        })
}
pub fn valid_id(id: &str) -> bool {
    cadencr_registry_core::valid_theme_id(id)
}
pub fn owner(id: &str) -> Result<PathBuf, AppError> {
    if !valid_id(id) {
        return Err(invalid("invalid managed theme id"));
    }
    Ok(root().join(id))
}
pub fn revision(id: &str, version: &str, digest: &str) -> Result<PathBuf, AppError> {
    if semver::Version::parse(version).is_err()
        || version.contains(['/', '\\'])
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid("invalid theme revision identity"));
    }
    Ok(owner(id)?.join(version).join(digest))
}
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn secure(path: &Path) -> Result<(), AppError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid("managed theme directory is not a real directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return Err(invalid("managed theme directory must be owner-only"));
            }
        }
    }
    if let Some(parent) = path.parent() {
        if Some(parent) != root().parent() {
            secure(parent)?;
        } else if let Ok(info) = std::fs::symlink_metadata(parent) {
            if !info.is_dir() || info.file_type().is_symlink() {
                return Err(invalid("plugin container must be a real directory"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt as _;
                if info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o022 != 0 {
                    return Err(invalid(
                        "plugin container has unsafe ownership or permissions",
                    ));
                }
            }
        } else {
            crate::remote::secure_fs::create_dir_owner_only(parent).map_err(invalid)?;
        }
    }
    crate::remote::secure_fs::create_dir_owner_only(path).map_err(invalid)
}
pub fn bounded_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let bytes = regular(path, cadencr_registry_core::MAX_CATALOG_BYTES)?;
    serde_json::from_slice(&bytes).map_err(invalid)
}
/// Catalog proof plus bounded revision metadata, never an unbounded receipt.
const MAX_RECEIPT_BYTES: usize = cadencr_registry_core::MAX_CATALOG_BYTES + 64 * 1024;
pub fn receipt(path: &Path) -> Result<Receipt, AppError> {
    serde_json::from_slice(&regular(path, MAX_RECEIPT_BYTES)?).map_err(invalid)
}
fn receipt_document(receipt: &Receipt) -> Result<String, AppError> {
    let document = serde_json::to_string(receipt).map_err(invalid)?;
    if document.len() > MAX_RECEIPT_BYTES {
        return Err(invalid("managed theme receipt exceeds byte budget"));
    }
    Ok(document)
}
pub fn regular(path: &Path, limit: usize) -> Result<Vec<u8>, AppError> {
    use std::io::Read as _;
    let before = std::fs::symlink_metadata(path).map_err(invalid)?;
    if !before.is_file() || before.len() > limit as u64 {
        return Err(invalid("managed theme file is not bounded regular data"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(invalid)?;
    let after = file.metadata().map_err(invalid)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || after.uid() != unsafe { libc::geteuid() }
            || after.mode() & 0o177 != 0
            || after.nlink() != 1
        {
            return Err(invalid(
                "managed theme file inode or permissions are unsafe",
            ));
        }
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(invalid)?;
    if bytes.len() > limit {
        return Err(invalid("managed theme file exceeds budget"));
    }
    Ok(bytes)
}
/// Persist the original authenticated archive, not just mutable derived payload hashes.
pub fn write_archive(staging: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write as _;
    if bytes.len() > super::archive::MAX_ARCHIVE_BYTES {
        return Err(invalid("theme archive exceeds byte budget"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(staging.join("archive.tar.gz"))
        .map_err(invalid)?;
    file.write_all(bytes).map_err(invalid)?;
    file.sync_all().map_err(invalid)
}

pub fn pointer(id: &str) -> Result<Pointer, AppError> {
    secure(&owner(id)?)?;
    bounded_json(&owner(id)?.join("active.json"))
}
pub fn commit(staging: &Path, receipt: &Receipt) -> Result<(), AppError> {
    let document = receipt_document(receipt)?;
    let destination = revision(&receipt.id, &receipt.version, &receipt.sha256)?;
    secure(
        destination
            .parent()
            .ok_or_else(|| invalid("revision parent missing"))?,
    )?;
    crate::shared::atomic_file::write_atomic_private(&staging.join("receipt.json"), &document)?;
    if destination.exists() {
        return Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "MANAGED_THEME_REVISION_EXISTS",
            "immutable theme revision already exists",
        ));
    }
    std::fs::rename(staging, &destination).map_err(invalid)?;
    activate(
        &receipt.id,
        &Pointer {
            version: receipt.version.clone(),
            sha256: receipt.sha256.clone(),
        },
    )
}
pub fn activate(id: &str, pointer: &Pointer) -> Result<(), AppError> {
    secure(&owner(id)?)?;
    crate::shared::atomic_file::write_atomic_private(
        &owner(id)?.join("active.json"),
        &serde_json::to_string(pointer).map_err(invalid)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximum_catalog_receipt_roundtrips_and_oversize_fails_before_commit() {
        let (index, trust) = super::super::catalog::tests::signed();
        let mut proof = Receipt {
            index,
            id: "near-limit".into(),
            version: "1.0.0".into(),
            sha256: "a".repeat(64),
            files: std::collections::BTreeMap::new(),
        };
        // Transport-sized proof, with wrapper overhead outside the catalog budget.
        let original = serde_json::to_string(&proof.index).unwrap().len();
        proof.index.signed.packages[0]["package"]["theme"]["description"] = "x"
            .repeat(cadencr_registry_core::MAX_CATALOG_BYTES - original + 10)
            .into();
        use base64::Engine as _;
        use ed25519_dalek::Signer as _;
        proof.index.signature.value = base64::engine::general_purpose::STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[19; 32])
                .sign(&cadencr_registry_core::canonical_json_bytes(
                    &serde_json::to_value(&proof.index.signed).unwrap(),
                ))
                .to_bytes(),
        );
        super::super::catalog::verify(&proof.index, &trust, false).unwrap();
        assert!(
            serde_json::to_string(&proof.index).unwrap().len()
                <= cadencr_registry_core::MAX_CATALOG_BYTES
        );
        let document = receipt_document(&proof).unwrap();
        assert!(document.len() > cadencr_registry_core::MAX_CATALOG_BYTES);
        let stage = tempfile::tempdir().unwrap();
        let path = stage.path().join("receipt.json");
        crate::shared::atomic_file::write_atomic_private(&path, &document).unwrap();
        assert_eq!(receipt(&path).unwrap().id, "near-limit");
        proof.files.insert("oversize".into(), "x".repeat(64 * 1024));
        assert!(receipt_document(&proof).is_err());
        assert!(commit(stage.path(), &proof).is_err());
        assert!(stage.path().exists());
        assert!(!owner(&proof.id).unwrap().exists());
    }

    #[test]
    fn revision_identity_rejects_traversal_and_wrong_digest() {
        assert!(revision("../escape", "1.0.0", &"a".repeat(64)).is_err());
        assert!(revision("theme", "../escape", &"a".repeat(64)).is_err());
        assert!(revision("theme", "1.0.0", "bad").is_err());
        assert!(revision("theme", "1.0.0", &"a".repeat(64)).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_hardlinks_executable_bits_and_world_readable_files() {
        use std::os::unix::fs::{symlink, PermissionsExt as _};
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("data");
        std::fs::write(&file, b"inert").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(regular(&file, 10).unwrap(), b"inert");
        assert!(regular(&file, 2).is_err());
        let link = root.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(regular(&link, 10).is_err());
        let hard = root.path().join("hard");
        std::fs::hard_link(&file, &hard).unwrap();
        assert!(regular(&hard, 10).is_err());
        std::fs::remove_file(hard).unwrap();
        for mode in [0o700, 0o644, 0o666] {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(regular(&file, 10).is_err());
        }
    }
}
