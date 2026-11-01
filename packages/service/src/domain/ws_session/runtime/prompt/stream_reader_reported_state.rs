//! What the CLI reports about the running turn that every device shows from
//! the status book: the model running the root agent, and compaction.

use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamEvent, RuntimeTurnStartedSource};
use crate::domain::session_status::transcript_block_message;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use tracing::error;

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

/// The model a root-agent message reports it runs on. Sub-agents may run on
/// another model; they never speak for the conversation.
fn root_reported_model(event: &RuntimeEvent) -> Option<&str> {
    if event.parent_tool_use_id().is_some() {
        return None;
    }
    match event.stream_event()? {
        RuntimeStreamEvent::MessageStart { model, .. } => {
            model.as_deref().filter(|model| !model.is_empty())
        }
        _ => None,
    }
}

/// `Some(true)` when the event starts a compaction, `Some(false)` when it ends
/// one, `None` when it says nothing about compaction.
fn compaction_signal(event: &RuntimeEvent) -> Option<bool> {
    if matches!(
        event.turn_started_source(),
        Some(RuntimeTurnStartedSource::ContextCompaction | RuntimeTurnStartedSource::ManualCompact)
    ) {
        return Some(true);
    }
    (event.is_compact_boundary() || event.is_result()).then_some(false)
}

impl StreamReaderTask {
    /// Show what the event reports on every device through the status book:
    /// the model on the "Working" line, and compaction — a device that missed
    /// its end still reads the truth from the next event or snapshot, and a
    /// turn going idle always clears it. The book ignores both for an idle
    /// session, so an event that opens a turn is reflected again once it has.
    pub(in crate::domain::ws_session) fn reflect_reported_status(&self, event: &RuntimeEvent) {
        if let Some(active) = compaction_signal(event) {
            self.session_status_tx
                .set_compacting(self.db_session_id, active);
        }
        if let Some(model) = root_reported_model(event) {
            self.session_status_tx
                .observe_model(self.db_session_id, model);
        }
    }

    /// When the model the CLI reports is not the one it reported last, mark
    /// the switch in the transcript before the reply it writes. Runs before
    /// the event is persisted, so the marker precedes the reply in history too.
    pub(in crate::domain::ws_session) async fn observe_reported_model(
        &self,
        state: &mut StreamReaderState,
        event: &RuntimeEvent,
    ) {
        let Some(model) = root_reported_model(event) else {
            return;
        };
        let previous = match state.reported_model.take() {
            Some(known) => known,
            None => {
                match WsSessionPersistence::reported_model(&self.write_pool, self.db_session_id)
                    .await
                {
                    Ok(previous) => previous,
                    // Recording without the previous model would drop a real
                    // switch's marker: leave it to the next report.
                    Err(error) => {
                        error!(self.db_session_id, %error, "failed to read the reported model");
                        return;
                    }
                }
            }
        };
        if previous.as_deref() == Some(model) {
            state.reported_model = Some(previous);
            return;
        }
        state.reported_model = Some(Some(model.to_string()));
        match WsSessionPersistence::record_reported_model(
            &self.write_pool,
            self.db_session_id,
            previous.as_deref(),
            model,
        )
        .await
        {
            Ok(Some(block)) => {
                let _ = self
                    .send_and_mirror(transcript_block_message(self.db_session_id, block))
                    .await;
            }
            Ok(None) => {}
            Err(error) => {
                error!(self.db_session_id, %error, "failed to record the reported model");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{RuntimeEventKind, RuntimeEventMetadata};

    fn message_start(model: Option<&str>, parent: Option<&str>) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::MessageStart {
                    model: model.map(str::to_string),
                    input_tokens: None,
                },
                parent_tool_use_id: parent.map(str::to_string),
            },
        )
    }

    #[test]
    fn only_the_root_agent_reports_the_conversation_model() {
        assert_eq!(
            root_reported_model(&message_start(Some("opus"), None)),
            Some("opus")
        );
        assert_eq!(
            root_reported_model(&message_start(Some("haiku"), Some("task-1"))),
            None
        );
        assert_eq!(root_reported_model(&message_start(None, None)), None);
        assert_eq!(root_reported_model(&message_start(Some(""), None)), None);
    }

    #[test]
    fn a_result_ends_compaction() {
        let result = RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result);
        assert_eq!(compaction_signal(&result), Some(false));
        assert_eq!(compaction_signal(&message_start(Some("opus"), None)), None);
    }
}
