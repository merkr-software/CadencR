//! Atomically retire an idle runtime against pending prompt deliveries.

use super::super::helpers::persist_and_close_runtime;
use super::super::QueryState;
use super::stream_reader_resume::pending_options;
use super::stream_reader_task::StreamReaderTask;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::WsSessionPersistence;

pub(super) async fn retire_unobserved_runtime(task: &StreamReaderTask) -> bool {
    // Delivery selection acquires its lease under this same per-session lock.
    // It protects preflight work before a runtime read lock or running status.
    let mut sessions = task.sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&task.db_session_id) else {
        return false;
    };
    let QueryState::Active { query, .. } = &handle.state else {
        return false;
    };
    if handle.identity.has_pending_delivery()
        || task
            .runtime_session_handle
            .as_ref()
            .is_some_and(|expected| {
                !std::sync::Weak::ptr_eq(&std::sync::Arc::downgrade(query), expected)
            })
        || !task
            .feature_senders
            .get_senders(task.feature_id)
            .await
            .is_empty()
        || turn_needs_runtime(task).await
    {
        return false;
    }
    let query = query.clone();
    let mut runtime = query.write().await;
    // A provider read can have delayed the writer since the first DB check.
    // Validate again while holding the writer before closing this exact runtime.
    if turn_needs_runtime(task).await {
        return false;
    }
    handle.runtime_control_endpoint = runtime.runtime_control_endpoint();
    let resume_id = persist_and_close_runtime(
        runtime.as_mut(),
        &task.app_state,
        task.db_session_id,
        &task.runtime_provider,
        task.feature_id,
    )
    .await;
    drop(runtime);
    // Do not expose a closed Active handle to a delivery waiting on this cell.
    // A later command takes the Pending path and resumes in a fresh process.
    handle.state = QueryState::Pending(pending_options(handle, resume_id));
    WsSessionPersistence::mark_completed_static(&task.write_pool, task.db_session_id).await;
    WsSessionPersistence::broadcast_session_status(
        &task.session_status_tx,
        task.db_session_id,
        task.feature_id,
        AgentStatus::Idle,
        None,
    );
    true
}

async fn turn_needs_runtime(task: &StreamReaderTask) -> bool {
    WsSessionPersistence::get_session_row(&task.write_pool, task.db_session_id)
        .await
        .is_some_and(|row| row.status == "running" || row.has_pending_user_input())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimePermissionMode,
        RuntimeSessionHandle,
    };
    use crate::domain::ws_session::handler::tests::support::{
        insert_running_session, make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::runtime::output::SessionOutput;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::sync::{mpsc, RwLock};

    struct IdleRuntime(Arc<AtomicBool>);

    #[async_trait::async_trait]
    impl AgentRuntimeSession for IdleRuntime {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            mpsc::channel(1).1
        }
        async fn session_id(&self) -> Option<String> {
            Some("11111111-1111-4111-8111-111111111111".into())
        }
        async fn stream_input(&self, _: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn close(&mut self) -> Result<(), RuntimeError> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn set_model(&self, _: &str) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_permission_mode(&self, _: RuntimePermissionMode) -> Result<(), RuntimeError> {
            Ok(())
        }
        fn pid(&self) -> Option<u32> {
            None
        }
    }

    async fn idle_task() -> (StreamReaderTask, RuntimeSessionHandle, Arc<AtomicBool>) {
        let state = make_test_app_state().await;
        let id = 17;
        insert_running_session(&state, id, 1).await;
        WsSessionPersistence::mark_completed_static(&state.write_pool, id).await;
        let cell = super::super::super::state::new_sdk_sessions();
        let closed = Arc::new(AtomicBool::new(false));
        let query: RuntimeSessionHandle =
            Arc::new(RwLock::new(Box::new(IdleRuntime(closed.clone()))));
        let mut handle = make_active_handle(1, None);
        let QueryState::Active { query: current, .. } = &mut handle.state else {
            unreachable!()
        };
        *current = query.clone();
        cell.lock().await.insert(id, handle);
        let task = StreamReaderTask {
            db_session_id: id,
            feature_id: 1,
            persistence_reader_id: 0,
            message_rx: mpsc::channel(1).1,
            runtime_session_handle: Some(Arc::downgrade(&query)),
            sender: SessionOutput::headless(),
            feature_senders: state.ws_feature_senders.clone(),
            write_pool: state.write_pool.clone(),
            session_status_tx: state.session_status_tx.clone(),
            sdk_sessions: cell,
            runtime_provider: "claude_code".into(),
            provider_context_window: None,
            app_state: state,
            cleanup_session_on_end: false,
        };
        (task, query, closed)
    }

    #[tokio::test]
    async fn selected_delivery_keeps_idle_runtime_alive_during_preflight() {
        let (task, _runtime, closed) = idle_task().await;
        // Match Active selection: reserve under the cell before any preflight
        // persistence or runtime read. DB remains completed and no viewer exists.
        let delivery = {
            let handles = task.sdk_sessions.lock().await;
            handles
                .get(&task.db_session_id)
                .unwrap()
                .identity
                .begin_delivery()
        };
        assert!(!retire_unobserved_runtime(&task).await);
        assert!(!closed.load(Ordering::SeqCst));
        drop(delivery);
        assert!(retire_unobserved_runtime(&task).await);
        assert!(closed.load(Ordering::SeqCst));
        let handles = task.sdk_sessions.lock().await;
        assert!(matches!(
            handles.get(&task.db_session_id).unwrap().state,
            QueryState::Pending(_)
        ));
    }

    #[tokio::test]
    async fn running_status_is_rechecked_after_waiting_for_runtime_writer() {
        let (task, runtime, closed) = idle_task().await;
        let provider_reader = runtime.clone().read_owned().await;
        let pool = task.write_pool.clone();
        let id = task.db_session_id;
        let retirement = tokio::spawn(async move { retire_unobserved_runtime(&task).await });
        // Tokio's fair RwLock rejects new readers once the writer is queued:
        // this proves teardown passed its completed DB check and awaits write.
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if runtime.try_read().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        WsSessionPersistence::mark_running_static(&pool, id).await;
        drop(provider_reader);
        assert!(!retirement.await.unwrap());
        assert!(!closed.load(Ordering::SeqCst));
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "running");
    }
}
