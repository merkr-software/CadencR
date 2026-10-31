use super::super::message_store::insert_message;
use super::super::PersistedMessageRef;
use super::super::TranscriptPersistenceError;
use super::MergeableMessageType;
use super::PendingMergeableBlock;
use super::TranscriptWriter;
use crate::domain::agents::adapter::RuntimeStreamScope;

impl TranscriptWriter {
    pub(super) async fn insert_mergeable_block(
        &mut self,
        session_id: i64,
        stream_scope: &RuntimeStreamScope,
        index: u64,
        message_type: MergeableMessageType,
        content: &str,
        ptuid: Option<&str>,
        model: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        self.transcript
            .observe_start(stream_scope, index, message_type, content)?;
        if self.transcript.is_damaged(stream_scope) {
            return Err(TranscriptPersistenceError::AwaitingReconciliation);
        }
        let row = insert_message()
            .pool(&self.write_pool)
            .session_id(session_id)
            .role("assistant")
            .content(content)
            .message_type(message_type.db_value())
            .maybe_parent_tool_use_id(ptuid)
            .maybe_model(model)
            .call()
            .await?;
        let pending = PendingMergeableBlock {
            row_id: row.last_insert_rowid(),
            message_type,
        };
        if self
            .transcript
            .expected
            .contains_key(&(stream_scope.clone(), index))
        {
            self.transcript
                .rows
                .insert((stream_scope.clone(), index), pending);
        }
        self.streamed_assistant_content.insert(stream_scope.clone());
        self.pending_mergeable_blocks
            .insert((stream_scope.clone(), index), pending);
        Ok(Some(PersistedMessageRef { id: pending.row_id }))
    }

    pub(super) async fn append_mergeable_delta(
        &mut self,
        session_id: i64,
        stream_scope: &RuntimeStreamScope,
        index: u64,
        message_type: MergeableMessageType,
        delta: &str,
        ptuid: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        if self.transcript.is_damaged(stream_scope) {
            return Err(TranscriptPersistenceError::AwaitingReconciliation);
        }
        let key = (stream_scope.clone(), index);
        if let Some(pending) = self.pending_mergeable_blocks.get(&key).copied() {
            if pending.message_type == message_type {
                let result =
                    sqlx::query("UPDATE agent_messages SET content = content || ? WHERE id = ?")
                        .bind(delta)
                        .bind(pending.row_id)
                        .execute(&self.write_pool)
                        .await;
                if result?.rows_affected() != 1 {
                    return Err(TranscriptPersistenceError::MissingRow(pending.row_id));
                }
                return Ok(Some(PersistedMessageRef { id: pending.row_id }));
            }
        }

        let current_model = self.current_models.get(stream_scope).cloned();
        self.insert_mergeable_block(
            session_id,
            stream_scope,
            index,
            message_type,
            delta,
            ptuid,
            current_model.as_deref(),
        )
        .await
    }
}
