//! Orders ACP prompt submission and response settlement for one session.

use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};

pub type PromptTurnLock = Arc<PromptTurns>;

#[derive(Default)]
pub struct PromptTurns {
    steering: bool,
    turn: RwLock<()>,
    admission: Mutex<()>,
    pending: StdMutex<PendingPrompts>,
}

#[derive(Default)]
struct PendingPrompts {
    count: usize,
    last_boundary: Option<Value>,
}

impl PromptTurns {
    pub(super) fn new(steering: bool) -> Self {
        Self {
            steering,
            ..Self::default()
        }
    }

    pub(super) fn supports_steering(&self) -> bool {
        self.steering
    }

    pub(super) async fn lock(&self) -> RwLockWriteGuard<'_, ()> {
        self.turn.write().await
    }

    pub(super) fn try_lock(&self) -> Result<RwLockWriteGuard<'_, ()>, TryLockError> {
        self.turn.try_write()
    }

    pub(super) async fn lock_admission(&self) -> MutexGuard<'_, ()> {
        self.admission.lock().await
    }

    /// Keep admission ordered through submission, while the turn guard keeps
    /// detached updates and exclusive operations outside outstanding prompts.
    pub(super) async fn begin(&self) -> (PromptRequest<'_>, MutexGuard<'_, ()>, bool) {
        let turn = if self.steering {
            TurnGuard::Shared {
                _guard: self.turn.read().await,
            }
        } else {
            TurnGuard::Exclusive {
                _guard: self.lock().await,
            }
        };
        let admission = self.lock_admission().await;
        let mut pending = self.pending.lock().expect("prompt state poisoned");
        pending.count += 1;
        let first = pending.count == 1;
        (
            PromptRequest {
                turns: self,
                _turn: turn,
                pending: true,
            },
            admission,
            first,
        )
    }
}

enum TurnGuard<'a> {
    Shared { _guard: RwLockReadGuard<'a, ()> },
    Exclusive { _guard: RwLockWriteGuard<'a, ()> },
}

pub(super) struct PromptRequest<'a> {
    turns: &'a PromptTurns,
    _turn: TurnGuard<'a>,
    pending: bool,
}

pub(super) enum PromptSettlement {
    Outstanding,
    Final { earlier_boundary: Option<Value> },
}

impl<'a> PromptRequest<'a> {
    /// Keep a new admission behind the final Result until that boundary is
    /// published. Overlapping prompt responses only acknowledge their input.
    pub(super) async fn settle(
        &mut self,
        boundary: Option<&Value>,
    ) -> (MutexGuard<'a, ()>, PromptSettlement) {
        let admission = self.turns.lock_admission().await;
        let mut pending = self.turns.pending.lock().expect("prompt state poisoned");
        self.pending = false;
        pending.count -= 1;
        let settlement = if pending.count == 0 {
            PromptSettlement::Final {
                earlier_boundary: pending.last_boundary.take(),
            }
        } else {
            if let Some(boundary) = boundary {
                pending.last_boundary = Some(boundary.clone());
            }
            PromptSettlement::Outstanding
        };
        (admission, settlement)
    }
}

impl Drop for PromptRequest<'_> {
    fn drop(&mut self) {
        if self.pending {
            let mut pending = self.turns.pending.lock().expect("prompt state poisoned");
            pending.count -= 1;
            if pending.count == 0 {
                pending.last_boundary = None;
            }
        }
    }
}
