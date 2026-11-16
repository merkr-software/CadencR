//! Provider round trips made after the session cell's lock is released.
//!
//! The stream reader takes the cell lock for every event it forwards. A
//! provider call (a control request, a close) awaited under that lock stalls
//! the reader, the provider's bounded channels fill, and the provider stops
//! reading its own process output, so the call never sees its reply. Callers
//! read what they need under the lock, release it, then talk to the provider.
//! A close swaps the cell to its next state first: the reader then reads the
//! closing runtime as superseded, which keeps its end benign.

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;

use super::detached_closes::DetachedCloseLease;
use super::helpers::{persist_and_close_query, persistable_resume_sid, RuntimeCloseContext};
use super::registry::SessionRuntimeRegistry;
use super::{QueryState, SdkHandle, SdkSessions};

/// How many times a control command retries when the runtime it switched was
/// replaced while the session lock was released.
pub(in crate::domain::ws_session) const LIVE_SWITCH_ATTEMPTS: usize = 3;

/// A runtime taken out of its session cell, still to be closed. Until it is,
/// the session's spawns wait (see `detached_closes`).
#[must_use = "a detached runtime keeps its process alive until it is closed"]
pub(in crate::domain::ws_session) struct DetachedRuntime {
    query: RuntimeSessionHandle,
    db_session_id: i64,
    runtime_provider: String,
    feature_id: i64,
    lease: DetachedCloseLease,
}

impl DetachedRuntime {
    /// Detach `query`, the runtime `handle` ran until its state was swapped.
    /// Call it under the cell lock, so no spawn slips in before the lease.
    pub(in crate::domain::ws_session) fn of(
        handle: &SdkHandle,
        query: RuntimeSessionHandle,
        db_session_id: i64,
        runtimes: &SessionRuntimeRegistry,
    ) -> Self {
        Self {
            query,
            db_session_id,
            runtime_provider: handle.runtime_provider.clone(),
            feature_id: handle.feature_id,
            lease: runtimes.begin_detached_close(db_session_id),
        }
    }

    /// Persist the resume id and close the runtime, once the session lock is
    /// released. Spawns keep waiting until the returned lease drops, so the
    /// caller can finish writes that must precede the next runtime's.
    pub(in crate::domain::ws_session) async fn close(
        self,
        context: &RuntimeCloseContext<'_>,
    ) -> DetachedCloseLease {
        persist_and_close_query(
            &self.query,
            context,
            self.db_session_id,
            &self.runtime_provider,
            self.feature_id,
        )
        .await;
        self.lease
    }

    pub(in crate::domain::ws_session) async fn close_in(self, app_state: &AppState) {
        let _lease = self.close(&close_context(app_state)).await;
    }
}

/// Whether the session no longer runs `query`. A call that failed on it then
/// failed on a runtime being replaced, and the change is planned again on the
/// successor instead of being reported.
pub(in crate::domain::ws_session) async fn was_replaced(
    sessions: &SdkSessions,
    db_session_id: i64,
    query: &RuntimeSessionHandle,
) -> bool {
    sessions
        .lock()
        .await
        .get(&db_session_id)
        .is_some_and(|handle| !handle.state.runs(Some(query)))
}

pub(in crate::domain::ws_session) fn close_context(
    app_state: &AppState,
) -> RuntimeCloseContext<'_> {
    RuntimeCloseContext::builder()
        .pool(&app_state.write_pool)
        .feature_senders(&app_state.ws_feature_senders)
        .build()
}

/// The resume id a runtime will persist when it closes, read without closing
/// it so the cell can point at its successor before the close.
pub(in crate::domain::ws_session) async fn resume_session_id(
    query: &RuntimeSessionHandle,
    runtime_provider: &str,
) -> Option<String> {
    persistable_resume_sid(query.read().await.as_ref(), runtime_provider).await
}

impl QueryState {
    /// The live runtime, cloned so it can be called after the lock is released.
    pub(in crate::domain::ws_session) fn active_query(&self) -> Option<RuntimeSessionHandle> {
        match self {
            Self::Active { query, .. } => Some(query.clone()),
            Self::Pending(_) => None,
        }
    }

    /// Whether this state still runs `target` (`None`: still has no runtime),
    /// i.e. no respawn or close replaced it while the lock was released.
    pub(in crate::domain::ws_session) fn runs(
        &self,
        target: Option<&RuntimeSessionHandle>,
    ) -> bool {
        match (self, target) {
            (Self::Pending(_), None) => true,
            (Self::Active { query, .. }, Some(target)) => std::sync::Arc::ptr_eq(query, target),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeSpawnConfig;
    use crate::domain::ws_session::handler::tests::support::make_active_handle;

    #[test]
    fn a_state_runs_only_the_runtime_it_was_read_with() {
        let handle = make_active_handle(1, None);
        let query = handle.state.active_query().expect("active handle");
        let replacement = make_active_handle(1, None).state.active_query().unwrap();

        assert!(handle.state.runs(Some(&query)));
        assert!(!handle.state.runs(Some(&replacement)));
        assert!(!handle.state.runs(None));
        let pending = QueryState::Pending(RuntimeSpawnConfig::default());
        assert!(pending.runs(None));
        assert!(!pending.runs(Some(&query)));
    }

    #[tokio::test]
    async fn the_resume_id_is_read_without_closing_the_runtime() {
        let handle = make_active_handle(1, Some("11111111-1111-4111-8111-111111111111".into()));
        let query = handle.state.active_query().unwrap();

        let resume = resume_session_id(&query, &handle.runtime_provider).await;

        assert_eq!(
            resume.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(
            query.read().await.session_id().await.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
    }
}
