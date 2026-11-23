//! Full text of the live blocks for a viewer that attached mid-stream.
//!
//! A viewer reads its history snapshot before its socket joins the stream,
//! and deltas reach the database up to one flush window after they are
//! published. Without a catch-up, the text published in between is never
//! shown: the next delta extends the snapshot's shorter copy. The reader is
//! the only publisher of this session's stream, so a catch-up sent from it
//! sits exactly between the deltas it contains and the ones that follow.

use axum::extract::ws::Message;
use serde_json::{json, Value};
use tracing::error;

use super::stream_reader_task::{StreamReaderState, StreamReaderTask};
use crate::domain::ws_session::persistence::{LiveBlockContent, WsSessionPersistence};
use crate::domain::ws_session::protocol::{SessionMessagePayload, WsEnvelope, WsSessionEvent};
use crate::domain::ws_session::runtime::helpers::broadcast_session_error;

/// Stream event the desktop applies as "this block's whole text so far".
const CONTENT_BLOCK_SNAPSHOT: &str = "content_block_snapshot";

impl StreamReaderTask {
    pub(super) async fn send_live_catch_up(
        &self,
        state: &mut StreamReaderState,
        persistence: &mut WsSessionPersistence,
    ) {
        // A superseded reader is draining a runtime the session left; its
        // frames would interleave with the live reader's sequence.
        if !self.runtime_is_current().await {
            return;
        }
        self.flush_all_pending_deltas(persistence, false).await;
        let blocks = match persistence.live_block_contents().await {
            Ok(blocks) => blocks,
            Err(error) => {
                error!(self.db_session_id, %error, "could not read live blocks for a viewer catch-up");
                let message = format!(
                    "Text streamed before this view connected could not be reloaded ({error}); reopen the conversation to see all of it."
                );
                broadcast_session_error(
                    &self.feature_senders,
                    self.feature_id,
                    "STREAM_CATCH_UP_FAILED",
                    message,
                )
                .await;
                return;
            }
        };
        for block in &blocks {
            let envelope = state.next_message_envelope(live_block_json(block));
            self.publish(Message::Text(String::from(envelope).into()))
                .await;
        }
    }
}

impl StreamReaderState {
    /// A `session.message` carrying one block, stamped with this reader's
    /// next `seq`. Every frame the reader sends takes one, or a client sees a
    /// gap and resyncs.
    pub(super) fn next_message_envelope(&mut self, block: Value) -> WsEnvelope {
        self.message_seq += 1;
        WsEnvelope::session_event(&WsSessionEvent::Message(SessionMessagePayload {
            blocks: vec![block],
            seq: Some(self.message_seq),
        }))
        .expect("session event payload should serialize")
    }
}

fn live_block_json(block: &LiveBlockContent) -> Value {
    let text_field = if block.message_type == "thinking" {
        "thinking"
    } else {
        "text"
    };
    json!({
        "type": "stream_event",
        "session_id": block.scope.runtime_session_id(),
        "parent_tool_use_id": block.scope.parent_tool_use_id(),
        "agent_message_id": block.row_id,
        "event": {
            "type": CONTENT_BLOCK_SNAPSHOT,
            "index": block.index,
            "streaming": block.open,
            "content_block": {
                "type": block.message_type,
                text_field: block.content,
                "model": block.model,
                "created_at": block.created_at,
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeStreamScope;

    #[test]
    fn a_live_block_is_a_stream_event_with_its_row_identity_and_whole_text() {
        let block = LiveBlockContent {
            scope: RuntimeStreamScope::new(Some("runtime"), Some("task-1")),
            index: 2,
            row_id: 41,
            message_type: "thinking",
            content: "all of it".into(),
            model: Some("model-a".into()),
            created_at: "2026-11-23 10:00:00".into(),
            open: true,
        };
        assert_eq!(
            live_block_json(&block),
            json!({
                "type": "stream_event",
                "session_id": "runtime",
                "parent_tool_use_id": "task-1",
                "agent_message_id": 41,
                "event": {
                    "type": "content_block_snapshot",
                    "index": 2,
                    "streaming": true,
                    "content_block": {
                        "type": "thinking",
                        "thinking": "all of it",
                        "model": "model-a",
                        "created_at": "2026-11-23 10:00:00",
                    },
                },
            })
        );
    }
}
