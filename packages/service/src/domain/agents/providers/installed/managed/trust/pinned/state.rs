use super::*;
use std::{fs::File, io::Read as _, path::Path};

/// The sibling lock is never renamed: locking the generation file itself would
/// lock an obsolete inode after the atomic replacement. Dropping the handle
/// releases the OS lock, including on process termination.
pub(super) fn advance(
    path: &Path,
    current: &VerifiedRegistryTrust,
    root: &[u8; 32],
    id: &str,
) -> Result<(), String> {
    inspect_parents(path)?;
    let parent = path.parent().ok_or("trust generation path has no parent")?;
    if let Ok(metadata) = parent.symlink_metadata() {
        validate_owner(&metadata)?;
    }
    crate::remote::secure_fs::create_dir_owner_only(parent).map_err(|e| e.to_string())?;
    inspect_parents(path)?;
    validate_owner(&parent.symlink_metadata().map_err(|e| e.to_string())?)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid trust generation filename")?;
    let lock_path = parent.join(format!(".{name}.lock"));
    let lock = open_private(&lock_path, true)?;
    lock.lock()
        .map_err(|e| format!("cannot lock registry trust generation: {e}"))?;
    validate_handle(&lock_path, &lock)?;
    advance_locked(path, current, root, id)
}

fn advance_locked(
    path: &Path,
    current: &VerifiedRegistryTrust,
    root: &[u8; 32],
    id: &str,
) -> Result<(), String> {
    let encoded = serde_json::to_string(current.envelope()).map_err(|e| e.to_string())?;
    // A Verified value from another root is not authority for this data directory.
    verify_registry_trust_manifest()
        .bytes(encoded.as_bytes())
        .root_public_key(root)
        .root_key_id(id)
        .call()
        .map_err(|e| e.to_string())?;
    match path.symlink_metadata() {
        Ok(_) => {
            let file = open_private(path, false)?;
            let mut bytes = Vec::new();
            (&file)
                .take(cadencr_registry_core::MAX_TRUST_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 > cadencr_registry_core::MAX_TRUST_MANIFEST_BYTES {
                return Err("registry trust generation exceeds its size limit".into());
            }
            validate_handle(path, &file)?;
            let previous = verify_registry_trust_manifest()
                .bytes(&bytes)
                .root_public_key(root)
                .root_key_id(id)
                .call()
                .map_err(|e| e.to_string())?;
            current
                .validate_successor(&previous)
                .map_err(|e| e.to_string())?;
            if current.generation() == previous.generation() {
                return Ok(());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    crate::shared::atomic_file::write_atomic_private(path, &encoded).map_err(|e| e.to_string())
}

fn open_private(path: &Path, create: bool) -> Result<File, String> {
    if let Ok(metadata) = path.symlink_metadata() {
        validate_file(&metadata)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    validate_handle(path, &file)?;
    Ok(file)
}

fn validate_handle(path: &Path, file: &File) -> Result<(), String> {
    let opened = file.metadata().map_err(|e| e.to_string())?;
    let named = path.symlink_metadata().map_err(|e| e.to_string())?;
    validate_file(&opened)?;
    validate_file(&named)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if opened.dev() != named.dev() || opened.ino() != named.ino() {
            return Err("registry trust generation file changed while opening".into());
        }
    }
    Ok(())
}

fn validate_file(metadata: &std::fs::Metadata) -> Result<(), String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("registry trust generation must be a regular private file".into());
    }
    validate_owner(metadata)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
            return Err("registry trust generation must be owner-only and not hard-linked".into());
        }
    }
    Ok(())
}

fn validate_owner(metadata: &std::fs::Metadata) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        // SAFETY: geteuid has no arguments or memory-safety preconditions.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("registry trust generation must belong to the service user".into());
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    Ok(())
}

