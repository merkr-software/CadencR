use super::*;

impl WsSessionPersistence {
    /// Report transcript durability separately from successful live streaming.
    pub async fn persist_runtime_event(
        &mut self,
        runtime_event: &RuntimeEvent,
    ) -> Result<Option<PersistedEventRef>, TranscriptPersistenceError> {
        let result = self.try_persist_runtime_event(runtime_event).await;
        if result.is_err() {
            self.transcript.record_failure(runtime_event);
        }
        result
    }

    async fn try_persist_runtime_event(
        &mut self,
        runtime_event: &RuntimeEvent,
    ) -> Result<Option<PersistedEventRef>, TranscriptPersistenceError> {
        let session_id = self
            .session_db_id
            .ok_or(TranscriptPersistenceError::MissingSession)?;
        if let Some(event) = runtime_event.stream_event() {
            return self
                .persist_stream_event(
                    session_id,
                    runtime_event.session_id(),
                    event,
                    runtime_event.parent_tool_use_id(),
                )
                .await
                .map(|row| row.map(PersistedEventRef::Message));
        }
        if let Some(message) = runtime_event.user_message() {
            let results = self
                .persist_user_tool_results(session_id, message, runtime_event.parent_tool_use_id())
                .await?;
            return Ok((!results.is_empty()).then_some(PersistedEventRef::ToolResults(results)));
        }
        if let Some(message) = runtime_event.assistant_message() {
            let scope = RuntimeStreamScope::for_event(runtime_event);
            self.prepare_assistant_snapshot(&scope, message)?;
            let tools = if let Some(ptuid) = runtime_event.parent_tool_use_id() {
                self.persist_assistant_subagent(session_id, message, ptuid)
                    .await
            } else {
                self.reconcile_tool_call_content(session_id, message).await
            };
            if let Err(error) = tools {
                // The bounded snapshot proof covers text/thinking only. A later
                // snapshot may omit this tool, so it cannot prove a tool repair.
                self.transcript.unrecoverable = true;
                return Err(error);
            }
            let identities = self
                .reconcile_assistant_text(
                    session_id,
                    &scope,
                    runtime_event.parent_tool_use_id(),
                    message,
                )
                .await?;
            self.transcript.repaired(&scope);
            self.streamed_assistant_content.remove(&scope);
            return Ok(
                (!identities.is_empty()).then_some(PersistedEventRef::AssistantContent(identities))
            );
        }
        if runtime_event.is_compact_boundary() {
            let content = serialize_compact_metadata(runtime_event.compact_metadata());
            let mut tx = self.write_pool.begin().await?;
            let row = sqlx::query(INSERT_MESSAGE_SQL)
                .bind(session_id)
                .bind("system")
                .bind(content)
                .bind("compact_divider")
                .bind(Option::<&str>::None)
                .bind(Option::<&str>::None)
                .bind(Option::<&str>::None)
                .bind(Option::<&str>::None)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE agent_sessions SET was_compacted = 1 WHERE id = ?")
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(Some(PersistedEventRef::Message(PersistedMessageRef {
                id: row.last_insert_rowid(),
            })));
        }
        if runtime_event.is_result() {
            let scope = RuntimeStreamScope::for_event(runtime_event);
            self.transcript.finish_scope(&scope);
            self.pending_mergeable_blocks
                .retain(|(row_scope, _), _| row_scope != &scope);
            self.streamed_assistant_content.remove(&scope);
        }
        Ok(None)
    }
}
