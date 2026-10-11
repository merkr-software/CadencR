mod admission;
use super::{
    journal, PublicationOperation, PublicationOperationKind, PublicationOperationResult,
    PublicationOperationStatus,
};
use crate::error::AppError;
use admission::{begin, classify};
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

fn active() -> &'static Mutex<HashSet<PathBuf>> {
    static ACTIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ACTIVE.get_or_init(Default::default)
}
pub(super) fn is_active(root: &Path, id: &str) -> bool {
    active()
        .lock()
        .is_ok_and(|active| active.contains(&root.join(id)))
}
struct Active(PathBuf);
impl Drop for Active {
    fn drop(&mut self) {
        if let Ok(mut active) = active().lock() {
            active.remove(&self.0);
        }
    }
}

#[bon::builder]
pub fn execute<F>(
    project_id: i64,
    kind: PublicationOperationKind,
    operation_id: String,
    plan_sha256: String,
    job: F,
) -> impl Future<Output = Result<PublicationOperationResult, AppError>> + Send
where
    F: Future<Output = Result<PublicationOperationResult, AppError>> + Send + 'static,
{
    // Heap-own the worker before constructing the durable orchestration future.
    let job = Box::pin(job);
    async move {
        let root = journal::root(project_id)?;
        execute_at(root, project_id, kind, operation_id, plan_sha256, job).await
    }
}

