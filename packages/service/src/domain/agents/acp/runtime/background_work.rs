//! Session-scoped opt-in for work that outlives an ACP prompt or detached reply.

use serde_json::Value;

use crate::domain::agents::adapter::BackgroundAgentSignal;

#[derive(Default)]
pub(super) struct BackgroundWork {
    pending: bool,
    held_at_result: bool,
}

pub(super) fn pending(body: &Value) -> Option<bool> {
    body.pointer("/_meta/cadencr/backgroundWorkPending")?
        .as_bool()
}

impl BackgroundWork {
    pub(super) fn is_pending(&self) -> bool {
        self.pending
    }

    pub(super) fn held_at_result(&self) -> bool {
        self.held_at_result
    }

    /// An overlapping prompt can report work while the logical turn is open.
    pub(super) fn observe_progress(&mut self, pending: bool) -> Option<BackgroundAgentSignal> {
        if self.pending == pending {
            return None;
        }
        self.held_at_result &= pending;
        self.update(pending)
    }

    /// Restate a hold on each result while the connector still owes work.
    /// An omitted snapshot carries no news about an existing hold.
    pub(super) fn observe(&mut self, pending: Option<bool>) -> Option<BackgroundAgentSignal> {
        let pending = pending.unwrap_or(self.pending);
        self.held_at_result = pending;
        self.update(pending)
    }

    fn update(&mut self, pending: bool) -> Option<BackgroundAgentSignal> {
        if !pending && !self.pending {
            return None;
        }
        self.pending = pending;
        // The reader is already scoped to a single provider session.
        let agent_id = "acp-background-work".to_owned();
        Some(if pending {
            BackgroundAgentSignal::Started { agent_id }
        } else {
            BackgroundAgentSignal::Finished { agent_id }
        })
    }
}
