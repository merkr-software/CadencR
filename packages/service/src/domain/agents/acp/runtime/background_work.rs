//! Session-scoped opt-in for work that outlives an ACP prompt or detached reply.

use serde_json::Value;

use crate::domain::agents::adapter::BackgroundAgentSignal;

#[derive(Default)]
pub(super) struct BackgroundWork {
    pending: bool,
}

pub(super) fn pending(body: &Value) -> Option<bool> {
    body.pointer("/_meta/cadencr/backgroundWorkPending")?
        .as_bool()
}

impl BackgroundWork {
    pub(super) fn is_pending(&self) -> bool {
        self.pending
    }

    /// Restate a hold on each result while the connector still owes work.
    /// A finishing edge is accepted only after an observed hold.
    pub(super) fn observe(&mut self, pending: bool) -> Option<BackgroundAgentSignal> {
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
