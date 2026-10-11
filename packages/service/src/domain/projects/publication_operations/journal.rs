use super::{identity::valid_id, PublicationOperation, PublicationOperationStatus};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

pub(super) const MAX_RECORD_BYTES: u64 = 64 * 1024;
pub(super) fn lock(root: &Path) -> Result<Arc<Mutex<()>>, AppError> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| storage())?;
    // Completed project transactions leave no retained lock or growing key set.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(root.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}
pub(super) fn boot_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
pub(super) async fn root(project_id: i64) -> Result<PathBuf, AppError> {
    let parent = crate::domain::settings_store::dir::sibling_dir("publication-operations");
    tokio::task::spawn_blocking(move || {
        ensure_root(&parent)?;
        Ok(parent.join(project_id.to_string()))
    })
    .await
    .map_err(|_| storage())?
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    schema_version: u8,
    boot_id: String,
    operation: PublicationOperation,
}

pub(super) fn ensure_root(root: &Path) -> Result<(), AppError> {
    if let Ok(metadata) = std::fs::symlink_metadata(root) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(storage());
        }
    }
    crate::remote::secure_fs::create_dir_owner_only(root).map_err(|_| storage())
}

pub(super) fn read(root: &Path, id: &str) -> Result<Option<PublicationOperation>, AppError> {
    if !valid_id(id) {
        return Err(AppError::BadRequest(
            "invalid publication operation ID".into(),
        ));
    }
    match std::fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage()),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(storage())
        }
        Ok(_) => ensure_root(root)?,
    }
    let path = root.join(format!("{id}.json"));
    let metadata = match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage()),
        Ok(metadata) => metadata,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err(storage());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&path).map_err(|_| storage())?;
    if !file.metadata().map_err(|_| storage())?.is_file() {
        return Err(storage());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| storage())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err(storage());
    }
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|_| storage())?;
    if stored.schema_version != 1
        || stored.operation.operation_id != id
        || !valid_id(&stored.operation.plan_sha256)
    {
        return Err(storage());
    }
    validate_record(&stored.operation)?;
    let mut operation = stored.operation;
    if matches!(
        operation.status,
        PublicationOperationStatus::Pending | PublicationOperationStatus::Running
    ) && (stored.boot_id != boot_id() || !super::runner::is_active(root, id))
    {
        operation.status = PublicationOperationStatus::Unknown;
        operation.error_code = Some("PUBLICATION_OPERATION_INTERRUPTED".into());
        operation.error = Some("The service stopped before the outcome was recorded. Reconcile the same confirmed operation before retrying.".into());
        write(root, &operation)?;
    }
    Ok(Some(operation))
}

fn validate_record(operation: &PublicationOperation) -> Result<(), AppError> {
    if operation.attempt == 0
        || chrono::DateTime::parse_from_rfc3339(&operation.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&operation.updated_at).is_err()
        || (operation.status == PublicationOperationStatus::Succeeded) != operation.result.is_some()
    {
        return Err(storage());
    }
    if let Some(result) = &operation.result {
        if !matches!(
            (operation.kind, result),
            (
                super::PublicationOperationKind::Release,
                super::PublicationOperationResult::Release(_)
            ) | (
                super::PublicationOperationKind::Registry,
                super::PublicationOperationResult::Registry(_)
            )
        ) {
            return Err(storage());
        }

        let value = match result {
            super::PublicationOperationResult::Release(value) => &value.release_url,
            super::PublicationOperationResult::Registry(value) => &value.pull_request_url,
        };
        let url = reqwest::Url::parse(value).map_err(|_| storage())?;
        if value.len() > 2048
            || url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(storage());
        }
    }
    Ok(())
}

pub(super) fn write(root: &Path, operation: &PublicationOperation) -> Result<(), AppError> {
    ensure_root(root)?;
    validate_record(operation)?;
    let bytes = serde_json::to_vec(&Stored {
        schema_version: 1,
        boot_id: boot_id().into(),
        operation: operation.clone(),
    })
    .map_err(|_| storage())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err(storage());
    }
    let path = root.join(format!("{}.json", operation.operation_id));
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(storage());
        }
    }
    let content = std::str::from_utf8(&bytes).map_err(|_| storage())?;
    crate::shared::atomic_file::write_atomic_private(&path, content).map_err(|_| storage())
}

