use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunOwnership {
    Active,
    Recovery,
}

/// One claimed run: who owns it, a token asking it to stop, and a token
/// fired once its permit is released.
struct Run {
    ownership: RunOwnership,
    cancel: CancellationToken,
    released: CancellationToken,
}

#[derive(Clone, Default)]
pub struct FeatureRunRegistry {
    active: Arc<Mutex<HashMap<i64, Run>>>,
}

impl FeatureRunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn try_acquire(&self, feature_id: i64) -> Option<FeatureRunPermit> {
        self.try_acquire_as(feature_id, RunOwnership::Active)
    }

    pub fn try_acquire_recovery(&self, feature_id: i64) -> Option<FeatureRunPermit> {
        self.try_acquire_as(feature_id, RunOwnership::Recovery)
    }

    fn try_acquire_as(&self, feature_id: i64, ownership: RunOwnership) -> Option<FeatureRunPermit> {
        let mut active = self.active();
        let std::collections::hash_map::Entry::Vacant(entry) = active.entry(feature_id) else {
            return None;
        };
        let run = entry.insert(Run {
            ownership,
            cancel: CancellationToken::new(),
            released: CancellationToken::new(),
        });
        let permit = FeatureRunPermit {
            registry: Some(self.clone()),
            feature_id,
            cancellation: run.cancel.clone(),
            released: run.released.clone(),
        };
        drop(active);
        Some(permit)
    }

    /// Ask the run `feature_id` owns, if any, to stop, and wait up to
    /// `timeout` for it to release its slot. Returns whether a run was asked.
    pub async fn cancel_and_wait(&self, feature_id: i64, timeout: Duration) -> bool {
        let tokens = self
            .active()
            .get(&feature_id)
            .map(|run| (run.cancel.clone(), run.released.clone()));
        let Some((cancel, released)) = tokens else {
            return false;
        };
        cancel.cancel();
        if tokio::time::timeout(timeout, released.cancelled())
            .await
            .is_err()
        {
            tracing::warn!(feature_id, "cancelled run did not stop within {timeout:?}");
        }
        true
    }

    pub fn is_owned(&self, feature_id: i64) -> bool {
        self.active().contains_key(&feature_id)
    }

    /// Run a synchronous action only while `feature_id` owns an active run.
    /// Recovery claims are excluded: callers should wait and replay their
    /// terminal result instead of presenting them as live work.
    pub fn if_active<R>(&self, feature_id: i64, action: impl FnOnce() -> R) -> Option<R> {
        let active = self.active();
        (active.get(&feature_id).map(|run| run.ownership) == Some(RunOwnership::Active))
            .then(action)
    }

    fn active(&self) -> MutexGuard<'_, HashMap<i64, Run>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct FeatureRunPermit {
    registry: Option<FeatureRunRegistry>,
    feature_id: i64,
    cancellation: CancellationToken,
    released: CancellationToken,
}

impl FeatureRunPermit {
    /// Fired when [`FeatureRunRegistry::cancel_and_wait`] asks this run to stop.
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    /// Release the slot and emit its terminal event under one lock.
    pub fn finish<R>(mut self, action: impl FnOnce() -> R) -> R {
        let registry = self.registry.take().expect("permit owns its registry");
        let mut active = registry.active();
        active.remove(&self.feature_id);
        let result = action();
        drop(active);
        self.released.cancel();
        result
    }
}

impl Drop for FeatureRunPermit {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.take() {
            registry.active().remove(&self.feature_id);
        }
        self.released.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permit_refuses_duplicate_feature_id() {
        let registry = FeatureRunRegistry::new();

        let _permit = registry.try_acquire(7).unwrap();
        assert!(registry.try_acquire(7).is_none());
    }

    #[test]
    fn dropping_permit_allows_feature_to_run_again() {
        let registry = FeatureRunRegistry::new();

        let permit = registry.try_acquire(7).unwrap();
        drop(permit);
        assert!(registry.try_acquire(7).is_some());
    }

    #[test]
    fn finish_orders_running_before_terminal_action() {
        let registry = FeatureRunRegistry::new();
        let permit = registry.try_acquire(7).unwrap();
        let events = std::cell::RefCell::new(Vec::new());

        registry.if_active(7, || events.borrow_mut().push("running"));
        permit.finish(|| events.borrow_mut().push("ready"));
        assert_eq!(events.into_inner(), vec!["running", "ready"]);
        assert!(!registry.is_owned(7));
    }

    #[test]
    fn recovery_claim_is_owned_but_not_reported_as_active() {
        let registry = FeatureRunRegistry::new();
        let _permit = registry.try_acquire_recovery(7).unwrap();

        assert!(registry.is_owned(7));
        assert!(registry.if_active(7, || ()).is_none());
        assert!(registry.try_acquire(7).is_none());
    }

    #[tokio::test]
    async fn cancel_and_wait_signals_the_permit_and_waits_for_its_release() {
        let registry = FeatureRunRegistry::new();
        let permit = registry.try_acquire(7).unwrap();
        let cancellation = permit.cancellation();
        let run = tokio::spawn(async move {
            cancellation.cancelled().await;
            permit.finish(|| ());
        });

        assert!(registry.cancel_and_wait(7, Duration::from_secs(5)).await);

        assert!(!registry.is_owned(7));
        run.await.unwrap();
    }

    #[tokio::test]
    async fn cancel_and_wait_ignores_an_idle_feature_and_spares_others() {
        let registry = FeatureRunRegistry::new();
        let other = registry.try_acquire(8).unwrap();

        assert!(!registry.cancel_and_wait(7, Duration::from_secs(5)).await);

        assert!(!other.cancellation().is_cancelled());
    }

    #[tokio::test]
    async fn cancel_and_wait_gives_up_on_a_run_that_does_not_stop() {
        let registry = FeatureRunRegistry::new();
        let _stuck = registry.try_acquire(7).unwrap();

        assert!(registry.cancel_and_wait(7, Duration::from_millis(50)).await);

        assert!(registry.is_owned(7));
    }
}
