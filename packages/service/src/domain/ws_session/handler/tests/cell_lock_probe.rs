//! A runtime whose provider calls need its session cell's lock, as a real one
//! needs the stream reader (which takes that lock per event) to drain its
//! output before a reply can arrive. A caller that awaits such a call under
//! the lock gets an error here instead of the production hang.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::support::*;

#[derive(Default)]
pub(in crate::domain::ws_session) struct ProbeCalls {
    /// Provider calls that completed with the session lock free.
    pub(in crate::domain::ws_session) unlocked: AtomicUsize,
    /// Provider calls that found the session lock held by their caller.
    pub(in crate::domain::ws_session) blocked: AtomicUsize,
}

/// Applied to every handle of the cell during the first provider call, as a
/// respawn or another device would while the lock is released.
pub(in crate::domain::ws_session) type DuringCall = fn(&mut SdkHandle);

struct CellLockProbe {
    cell: std::sync::Weak<Mutex<HashMap<i64, SdkHandle>>>,
    calls: Arc<ProbeCalls>,
    message_rx: Option<RuntimeMessageRx>,
    during_first_call: std::sync::Mutex<Option<DuringCall>>,
}

impl CellLockProbe {
    async fn reach_reader(&self, call: &str) -> Result<(), RuntimeError> {
        let Some(cell) = self.cell.upgrade() else {
            return Ok(());
        };
        let reached = match tokio::time::timeout(Duration::from_millis(500), cell.lock()).await {
            Ok(mut handles) => {
                let during = self
                    .during_first_call
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                if let Some(during) = during {
                    handles.values_mut().for_each(during);
                }
                true
            }
            Err(_) => false,
        };
        let counter = if reached {
            &self.calls.unlocked
        } else {
            &self.calls.blocked
        };
        counter.fetch_add(1, Ordering::SeqCst);
        if reached {
            Ok(())
        } else {
            Err(RuntimeError::new(format!(
                "{call} was awaited under the session lock"
            )))
        }
    }
}

#[async_trait::async_trait]
impl AgentRuntimeSession for CellLockProbe {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        self.message_rx.take().unwrap_or_else(|| mpsc::channel(1).1)
    }
    async fn session_id(&self) -> Option<String> {
        Some("22222222-2222-4222-8222-222222222222".to_string())
    }
    async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn close(&mut self) -> Result<(), RuntimeError> {
        self.reach_reader("close").await
    }
    async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
        self.reach_reader("set_model").await
    }
    async fn set_permission_mode(&self, _mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        self.reach_reader("set_permission_mode").await
    }
    async fn set_fast_mode(&self, _enabled: bool) -> Result<(), RuntimeError> {
        self.reach_reader("set_fast_mode").await
    }
    fn pid(&self) -> Option<u32> {
        None
    }
}

/// An active Claude handle for `cell` running a [`CellLockProbe`].
pub(in crate::domain::ws_session) fn probe_handle(
    cell: &SdkSessions,
    feature_id: i64,
) -> (SdkHandle, Arc<ProbeCalls>) {
    probe_handle_changing(cell, feature_id, None)
}

/// [`probe_handle`] whose first provider call also runs `during_first_call`.
pub(in crate::domain::ws_session) fn probe_handle_changing(
    cell: &SdkSessions,
    feature_id: i64,
    during_first_call: Option<DuringCall>,
) -> (SdkHandle, Arc<ProbeCalls>) {
    let calls = Arc::new(ProbeCalls::default());
    let probe = CellLockProbe {
        cell: Arc::downgrade(cell),
        calls: calls.clone(),
        message_rx: Some(mpsc::channel(1).1),
        during_first_call: std::sync::Mutex::new(during_first_call),
    };
    let mut handle = make_active_handle(feature_id, None);
    let QueryState::Active { query, .. } = &mut handle.state else {
        unreachable!("make_active_handle is active");
    };
    *query = Arc::new(RwLock::new(Box::new(probe)));
    (handle, calls)
}

/// A respawn that left the handle pending while the call ran.
pub(in crate::domain::ws_session) fn respawned_to_pending(handle: &mut SdkHandle) {
    handle.state = QueryState::Pending(Default::default());
}

/// Assert every provider call ran with the session lock released.
pub(in crate::domain::ws_session) fn assert_unlocked(calls: &ProbeCalls, expected: usize) {
    assert_eq!(
        calls.blocked.load(Ordering::SeqCst),
        0,
        "a provider call was awaited under the session lock"
    );
    assert_eq!(calls.unlocked.load(Ordering::SeqCst), expected);
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn dispatch_with_probe(action: &str, db_session_id: i64) -> Arc<ProbeCalls> {
        let (tx, _rx) = mpsc::unbounded_channel();
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, db_session_id, 7).await;
        let sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        let (handle, calls) = probe_handle(&sessions, 7);
        sessions.lock().await.insert(db_session_id, handle);
        let envelope = make_envelope(
            "session",
            action,
            serde_json::json!({ "session_id": db_session_id.to_string() }),
        );

        dispatch_envelope(envelope, &tx, &sessions, &app_state).await;

        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(db_session_id)
            .fetch_one(&app_state.read_pool)
            .await
            .unwrap();
        assert_eq!(status, "completed", "an intentional close is not a crash");
        calls
    }

    #[tokio::test]
    async fn destroy_closes_the_runtime_with_the_session_lock_released() {
        let calls = dispatch_with_probe("destroy", 61).await;
        assert_unlocked(&calls, 1);
    }

    #[tokio::test]
    async fn clear_closes_the_runtime_with_the_session_lock_released() {
        let calls = dispatch_with_probe("clear", 62).await;
        assert_unlocked(&calls, 1);
    }
}
