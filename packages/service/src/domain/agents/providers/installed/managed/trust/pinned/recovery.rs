//! The way out of a stored trust generation that cannot be read: the user
//! sets it aside — it is renamed beside itself, never deleted — and the
//! generation is rebuilt from this build's own root-signed trust.
use super::*;
use crate::error::AppError;
use axum::http::StatusCode;

#[derive(Debug, Clone)]
pub struct SetAsideGeneration {
    /// Where the faulty file now is, untouched.
    pub kept_at: PathBuf,
    pub status: PinnedIndexTrustStatus,
}

/// Set the unreadable stored generation aside and rebuild trust. Refused
/// unless the current status offers exactly that recovery.
pub async fn set_aside_registry_trust_generation() -> Result<SetAsideGeneration, AppError> {
    static RECOVERING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = RECOVERING.lock().await;
    let PinnedIndexTrustStatus::Invalid {
        recovery: TrustRecovery::SetAside { path },
        ..
    } = pinned_index_trust_status()
    else {
        return Err(AppError::coded(
            StatusCode::CONFLICT,
            "TRUST_RECOVERY_NOT_APPLICABLE",
            "registry trust has no unreadable generation file to set aside",
        ));
    };
    let kept_at = tokio::task::spawn_blocking({
        let path = path.clone();
        move || set_aside(&path)
    })
    .await
    .map_err(|error| AppError::internal(format!("registry trust recovery failed: {error}")))??;
    let status = tokio::task::spawn_blocking(move || resolve(&path))
        .await
        .map_err(|error| AppError::internal(format!("registry trust recovery failed: {error}")))?;
    *STATUS
        .write()
        .map_err(|_| AppError::internal("registry trust status lock is poisoned"))? =
        Some(status.clone());
    Ok(SetAsideGeneration { kept_at, status })
}

/// Rename `path` to `<name>.invalid-<UTC time>` beside it, under the
/// generation's lock and atomically never over an existing file.
fn set_aside(path: &Path) -> Result<PathBuf, AppError> {
    let conflict =
        |message: String| AppError::coded(StatusCode::CONFLICT, "TRUST_RECOVERY_FAILED", message);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::internal("invalid trust generation filename"))?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal("trust generation path has no parent"))?;
    let _lock = super::state::lock(parent, name).map_err(conflict)?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6fZ");
    let kept_at = path.with_file_name(format!("{name}.invalid-{stamp}"));
    crate::shared::no_replace_rename::rename_no_replace(path, &kept_at).map_err(|error| {
        conflict(format!(
            "cannot set {} aside as {}: {error}",
            path.display(),
            kept_at.display()
        ))
    })?;
    Ok(kept_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_aside_keeps_the_faulty_file_byte_for_byte_beside_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("generation.json");
        std::fs::write(&path, b"{ not a generation").unwrap();
        let kept_at = set_aside(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(kept_at.parent(), path.parent());
        assert!(kept_at
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("generation.json.invalid-")));
        assert_eq!(std::fs::read(&kept_at).unwrap(), b"{ not a generation");
    }

    #[test]
    fn a_missing_file_cannot_be_set_aside() {
        let directory = tempfile::tempdir().unwrap();
        assert!(set_aside(&directory.path().join("generation.json")).is_err());
    }
}
