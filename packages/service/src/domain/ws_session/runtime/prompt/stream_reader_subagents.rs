//! Keeps the conversation's sub-agent registry current from its stream and
//! pushes each change to every device viewing the feature.

use axum::extract::ws::Message;
use tracing::error;

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use crate::domain::agents::adapter::{
    stop_reason, RuntimeEvent, RuntimeSubagentPatch, RuntimeSubagentStatus,
};
use crate::domain::subagents::repository::{self, SubagentChange};
use crate::domain::subagents::SubagentRun;
use crate::domain::ws_session::protocol::{WsEnvelope, WsSessionEvent};

/// How a turn ended, which decides what becomes of sub-agents bound to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnEnd {
    Completed,
    Failed,
    Interrupted,
}

impl StreamReaderTask {
    /// A reader serves one runtime. Runs of this session still marked running
    /// when it starts belong to a runtime that is gone (destroyed, cleared,
    /// respawned) whose reader did not get to settle them.
    pub(super) async fn stop_orphaned_subagents(&self, state: &mut StreamReaderState) {
        let patch = RuntimeSubagentPatch::stopped(stop_reason::RUNTIME_ENDED);
        self.settle_running(state, true, patch).await;
    }

    pub(super) async fn track_subagents(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
        interrupted: bool,
    ) {
        for change in state.subagents.observe(event) {
            self.publish_subagent_change(&change).await;
        }
        if event.is_result() {
            let end = if interrupted {
                TurnEnd::Interrupted
            } else if event.result_error().is_some() {
                TurnEnd::Failed
            } else {
                TurnEnd::Completed
            };
            self.settle_turn_subagents(state, end).await;
        }
    }

    /// A turn's end also ends the sub-agents it was waiting on. Background
    /// ones outlive it (Claude keeps them through Esc) and settle on their
    /// own signal or when the runtime goes away. Runs older than this reader
    /// were stopped when it started, so a reader that never saw a carrier has
    /// nothing to settle.
    async fn settle_turn_subagents(&self, state: &mut StreamReaderState, end: TurnEnd) {
        if !state.subagents.has_carriers() {
            return;
        }
        let patch = match end {
            TurnEnd::Completed => RuntimeSubagentPatch::status(RuntimeSubagentStatus::Completed),
            TurnEnd::Failed => RuntimeSubagentPatch::stopped(stop_reason::TURN_FAILED),
            TurnEnd::Interrupted => RuntimeSubagentPatch::stopped(stop_reason::INTERRUPTED),
        };
        self.settle_running(state, false, patch).await;
    }

    /// The runtime is gone, however it went (closed, destroyed, superseded):
    /// nothing it launched still runs. Only this reader's own runs are
    /// settled, so a newer runtime's sub-agents are left alone.
    pub(super) async fn stop_running_subagents(&self, state: &mut StreamReaderState) {
        for tool_use_id in state.subagents.live_tool_use_ids() {
            let change = SubagentChange {
                tool_use_id,
                parent_tool_use_id: None,
                patch: RuntimeSubagentPatch::stopped(stop_reason::RUNTIME_ENDED),
            };
            state.subagents.record(&change);
            self.publish_subagent_change(&change).await;
        }
    }

    async fn settle_running(
        &self,
        state: &mut StreamReaderState,
        include_background: bool,
        patch: RuntimeSubagentPatch,
    ) {
        let ids = match repository::running_tool_use_ids(
            &self.write_pool,
            self.db_session_id,
            include_background,
        )
        .await
        {
            Ok(ids) => ids,
            Err(error) => {
                error!(self.db_session_id, %error, "failed to list running sub-agents");
                return;
            }
        };
        for tool_use_id in ids {
            let change = SubagentChange {
                tool_use_id,
                parent_tool_use_id: None,
                patch: patch.clone(),
            };
            state.subagents.record(&change);
            self.publish_subagent_change(&change).await;
        }
    }

    async fn publish_subagent_change(&self, change: &SubagentChange) {
        match repository::apply_change(&self.write_pool, self.db_session_id, change).await {
            Ok(Some(run)) => self.send_subagent_updated(run).await,
            Ok(None) => {}
            Err(error) => error!(
                self.db_session_id,
                tool_use_id = %change.tool_use_id,
                %error,
                "failed to persist sub-agent change"
            ),
        }
    }

    async fn send_subagent_updated(&self, run: SubagentRun) {
        let envelope = WsEnvelope::session_event(&WsSessionEvent::SubagentUpdated(run))
            .expect("sub-agent run serializes");
        let _ = self
            .send_and_mirror(Message::Text(String::from(envelope).into()))
            .await;
    }
}