fn inspect_parents(path: &Path) -> Result<(), String> {
    for parent in path.ancestors().skip(1) {
        match parent.symlink_metadata() {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err("registry trust generation parent contains a symbolic link".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use cadencr_registry_core::sign_registry_trust_manifest;
    use ed25519_dalek::SigningKey;
    use serde_json::json;
    use std::path::PathBuf;

    const ROOT_ID: &str = "offline-test-root";
    fn root() -> [u8; 32] {
        SigningKey::from_bytes(&[97; 32]).verifying_key().to_bytes()
    }
    fn directory() -> (tempfile::TempDir, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let canonical = temporary.path().canonicalize().unwrap();
        (temporary, canonical)
    }
    fn profile(directory: &Path, generation: u64, checkpoint: bool) -> VerifiedRegistryTrust {
        let payload = directory.join(format!("payload-{generation}-{checkpoint}.json"));
        let secret = directory.join(format!("root-{generation}-{checkpoint}.pem"));
        let manifest = json!({"schema_version":1,"kind":"registry-trust","generation":generation,
            "keys":[{"key_id":"catalog-test","public_key_base64": STANDARD.encode(SigningKey::from_bytes(&[23;32]).verifying_key().to_bytes())}],
            "revoked_key_ids":[],"recovery_catalog_sha256": if checkpoint { vec!["a".repeat(64)] } else { Vec::new() }});
        std::fs::write(&payload, serde_json::to_vec(&manifest).unwrap()).unwrap();
        // RFC 8410 Ed25519 PKCS#8: fixed ASN.1 prefix followed by the seed.
        let mut der = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        der.extend([97; 32]);
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(der)
        );
        crate::remote::secure_fs::write_secret(&secret, pem.as_bytes()).unwrap();
        let bytes = sign_registry_trust_manifest(&payload, &secret, ROOT_ID).unwrap();
        verify_registry_trust_manifest()
            .bytes(&bytes)
            .root_public_key(&root())
            .root_key_id(ROOT_ID)
            .call()
            .unwrap()
    }

    #[test]
    fn high_water_is_idempotent_advances_and_refuses_rollback_or_equivocation() {
        let (_temporary, directory) = directory();
        let path = directory.join("generation.json");
        let first = profile(&directory, 1, false);
        let second = profile(&directory, 2, false);
        advance(&path, &first, &root(), ROOT_ID).unwrap();
        let initial = std::fs::read(&path).unwrap();
        advance(&path, &first, &root(), ROOT_ID).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), initial);
        advance(&path, &second, &root(), ROOT_ID).unwrap();
        let latest = std::fs::read(&path).unwrap();
        assert!(advance(&path, &first, &root(), ROOT_ID)
            .unwrap_err()
            .contains("rollback"));
        assert!(
            advance(&path, &profile(&directory, 2, true), &root(), ROOT_ID)
                .unwrap_err()
                .contains("equivocation")
        );
        assert_eq!(std::fs::read(&path).unwrap(), latest);
        assert!(advance(&path, &second, &[23; 32], ROOT_ID).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), latest);
    }

    #[test]
    fn corrupted_or_oversized_floor_is_not_repaired_by_a_new_manifest() {
        let (_temporary, directory) = directory();
        let path = directory.join("generation.json");
        let next = profile(&directory, 3, false);
        let mut altered = serde_json::to_value(profile(&directory, 2, false).envelope()).unwrap();
        altered["signed"]["generation"] = json!(1);
        for bytes in [
            serde_json::to_vec(&altered).unwrap(),
            b"{invalid}".to_vec(),
            vec![b'x'; cadencr_registry_core::MAX_TRUST_MANIFEST_BYTES as usize + 1],
        ] {
            crate::remote::secure_fs::write_secret(&path, &bytes).unwrap();
            assert!(advance(&path, &next, &root(), ROOT_ID).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[cfg(unix)]
    #[test]
    fn persisted_files_are_private_and_loose_files_or_hardlinks_fail_closed() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_temporary, directory) = directory();
        let path = directory.join("state/generation.json");
        let first = profile(&directory, 1, false);
        advance(&path, &first, &root(), ROOT_ID).unwrap();
        let lock = path.parent().unwrap().join(".generation.json.lock");
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(lock.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            path.parent()
                .unwrap()
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(advance(&path, &first, &root(), ROOT_ID).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&path, directory.join("linked-floor")).unwrap();
        assert!(advance(&path, &first, &root(), ROOT_ID).is_err());
        std::fs::hard_link(&lock, directory.join("linked-lock")).unwrap();
        assert!(advance(&path, &first, &root(), ROOT_ID).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_for_floor_lock_or_parent_never_modify_their_targets() {
        use std::os::unix::fs::symlink;
        for kind in ["floor", "lock", "parent"] {
            let (_temporary, directory) = directory();
            let first = profile(&directory, 1, false);
            let protected = directory.join("protected");
            crate::remote::secure_fs::write_secret(&protected, b"unchanged").unwrap();
            let path = directory.join("state/generation.json");
            std::fs::create_dir(path.parent().unwrap()).unwrap();
            if kind == "floor" {
                symlink(&protected, &path).unwrap();
            }
            if kind == "lock" {
                symlink(
                    &protected,
                    path.parent().unwrap().join(".generation.json.lock"),
                )
                .unwrap();
            }
            let path = if kind == "parent" {
                symlink(path.parent().unwrap(), directory.join("linked-parent")).unwrap();
                directory.join("linked-parent/generation.json")
            } else {
                path
            };
            assert!(advance(&path, &first, &root(), ROOT_ID).is_err());
            assert_eq!(std::fs::read(&protected).unwrap(), b"unchanged");
        }
    }

    #[test]
    fn cross_process_worker() {
        let Some(directory) = std::env::var_os("CADENCR_TRUST_FLOOR_TEST_CHILD") else {
            return;
        };
        let directory = PathBuf::from(directory);
        let current = profile(&directory, 2, false);
        let probe = open_private(&directory.join(".generation.json.lock"), true).unwrap();
        assert!(matches!(
            probe.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(probe);
        std::fs::write(directory.join("child-ready"), b"ready").unwrap();
        assert!(advance(
            &directory.join("generation.json"),
            &current,
            &root(),
            ROOT_ID
        )
        .unwrap_err()
        .contains("rollback"));
    }

    #[test]
    fn cross_process_transaction_rechecks_the_floor_after_waiting_for_lock() {
        let (_temporary, directory) = directory();
        let path = directory.join("generation.json");
        advance(&path, &profile(&directory, 1, false), &root(), ROOT_ID).unwrap();
        let lock = open_private(&directory.join(".generation.json.lock"), true).unwrap();
        lock.lock().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!(
                    "{}::cross_process_worker",
                    module_path!().split_once("::").unwrap().1
                ),
                "--nocapture",
            ])
            .env("CADENCR_TRUST_FLOOR_TEST_CHILD", &directory)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !directory.join("child-ready").exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before reaching transaction"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "child did not reach transaction"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert!(
            child.try_wait().unwrap().is_none(),
            "child must wait for the OS lock"
        );
        advance_locked(&path, &profile(&directory, 3, false), &root(), ROOT_ID).unwrap();
        drop(lock);
        assert!(child.wait().unwrap().success());
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(stored["signed"]["generation"], 3);
    }
}
