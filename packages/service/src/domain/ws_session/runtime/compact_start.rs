//! Who comes first between a manual compaction and a Stop.
//!
//! A manual compaction marks the session working before its runtime is
//! asked to compact (and before that runtime is even spawned). Until that
//! request, there is no compaction turn for a Stop to interrupt, so the Stop
//! cancels the compaction instead. Both sides settle the race here, on one
//! atomic, so a Stop is never taken while the compaction starts anyway.

use std::sync::atomic::{AtomicU8, Ordering};

const STARTING: u8 = 0;
const CANCELLED: u8 = 1;
const DISPATCHED: u8 = 2;

/// Read only while the session's compaction start is pending
/// (`SdkHandle::manual_compact_spawn_pending`).
#[derive(Debug, Default)]
pub(in crate::domain::ws_session) struct CompactStart(AtomicU8);

impl CompactStart {
    /// A new compaction starts: a Stop of an earlier one no longer applies.
    pub(in crate::domain::ws_session) fn begin(&self) {
        self.0.store(STARTING, Ordering::SeqCst);
    }

    /// A Stop: `true` when it came before the runtime was asked to compact,
    /// which then never happens.
    pub(in crate::domain::ws_session) fn cancel(&self) -> bool {
        self.0
            .compare_exchange(STARTING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// The compaction is about to ask its runtime: `false` when a Stop came
    /// first. Once dispatched, a Stop interrupts the runtime's compaction.
    pub(in crate::domain::ws_session) fn dispatch(&self) -> bool {
        self.0
            .compare_exchange(STARTING, DISPATCHED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::CompactStart;

    #[test]
    fn the_first_of_a_stop_and_the_dispatch_wins() {
        let start = CompactStart::default();
        assert!(start.cancel());
        assert!(!start.dispatch(), "a stopped compaction never starts");

        start.begin();
        assert!(start.dispatch(), "an earlier stop no longer applies");
        assert!(
            !start.cancel(),
            "a dispatched compaction is interrupted instead"
        );
    }
}
