//! Which target resolution each published forge snapshot came from.
//!
//! Target resolution (branches, remotes) and forge calls run before a poll
//! takes the `publish_order` lock, so polls can reach it in another order than
//! they resolved. Each resolution draws a ticket from `resolve_tickets` when it
//! starts; holding the lock, a poll checks its ticket here so an older view of
//! a feature never replaces a newer one.

use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct PublishOrder {
    /// Ticket of the newest full poll that published.
    newest_sweep: u64,
    /// Ticket behind the snapshot a per-feature refresh published, kept until
    /// a full poll resolved after it.
    features: HashMap<i64, u64>,
}

impl PublishOrder {
    /// Admit a full poll. A periodic one that resolved before the newest
    /// published poll drops its results; a forced one always publishes, since
    /// it was asked for after the change it reports.
    pub fn admit_sweep(&mut self, ticket: u64, force: bool) -> bool {
        if !force && ticket < self.newest_sweep {
            return false;
        }
        self.newest_sweep = self.newest_sweep.max(ticket);
        true
    }

    /// Features a full poll holding `ticket` must leave alone: a per-feature
    /// refresh resolved them after it and already published.
    pub fn newer_features(&self, ticket: u64) -> HashSet<i64> {
        self.features
            .iter()
            .filter(|(_, published)| **published > ticket)
            .map(|(feature_id, _)| *feature_id)
            .collect()
    }

    /// Forget per-feature tickets the full poll holding `ticket` superseded.
    /// Newer ones stay, even for a feature that poll did not see as active:
    /// it resolved its feature list before that refresh.
    pub fn finish_sweep(&mut self, ticket: u64) {
        self.features.retain(|_, published| *published > ticket);
    }

    /// Admit a per-feature refresh of `feature_id` holding `ticket`. Refused
    /// when a per-feature refresh resolved after it already published, or a
    /// full poll resolved after it and `published_fresh` says that poll
    /// covered the feature. Admission records the ticket.
    pub fn admit_feature(&mut self, feature_id: i64, ticket: u64, published_fresh: bool) -> bool {
        if self
            .features
            .get(&feature_id)
            .is_some_and(|published| *published > ticket)
        {
            return false;
        }
        if ticket < self.newest_sweep && published_fresh {
            return false;
        }
        self.features.insert(feature_id, ticket);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_periodic_poll_resolved_before_a_feature_refresh_leaves_that_feature_alone() {
        let mut order = PublishOrder::default();
        // Periodic poll draws ticket 1 (branch A), the feature refresh ticket
        // 2 (branch B) and publishes first.
        assert!(order.admit_feature(7, 2, false));
        assert!(order.admit_sweep(1, false));
        assert_eq!(order.newer_features(1), HashSet::from([7]));
        order.finish_sweep(1);
        // A later poll resolved after the feature refresh and takes over.
        assert!(order.admit_sweep(3, false));
        assert!(order.newer_features(3).is_empty());
        order.finish_sweep(3);
        assert!(order.features.is_empty());
    }

    #[test]
    fn a_feature_refresh_resolved_before_a_published_poll_is_dropped_only_if_covered() {
        let mut order = PublishOrder::default();
        assert!(order.admit_sweep(5, false));
        assert!(
            !order.admit_feature(7, 4, true),
            "the newer poll already published this feature"
        );
        assert!(
            order.admit_feature(7, 4, false),
            "the newer poll skipped this feature's repo, so ticket 4 is still the newest view"
        );
        assert!(
            !order.admit_feature(7, 3, false),
            "older than the last feature refresh"
        );
    }

    #[test]
    fn a_stale_periodic_poll_is_refused_but_a_forced_one_publishes() {
        let mut order = PublishOrder::default();
        assert!(order.admit_sweep(4, false));
        assert!(!order.admit_sweep(3, false));
        assert!(order.admit_sweep(3, true));
        assert!(order.admit_sweep(4, false), "the newest ticket is kept");
    }

    #[test]
    fn a_feature_refresh_newer_than_the_sweep_outlives_it() {
        let mut order = PublishOrder::default();
        assert!(order.admit_feature(9, 10, false));
        // The sweep resolved its (older) feature list without feature 9.
        order.finish_sweep(1);
        assert_eq!(order.newer_features(1), HashSet::from([9]));
        order.finish_sweep(11);
        assert!(order.features.is_empty());
    }
}
