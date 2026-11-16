//! Closes of runtimes detached from their session cell (see
//! `detached_runtime`) that have not finished yet.
//!
//! The cell already points at the successor state while such a close runs, so
//! a spawn could otherwise resume the conversation in a second process while
//! the first one still lives, or a follow-up write of the closer (an archive,
//! a resume id) could land after the new runtime's. Spawns wait here first.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

#[derive(Default)]
struct PendingCloses {
    count: usize,
    done: Arc<Notify>,
}

#[derive(Default)]
pub(crate) struct DetachedCloses {
    sessions: Arc<Mutex<HashMap<i64, PendingCloses>>>,
}

/// Held until a detached runtime and the writes that follow its close finish.
#[must_use = "dropping the lease lets a spawn start before the close finished"]
pub(crate) struct DetachedCloseLease {
    sessions: Arc<Mutex<HashMap<i64, PendingCloses>>>,
    session_id: i64,
}

impl DetachedCloses {
    /// Synchronous so it can run under the session cell's lock, before the
    /// cell is released to the successor state.
    pub(crate) fn begin(&self, session_id: i64) -> DetachedCloseLease {
        lock(&self.sessions).entry(session_id).or_default().count += 1;
        DetachedCloseLease {
            sessions: self.sessions.clone(),
            session_id,
        }
    }

    pub(crate) async fn finished(&self, session_id: i64) {
        loop {
            let Some(done) = lock(&self.sessions)
                .get(&session_id)
                .map(|pending| pending.done.clone())
            else {
                return;
            };
            let notified = done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // The closes this `done` belongs to may have finished (and new ones
            // begun under a new entry) before `enable`: wait only while the
            // same entry is still pending, else look again.
            let same_entry = lock(&self.sessions)
                .get(&session_id)
                .is_some_and(|pending| Arc::ptr_eq(&pending.done, &done));
            if same_entry {
                notified.await;
            }
        }
    }

    /// Whether a detached close of the session is still running. Checked
    /// under the cell lock by spawns, after their claim already waited once:
    /// a runtime can be detached between that wait and the cell read.
    pub(crate) fn is_pending(&self, session_id: i64) -> bool {
        lock(&self.sessions).contains_key(&session_id)
    }
}

impl Drop for DetachedCloseLease {
    fn drop(&mut self) {
        let mut sessions = lock(&self.sessions);
        let Some(pending) = sessions.get_mut(&self.session_id) else {
            return;
        };
        pending.count -= 1;
        if pending.count == 0 {
            if let Some(pending) = sessions.remove(&self.session_id) {
                pending.done.notify_waiters();
            }
        }
    }
}

fn lock(
    sessions: &Mutex<HashMap<i64, PendingCloses>>,
) -> MutexGuard<'_, HashMap<i64, PendingCloses>> {
    sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn waits_for_every_close_of_the_session() {
        let closes = Arc::new(DetachedCloses::default());
        let first = closes.begin(1);
        let second = closes.begin(1);
        let other_session = closes.begin(2);
        let waiter = {
            let closes = closes.clone();
            tokio::spawn(async move { closes.finished(1).await })
        };

        drop(first);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished(), "one close of session 1 still runs");
        drop(second);
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("the last close releases the waiter")
            .unwrap();
        drop(other_session);
    }

    #[tokio::test]
    async fn a_close_begun_after_the_previous_one_finished_is_waited_for() {
        let closes = Arc::new(DetachedCloses::default());
        let first = closes.begin(4);
        let waiter = {
            let closes = closes.clone();
            tokio::spawn(async move { closes.finished(4).await })
        };
        tokio::task::yield_now().await;
        drop(first);
        let second = closes.begin(4);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(closes.is_pending(4));
        drop(second);
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("the waiter follows the new close and then returns")
            .unwrap();
        assert!(!closes.is_pending(4));
    }

    #[tokio::test]
    async fn no_pending_close_does_not_wait() {
        let closes = DetachedCloses::default();
        tokio::time::timeout(Duration::from_millis(100), closes.finished(9))
            .await
            .expect("nothing to wait for");
    }
}
