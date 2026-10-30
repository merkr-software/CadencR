//! Process-wide view of which live runtimes are held by pending work.
//!
//! The [`RuntimeHold`] is fed by the runtime's stream reader, but the prompt
//! path (another task, possibly another connection) must also know about it
//! before it respawns the runtime for a model/effort/profile change. Entries
//! are keyed by session and pinned to the exact runtime instance (a `Weak`),
//! so a superseded runtime's reader can never answer for its replacement.
//! Mirrors the static registry in [`crate::domain::ws_session::stream_readers`].
//! Conforms to `.claude/rules/inline-rust-tests.md`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use crate::domain::agents::adapter::{
    RuntimeEvent, RuntimeSessionHandle, RuntimeSessionWeakHandle,
};

use super::super::{send_error, WsSender};
use super::runtime_hold::RuntimeHold;

/// A [`RuntimeHold`] shared between a stream reader and the prompt path.
#[derive(Clone, Debug, Default)]
pub(in crate::domain::ws_session) struct SharedRuntimeHold(Arc<Mutex<RuntimeHold>>);

impl SharedRuntimeHold {
    fn lock(&self) -> MutexGuard<'_, RuntimeHold> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(in crate::domain::ws_session) fn observe(&self, event: &RuntimeEvent) {
        self.lock().observe(event);
    }

    pub(in crate::domain::ws_session) fn holds_runtime(&self) -> bool {
        self.lock().holds_runtime()
    }
}

struct Entry {
    runtime: RuntimeSessionWeakHandle,
    hold: SharedRuntimeHold,
}

static HOLDS: LazyLock<Mutex<HashMap<i64, Entry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn holds() -> MutexGuard<'static, HashMap<i64, Entry>> {
    HOLDS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Withdraws its hold when dropped — also when the reader panics or is
/// aborted — unless a newer runtime's hold replaced it.
#[must_use]
pub(in crate::domain::ws_session) struct HoldRegistration {
    db_session_id: i64,
    hold: SharedRuntimeHold,
}

impl Drop for HoldRegistration {
    fn drop(&mut self) {
        let mut holds = holds();
        if holds
            .get(&self.db_session_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.hold.0, &self.hold.0))
        {
            holds.remove(&self.db_session_id);
        }
    }
}

/// Publish `hold` as the one for `runtime`, replacing any older runtime's.
pub(in crate::domain::ws_session) fn register(
    db_session_id: i64,
    runtime: &RuntimeSessionWeakHandle,
    hold: &SharedRuntimeHold,
) -> HoldRegistration {
    holds().insert(
        db_session_id,
        Entry {
            runtime: runtime.clone(),
            hold: hold.clone(),
        },
    );
    HoldRegistration {
        db_session_id,
        hold: hold.clone(),
    }
}

/// Whether the live `runtime` of this session still owes the agent a resume.
pub(in crate::domain::ws_session) fn runtime_is_held(
    db_session_id: i64,
    runtime: &RuntimeSessionHandle,
) -> bool {
    let hold = holds()
        .get(&db_session_id)
        .filter(|entry| std::ptr::eq(entry.runtime.as_ptr(), Arc::as_ptr(runtime)))
        .map(|entry| entry.hold.clone());
    hold.is_some_and(|hold| hold.holds_runtime())
}

/// Tell the sender that its `changes` (user-facing labels) wait for the held
/// runtime: applying them now would respawn it and kill that work.
pub(in crate::domain::ws_session) fn notify_change_deferred(
    sender: &WsSender,
    envelope_id: &str,
    changes: &[&str],
) {
    let notice = format!(
        "The agent is waiting on background work, so your new {} will apply to your first message after it finishes.",
        changes.join(" and ")
    );
    send_error(sender, envelope_id, "RUNTIME_CHANGE_DEFERRED", &notice);
}

#[cfg(test)]
mod tests {
    use super::super::super::QueryState;
    use super::*;
    use crate::domain::agents::adapter::{RuntimeEventKind, RuntimeEventMetadata};
    use crate::domain::ws_session::handler::tests::support::make_active_handle;

    fn runtime() -> RuntimeSessionHandle {
        match make_active_handle(1, None).state {
            QueryState::Active { query, .. } => query,
            QueryState::Pending(_) => unreachable!("make_active_handle is active"),
        }
    }

    fn busy_hold() -> SharedRuntimeHold {
        let hold = SharedRuntimeHold::default();
        hold.observe(
            &RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
                .with_background_task_count(Some(1)),
        );
        hold
    }

    #[test]
    fn answers_only_for_the_registered_runtime_instance() {
        let live = runtime();
        let replacement = runtime();
        let hold = busy_hold();
        let registration = register(9101, &Arc::downgrade(&live), &hold);

        assert!(runtime_is_held(9101, &live));
        assert!(!runtime_is_held(9101, &replacement));
        assert!(!runtime_is_held(9102, &live));
        drop(registration);
        assert!(!runtime_is_held(9101, &live));
    }

    #[test]
    fn a_stale_reader_cannot_withdraw_its_replacements_hold() {
        let old_hold = busy_hold();
        let new_runtime = runtime();
        let new_hold = busy_hold();
        let stale = register(9103, &Arc::downgrade(&runtime()), &old_hold);
        let _live = register(9103, &Arc::downgrade(&new_runtime), &new_hold);

        drop(stale);

        assert!(runtime_is_held(9103, &new_runtime));
    }
}
