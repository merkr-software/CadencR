use std::path::PathBuf;

use crate::domain::agents::providers::installed::managed::installer::{
    commit_staged_revision, verify_rollback_candidate, ManagedStorage,
};
use crate::domain::agents::providers::installed::managed::receipt::{
    hash_regular_file, payload_manifest, ManagedPackageReceipt, ManagedPayloadFile, ManagedRevision,
};
use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;
use crate::error::AppError;

pub(super) async fn manifest(path: PathBuf) -> Result<Vec<ManagedPayloadFile>, AppError> {
    spawn("build managed payload manifest", move || {
        payload_manifest(&path)
    })
    .await
}

pub(super) async fn hash_file(path: PathBuf) -> Result<String, AppError> {
    spawn("hash managed payload file", move || {
        hash_regular_file(&path)
    })
    .await
}

pub(super) async fn commit_revision(
    storage: ManagedStorage,
    staging: PathBuf,
    receipt: ManagedPackageReceipt,
) -> Result<PathBuf, AppError> {
    spawn("commit managed revision", move || {
        commit_staged_revision(&storage, &staging, &receipt)
    })
    .await
}

pub(super) async fn rollback_candidate(
    storage: ManagedStorage,
    provider_id: String,
    revision: ManagedRevision,
    trust_store: ManagedTrustStore,
) -> Result<ManagedPackageReceipt, AppError> {
    spawn("verify managed rollback candidate", move || {
        verify_rollback_candidate(&storage, &provider_id, &revision, &trust_store)
    })
    .await
}

async fn spawn<T: Send + 'static>(
    operation: &'static str,
    task: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| AppError::Internal(format!("{operation} task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_work_does_not_stall_the_runtime_thread() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let task = tokio::spawn(spawn("test blocking work", move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(2))
                .map_err(|error| AppError::Internal(error.to_string()))
        }));
        tokio::time::timeout(Duration::from_secs(1), ready)
            .await
            .expect("runtime must keep polling while filesystem work blocks")
            .unwrap();
        release.send(42).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), 42);
    }

    #[tokio::test]
    async fn worker_failure_preserves_the_operation_error() {
        let error = spawn::<()>("test failure", || {
            Err(AppError::coded(
                axum::http::StatusCode::CONFLICT,
                "MANAGED_PAYLOAD_TAMPERED",
                "fixture was changed",
            ))
        })
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: "MANAGED_PAYLOAD_TAMPERED",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn worker_panic_is_returned_as_an_operation_failure() {
        let error = spawn::<()>("test panic", || panic!("fixture worker panic"))
            .await
            .unwrap_err();
        assert!(
            matches!(error, AppError::Internal(message) if message.contains("test panic task failed"))
        );
    }
}