fn execute_at<F>(
    root: PathBuf,
    project_id: i64,
    kind: PublicationOperationKind,
    id: String,
    plan_sha256: String,
    job: F,
) -> impl Future<Output = Result<PublicationOperationResult, AppError>> + Send
where
    F: Future<Output = Result<PublicationOperationResult, AppError>> + Send + 'static,
{
    let job = Box::pin(job);
    async move {
        let (mut operation, guard) = begin(&root, project_id, kind, &id, plan_sha256)?;
        if let Some(result) = operation.result.take() {
            return Ok(result);
        }
        let guard = guard.ok_or_else(journal::storage)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _guard = guard;
            let outcome = match tokio::spawn(job).await {
                Ok(outcome) => outcome,
                Err(_) => Err(AppError::coded(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "PUBLICATION_OPERATION_INTERRUPTED",
                    "Publication worker stopped; the outcome is unknown.",
                )),
            };
            operation.updated_at = chrono::Utc::now().to_rfc3339();
            match &outcome {
                Ok(result) => {
                    operation.status = PublicationOperationStatus::Succeeded;
                    operation.result = Some(result.clone());
                }
                Err(error) => {
                    let (mut status, code) = classify(error);
                    if operation.attempt > 1 {
                        status = PublicationOperationStatus::Unknown;
                    }
                    operation.status = status;
                    operation.error_code = Some(code);
                    operation.error = Some(if status == PublicationOperationStatus::Failed { "The operation was rejected before publication." } else { "The remote outcome is unknown. Reconcile this same confirmed operation before retrying." }.into());
                }
            }
            let persisted = journal::lock()
                .lock()
                .map_err(|_| journal::storage())
                .and_then(|_lock| journal::write(&root, &operation));
            // Persistence failure is returned, not logged-and-swallowed. Once this
            // worker exits, GET converts the still-running journal to unknown.
            let response = persisted.and(outcome);
            if let Err(Err(error)) = sender.send(response) {
                tracing::warn!(%error, operation_id = %id, "detached publication outcome is available through operation status");
            }
        });
        receiver.await.map_err(|_| journal::storage())?
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::publication_release::PublishedProviderRelease;
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn result() -> PublicationOperationResult {
        PublicationOperationResult::Release(PublishedProviderRelease {
            release_url: "https://github.com/acme/repo/releases/tag/v1".into(),
            repository: "acme/repo".into(),
            tag: "v1".into(),
            source_commit: "a".repeat(40),
            archive_sha256: "b".repeat(64),
            already_published: false,
        })
    }

    #[test]
    fn large_worker_futures_stay_heap_owned_on_default_sized_runtime_stacks() {
        struct LargeJob([u8; 512 * 1024]);
        impl Future for LargeJob {
            type Output = Result<PublicationOperationResult, AppError>;
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Self::Output> {
                assert_eq!(self.0[0], 7);
                std::task::Poll::Ready(Ok(result()))
            }
        }
        std::thread::Builder::new()
            .stack_size(8 * 1024 * 1024)
            .spawn(|| {
                let root = tempfile::tempdir().unwrap();
                let job = execute_at(
                    root.path().into(),
                    1,
                    PublicationOperationKind::Release,
                    "a".repeat(64),
                    "b".repeat(64),
                    LargeJob([7; 512 * 1024]),
                );
                assert!(
                    std::mem::size_of_val(&job) < 4096,
                    "durable future must not embed worker state"
                );
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .thread_stack_size(2 * 1024 * 1024)
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async {
                    tokio::spawn(job).await.unwrap().unwrap();
                });
                assert_eq!(
                    journal::read(root.path(), &"a".repeat(64))
                        .unwrap()
                        .unwrap()
                        .status,
                    PublicationOperationStatus::Succeeded
                );
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[tokio::test]
    async fn disconnect_does_not_cancel_and_success_is_cached_without_a_second_job() {
        let root = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let (finish, wait) = tokio::sync::oneshot::channel();
        let path = root.path().to_owned();
        let worker_calls = calls.clone();
        let request = tokio::spawn(execute_at(
            path.clone(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async move {
                worker_calls.fetch_add(1, Ordering::SeqCst);
                wait.await.unwrap();
                Ok(result())
            },
        ));
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        request.abort();
        let duplicate = execute_at(
            path.clone(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async { panic!("duplicate mutation must not run") },
        )
        .await;
        assert!(matches!(
            duplicate,
            Err(AppError::Coded {
                code: "PUBLICATION_OPERATION_RUNNING",
                ..
            })
        ));
        finish.send(()).unwrap();
        loop {
            let status = {
                let _lock = journal::lock().lock().unwrap();
                journal::read(&path, &"a".repeat(64))
                    .unwrap()
                    .unwrap()
                    .status
            };
            if status == PublicationOperationStatus::Succeeded {
                break;
            }
            tokio::task::yield_now().await;
        }
        execute_at(
            path,
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async { panic!("cached mutation must not run") },
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ambiguous_errors_are_unknown_and_retry_reconciles_the_same_id() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_owned();
        let id = "a".repeat(64);
        let error = execute_at(
            path.clone(),
            1,
            PublicationOperationKind::Release,
            id.clone(),
            "b".repeat(64),
            async {
                Err(AppError::coded(
                    axum::http::StatusCode::GATEWAY_TIMEOUT,
                    "PUBLICATION_RELEASE_TIMEOUT",
                    "SECRET-TOKEN never persist this message",
                ))
            },
        )
        .await;
        assert!(error.is_err());
        let record = journal::read(&path, &id).unwrap().unwrap();
        assert_eq!(record.status, PublicationOperationStatus::Unknown);
        assert!(!std::fs::read_to_string(path.join(format!("{id}.json")))
            .unwrap()
            .contains("SECRET-TOKEN"));
        execute_at(
            path.clone(),
            1,
            PublicationOperationKind::Release,
            id.clone(),
            "b".repeat(64),
            async { Ok(result()) },
        )
        .await
        .unwrap();
        let record = journal::read(&path, &id).unwrap().unwrap();
        assert_eq!(record.status, PublicationOperationStatus::Succeeded);
        assert_eq!(record.attempt, 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn persistence_failure_is_visible_and_corrupt_journal_prevents_retry_mutation() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_owned();
        let record = path.join(format!("{}.json", "a".repeat(64)));
        let protected = path.join("protected");
        std::fs::write(&protected, b"foreign").unwrap();
        let failure = execute_at(
            path.clone(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async move {
                std::fs::remove_file(record.clone()).unwrap();
                symlink(protected, record).unwrap();
                Ok(result())
            },
        )
        .await;
        assert!(matches!(
            failure,
            Err(AppError::Coded {
                code: "PUBLICATION_OPERATION_STORAGE_FAILED",
                ..
            })
        ));
        assert!(journal::read(&path, &"a".repeat(64)).is_err());
        assert!(execute_at(
            path.clone(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async { panic!("invalid journal must prevent retry mutation") }
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(path.join("protected")).unwrap(), b"foreign");
    }

    #[tokio::test]
    async fn a_panicked_worker_is_recorded_as_unknown() {
        let root = tempfile::tempdir().unwrap();
        assert!(execute_at(
            root.path().into(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async { panic!("worker crash") }
        )
        .await
        .is_err());
        assert_eq!(
            journal::read(root.path(), &"a".repeat(64))
                .unwrap()
                .unwrap()
                .status,
            PublicationOperationStatus::Unknown
        );
    }
}