pub(super) fn storage() -> AppError {
    AppError::coded(axum::http::StatusCode::SERVICE_UNAVAILABLE,
    "PUBLICATION_OPERATION_STORAGE_FAILED", "The publication operation journal is unavailable or invalid. The remote outcome may be unknown; inspect operation status and remote publication before retrying.")
}

#[cfg(test)]
mod tests {
    use super::super::PublicationOperationKind;
    use super::*;
    #[test]
    fn project_locks_share_only_while_owned_and_do_not_retain_completed_roots() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let first = lock(root.path()).unwrap();
        let repeated = lock(root.path()).unwrap();
        let independent = lock(other.path()).unwrap();
        assert!(Arc::ptr_eq(&first, &repeated));
        assert!(!Arc::ptr_eq(&first, &independent));
        let weak = Arc::downgrade(&first);
        drop(first);
        drop(repeated);
        assert!(weak.upgrade().is_none());
        assert!(!Arc::ptr_eq(&lock(root.path()).unwrap(), &independent));
    }

    fn operation() -> PublicationOperation {
        PublicationOperation {
            operation_id: "a".repeat(64),
            project_id: 1,
            kind: PublicationOperationKind::Release,
            plan_sha256: "b".repeat(64),
            status: PublicationOperationStatus::Running,
            attempt: 1,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            result: None,
            error_code: None,
            error: None,
        }
    }
    #[test]
    fn stale_running_operations_become_unknown_and_corruption_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let operation = operation();
        write(root.path(), &operation).unwrap();
        let path = root.path().join(format!("{}.json", operation.operation_id));
        let mut stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        stored["boot_id"] = "prior-boot".into();
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        assert_eq!(
            read(root.path(), &operation.operation_id)
                .unwrap()
                .unwrap()
                .status,
            PublicationOperationStatus::Unknown
        );
        let valid = std::fs::read_to_string(&path).unwrap();
        let duplicate = valid.replacen(
            "\"schema_version\":1",
            "\"schema_version\":1,\"schema_version\":1",
            1,
        );
        std::fs::write(&path, duplicate).unwrap();
        assert!(read(root.path(), &operation.operation_id).is_err());
        for bytes in [
            b"{}".to_vec(),
            b"{\"schema_version\":1,\"schema_version\":1}".to_vec(),
            vec![b'x'; MAX_RECORD_BYTES as usize + 1],
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(read(root.path(), &operation.operation_id).is_err());
        }
    }
    #[test]
    fn cached_result_presence_kind_and_timestamps_are_validated() {
        let root = tempfile::tempdir().unwrap();
        let operation = operation();
        write(root.path(), &operation).unwrap();
        let path = root.path().join(format!("{}.json", operation.operation_id));
        let original: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        for mutation in 0..3 {
            let mut stored = original.clone();
            match mutation {
                0 => stored["operation"]["status"] = "succeeded".into(),
                1 => stored["operation"]["updated_at"] = "invalid".into(),
                _ => {
                    stored["operation"]["status"] = "succeeded".into();
                    stored["operation"]["result"] = serde_json::json!({"kind":"registry", "value":{"pull_request_url":"https://github.com/acme/repo/pull/1","pull_request_number":1,"branch":"review","reused":false}});
                }
            }
            std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
            assert!(read(root.path(), &operation.operation_id).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn journal_files_are_owner_only_and_symlinks_are_never_followed() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let operation = operation();
        write(root.path(), &operation).unwrap();
        let path = root.path().join(format!("{}.json", operation.operation_id));
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(&path).unwrap();
        let protected = root.path().join("protected");
        std::fs::write(&protected, b"unchanged").unwrap();
        symlink(&protected, &path).unwrap();
        assert!(read(root.path(), &operation.operation_id).is_err());
        assert!(write(root.path(), &operation).is_err());
        assert_eq!(std::fs::read(protected).unwrap(), b"unchanged");
    }
}
