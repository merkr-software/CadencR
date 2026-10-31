use super::super::PersistedMessageRef;
use super::super::TranscriptPersistenceError;
use super::MergeableMessageType;
use super::TranscriptWriter;
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeContentDelta, RuntimeStreamScope,
};

impl TranscriptWriter {
    pub(super) async fn persist_content_block_start(
        &mut self,
        session_id: i64,
        stream_scope: &RuntimeStreamScope,
        index: u64,
        block: &RuntimeContentBlock,
        ptuid: Option<&str>,
        model: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        match block {
            RuntimeContentBlock::Text { text } => {
                self.insert_mergeable_block(
                    session_id,
                    stream_scope,
                    index,
                    MergeableMessageType::Text,
                    text,
                    ptuid,
                    model,
                )
                .await
            }
            RuntimeContentBlock::Thinking { thinking } => {
                self.insert_mergeable_block(
                    session_id,
                    stream_scope,
                    index,
                    MergeableMessageType::Thinking,
                    thinking,
                    ptuid,
                    model,
                )
                .await
            }
            RuntimeContentBlock::ToolUse { id, name, input } => {
                self.insert_tool_call_block(
                    session_id,
                    stream_scope,
                    index,
                    id,
                    name,
                    input,
                    ptuid,
                    model,
                )
                .await
            }
            RuntimeContentBlock::Other => Ok(None),
        }
    }

    pub(super) async fn persist_content_block_delta(
        &mut self,
        session_id: i64,
        stream_scope: &RuntimeStreamScope,
        index: u64,
        delta: &RuntimeContentDelta,
        ptuid: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        match delta {
            RuntimeContentDelta::Text { text } => {
                self.transcript.observe_delta(
                    stream_scope,
                    index,
                    MergeableMessageType::Text,
                    text,
                )?;
                self.append_mergeable_delta(
                    session_id,
                    stream_scope,
                    index,
                    MergeableMessageType::Text,
                    text,
                    ptuid,
                )
                .await
            }
            RuntimeContentDelta::Thinking { thinking } => {
                self.transcript.observe_delta(
                    stream_scope,
                    index,
                    MergeableMessageType::Thinking,
                    thinking,
                )?;
                self.append_mergeable_delta(
                    session_id,
                    stream_scope,
                    index,
                    MergeableMessageType::Thinking,
                    thinking,
                    ptuid,
                )
                .await
            }
            RuntimeContentDelta::InputJson { partial_json } => {
                self.persist_tool_input_delta(stream_scope, index, partial_json)
                    .await
            }
        }
    }
}
