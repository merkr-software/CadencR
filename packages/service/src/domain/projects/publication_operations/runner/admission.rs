use super::{
    active, is_active, journal, Active, PublicationOperation, PublicationOperationKind,
    PublicationOperationStatus,
};
use crate::error::AppError;
use std::path::Path;

pub(super) fn begin(
    root: &Path,
    project_id: i64,
    kind: PublicationOperationKind,
    id: &str,
    plan_sha256: String,
) -> Result<(PublicationOperation, Option<Active>), AppError> {
    let lock = journal::lock(root)?;
    let _lock = lock.lock().map_err(|_| journal::storage())?;
    let prior = journal::read(root, id)?;
    if let Some(prior) = &prior {
        if prior.project_id != project_id || prior.kind != kind || prior.plan_sha256 != plan_sha256
        {
            return Err(journal::storage());
        }
        if prior.status == PublicationOperationStatus::Succeeded {
            return Ok((prior.clone(), None));
        }
        if is_active(root, id) {
            return Err(AppError::coded(axum::http::StatusCode::CONFLICT, "PUBLICATION_OPERATION_RUNNING", format!("Publication operation {id} is already running. Query its status instead of starting another.")));
        }
    }
    journal::ensure_root(root)?;
    if prior.is_none()
        && std::fs::read_dir(root)
            .map_err(|_| journal::storage())?
            .take(10_001)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| journal::storage())?
            .len()
            >= 10_000
    {
        return Err(journal::storage());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut operation = PublicationOperation {
        operation_id: id.into(),
        project_id,
        kind,
        plan_sha256,
        status: PublicationOperationStatus::Pending,
        attempt: prior
            .as_ref()
            .map_or(1, |value| value.attempt.saturating_add(1)),
        created_at: prior.map_or_else(|| now.clone(), |value| value.created_at),
        updated_at: now,
        result: None,
        error_code: None,
        error: None,
    };
    let path = root.join(id);
    active()
        .lock()
        .map_err(|_| journal::storage())?
        .insert(path.clone());
    let guard = Active(path);
    journal::write(root, &operation)?;
    operation.status = PublicationOperationStatus::Running;
    journal::write(root, &operation)?;
    Ok((operation, Some(guard)))
}

pub(super) fn classify(error: &AppError) -> (PublicationOperationStatus, String) {
    let code = match error {
        AppError::Coded { code, .. } => *code,
        _ => "PUBLICATION_OPERATION_UNKNOWN",
    };
    // Only named local admission/plan checks prove no mutation was attempted.
    // Final remote tag mismatch can happen after writes, so remains unknown.
    let definitive = matches!(
        code,
        "PUBLICATION_RELEASE_PLAN_CHANGED"
            | "PUBLICATION_REGISTRY_PLAN_CHANGED"
            | "PUBLICATION_RELEASE_BUSY"
    );
    (
        if definitive {
            PublicationOperationStatus::Failed
        } else {
            PublicationOperationStatus::Unknown
        },
        code.into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    fn hold_lock(root: PathBuf) -> (std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let (ready, acquired) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let lock = journal::lock(&root).unwrap();
            let _guard = lock.lock().unwrap();
            ready.send(()).unwrap();
            // Watchdog also releases the lock if a regression blocks the runtime.
            let _ = wait.recv_timeout(Duration::from_secs(5));
        });
        acquired.recv_timeout(Duration::from_secs(1)).unwrap();
        (release, thread)
    }

    fn result() -> super::super::PublicationOperationResult {
        super::super::PublicationOperationResult::Release(
            crate::domain::projects::publication_release::PublishedProviderRelease {
                release_url: "https://github.com/acme/repo/releases/tag/v1".into(),
                repository: "acme/repo".into(),
                tag: "v1".into(),
                source_commit: "a".repeat(40),
                archive_sha256: "b".repeat(64),
                already_published: false,
            },
        )
    }

    async fn unrelated_project_progresses(root: PathBuf) {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let query = crate::domain::projects::publication_operations::routes::get_publication_operation_handler(
            axum::extract::Path((2, "f".repeat(64))),
        ).await;
        assert!(matches!(query, Err(AppError::NotFound(_))));
        super::super::execute_at(
            root,
            2,
            PublicationOperationKind::Release,
            "c".repeat(64),
            "d".repeat(64),
            async { Ok(result()) },
        )
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn disconnect_during_admission_still_runs_and_persists_the_job() {
        let root = tempfile::tempdir().unwrap();
        let (release, holder) = hold_lock(root.path().into());
        let (finished, completion) = tokio::sync::oneshot::channel();
        let request = tokio::spawn(super::super::execute_at(
            root.path().into(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async move {
                finished.send(()).unwrap();
                Ok(result())
            },
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        request.abort();
        let _ = release.send(());
        holder.join().unwrap();
        tokio::time::timeout(Duration::from_secs(1), completion)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let path = root.path().to_owned();
                let status = tokio::task::spawn_blocking(move || {
                    let lock = journal::lock(&path).unwrap();
                    let _guard = lock.lock().unwrap();
                    journal::read(&path, &"a".repeat(64))
                        .unwrap()
                        .unwrap()
                        .status
                })
                .await
                .unwrap();
                if status == PublicationOperationStatus::Succeeded {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn blocked_admission_keeps_runtime_and_other_projects_responsive() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let (release, holder) = hold_lock(root.path().into());
        let operation = tokio::spawn(super::super::execute_at(
            root.path().into(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async { Ok(result()) },
        ));
        let progress = tokio::time::timeout(
            Duration::from_secs(1),
            unrelated_project_progresses(other.path().into()),
        )
        .await;
        let still_waiting = !operation.is_finished();
        let _ = release.send(());
        holder.join().unwrap();
        assert!(
            progress.is_ok(),
            "journal admission blocked the async worker"
        );
        assert!(
            still_waiting,
            "admission must wait for its project transaction"
        );
        operation.await.unwrap().unwrap();
        assert_eq!(
            journal::read(root.path(), &"a".repeat(64))
                .unwrap()
                .unwrap()
                .status,
            PublicationOperationStatus::Succeeded
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn blocked_completion_keeps_runtime_and_other_projects_responsive() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let (started, admitted) = tokio::sync::oneshot::channel();
        let (finish, wait) = tokio::sync::oneshot::channel();
        let operation = tokio::spawn(super::super::execute_at(
            root.path().into(),
            1,
            PublicationOperationKind::Release,
            "a".repeat(64),
            "b".repeat(64),
            async move {
                started.send(()).unwrap();
                wait.await.unwrap();
                Ok(result())
            },
        ));
        admitted.await.unwrap();
        let (release, holder) = hold_lock(root.path().into());
        finish.send(()).unwrap();
        let progress = tokio::time::timeout(
            Duration::from_secs(1),
            unrelated_project_progresses(other.path().into()),
        )
        .await;
        let still_waiting = !operation.is_finished();
        let _ = release.send(());
        holder.join().unwrap();
        assert!(
            progress.is_ok(),
            "journal completion blocked the async worker"
        );
        assert!(
            still_waiting,
            "success must wait for durable journal completion"
        );
        operation.await.unwrap().unwrap();
        assert_eq!(
            journal::read(root.path(), &"a".repeat(64))
                .unwrap()
                .unwrap()
                .status,
            PublicationOperationStatus::Succeeded
        );
    }
}
