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
        if self.settle_running(state, true, patch).await {
            self.sync_running_subagents().await;
        }
    }

    pub(super) async fn track_subagents(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
        interrupted: bool,
    ) {
        let mut changed = false;
        for change in state.subagents.observe(event) {
            changed |= self.publish_subagent_change(&change).await;
        }
        if event.is_result() {
            let end = if interrupted {
                TurnEnd::Interrupted
            } else if event.result_error().is_some() {
                TurnEnd::Failed
            } else {
                TurnEnd::Completed
            };
            changed |= self.settle_turn_subagents(state, end).await;
        }
        if changed {
            self.sync_running_subagents().await;
        }
    }

    /// A turn's end also ends the sub-agents it was waiting on. Background
    /// ones outlive it (Claude keeps them through Esc) and settle on their
    /// own signal or when the runtime goes away. Runs older than this reader
    /// were stopped when it started, so a reader that never saw a carrier has
    /// nothing to settle.
    async fn settle_turn_subagents(&self, state: &mut StreamReaderState, end: TurnEnd) -> bool {
        if !state.subagents.has_carriers() {
            return false;
        }
        let patch = match end {
            TurnEnd::Completed => RuntimeSubagentPatch::status(RuntimeSubagentStatus::Completed),
            TurnEnd::Failed => RuntimeSubagentPatch::stopped(stop_reason::TURN_FAILED),
            TurnEnd::Interrupted => RuntimeSubagentPatch::stopped(stop_reason::INTERRUPTED),
        };
        self.settle_running(state, false, patch).await
    }

    /// The runtime is gone, however it went (closed, destroyed, superseded):
    /// nothing it launched still runs. Only this reader's own runs are
    /// settled, so a newer runtime's sub-agents are left alone.
    pub(super) async fn stop_running_subagents(&self, state: &mut StreamReaderState) {
        let ids = state.subagents.live_tool_use_ids();
        let patch = RuntimeSubagentPatch::stopped(stop_reason::RUNTIME_ENDED);
        if self.settle_ids(state, ids, patch).await {
            self.sync_running_subagents().await;
        }
    }

    async fn settle_running(
        &self,
        state: &mut StreamReaderState,
        include_background: bool,
        patch: RuntimeSubagentPatch,
    ) -> bool {
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
                return false;
            }
        };
        self.settle_ids(state, ids, patch).await
    }

    async fn settle_ids(
        &self,
        state: &mut StreamReaderState,
        ids: Vec<String>,
        patch: RuntimeSubagentPatch,
    ) -> bool {
        let mut running_changed = false;
        for tool_use_id in ids {
            let change = SubagentChange {
                tool_use_id,
                parent_tool_use_id: None,
                patch: patch.clone(),
            };
            state.subagents.record(&change);
            running_changed |= self.publish_subagent_change(&change).await;
        }
        running_changed
    }

    async fn publish_subagent_change(&self, change: &SubagentChange) -> bool {
        match repository::apply_change(&self.write_pool, self.db_session_id, change).await {
            Ok(Some(applied)) => {
                self.send_subagent_updated(applied.run).await;
                applied.running_changed
            }
            Ok(None) => false,
            Err(error) => {
                error!(
                    self.db_session_id,
                    tool_use_id = %change.tool_use_id,
                    %error,
                    "failed to persist sub-agent change"
                );
                false
            }
        }
    }

    /// Mirror the session's persisted running sub-agent count to the live status
    /// book so every sidebar row updates in real time without polling.
    async fn sync_running_subagents(&self) {
        match repository::count_running(&self.app_state.read_pool, self.db_session_id).await {
            Ok(count) => {
                self.session_status_tx.set_running_subagents(
                    self.db_session_id,
                    self.feature_id,
                    count,
                );
            }
            Err(error) => error!(
                self.db_session_id,
                %error,
                "failed to count running sub-agents"
            ),
        }
    }

    async fn send_subagent_updated(&self, run: SubagentRun) {
        let envelope = WsEnvelope::session_event(&WsSessionEvent::SubagentUpdated(run))
            .expect("sub-agent run serializes");
        self.publish(Message::Text(String::from(envelope).into()))
            .await;
    }
}
