//! Conversations kept from binding a runtime cell while their project's
//! folder moves.
//!
//! The launch claims a relocation holds only cover the cells that exist when
//! it starts. A conversation opened during the move would resolve its folder
//! from records that are about to change (or from worktrees not yet repaired)
//! and spawn there. So binding a cell of a fenced conversation waits for the
//! fence to drop, and resolves its folder once the move is over.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::{OwnedRwLockWriteGuard, RwLock};

type Gate = Arc<RwLock<()>>;
type Gates = Arc<Mutex<HashMap<i64, Gate>>>;

#[derive(Default)]
pub(super) struct LaunchFences {
    gates: Gates,
}

impl LaunchFences {
    /// Close the gate of `feature_ids` until the returned fence drops.
    pub(super) fn raise(&self, feature_ids: &HashSet<i64>) -> LaunchFence {
        let gate = Gate::default();
        let closed = gate
            .clone()
            .try_write_owned()
            .expect("nobody else holds a gate made here");
        let mut gates = self.gates.lock().unwrap_or_else(PoisonError::into_inner);
        for &feature_id in feature_ids {
            gates.insert(feature_id, gate.clone());
        }
        LaunchFence {
            gates: self.gates.clone(),
            gate,
            feature_ids: feature_ids.iter().copied().collect(),
            _closed: closed,
        }
    }

    /// The closed gate `feature_id` must wait for, if any.
    pub(super) fn gate(&self, feature_id: i64) -> Option<Gate> {
        self.gates
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&feature_id)
            .cloned()
    }
}

/// Conversations that wait to bind until this drops.
#[must_use = "dropping the fence lets the conversations bind at once"]
pub(crate) struct LaunchFence {
    gates: Gates,
    gate: Gate,
    feature_ids: Vec<i64>,
    /// Released after `drop` removed the gate, so a woken waiter finds none.
    _closed: OwnedRwLockWriteGuard<()>,
}

impl Drop for LaunchFence {
    fn drop(&mut self) {
        let mut gates = self.gates.lock().unwrap_or_else(PoisonError::into_inner);
        for feature_id in &self.feature_ids {
            if gates
                .get(feature_id)
                .is_some_and(|gate| Arc::ptr_eq(gate, &self.gate))
            {
                gates.remove(feature_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_gate_stays_closed_until_its_fence_drops() {
        let fences = LaunchFences::default();
        let fence = fences.raise(&HashSet::from([1, 2]));
        let gate = fences.gate(1).expect("fenced");
        assert!(fences.gate(3).is_none());
        assert!(gate.try_read().is_err());

        drop(fence);

        assert!(gate.try_read().is_ok());
        assert!(fences.gate(1).is_none() && fences.gate(2).is_none());
    }

    #[tokio::test]
    async fn a_later_fence_keeps_its_own_gate() {
        let fences = LaunchFences::default();
        let first = fences.raise(&HashSet::from([1]));
        let second = fences.raise(&HashSet::from([1]));

        drop(first);

        let gate = fences.gate(1).expect("the second fence still holds it");
        assert!(gate.try_read().is_err());
        drop(second);
        assert!(fences.gate(1).is_none());
    }
}
