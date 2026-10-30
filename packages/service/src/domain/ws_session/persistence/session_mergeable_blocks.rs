impl WsSessionPersistence {
    async fn persist_content_block_start(
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

    async fn persist_content_block_delta(
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

    async fn insert_mergeable_block(
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
        let row = Self::insert_message(
            &self.write_pool,
            session_id,
            "assistant",
            content,
            message_type.db_value(),
            None,
            None,
            ptuid,
            model,
        )
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

    async fn append_mergeable_delta(
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

    async fn insert_tool_call_block(
        &mut self,
        session_id: i64,
        stream_scope: &RuntimeStreamScope,
        index: u64,
        id: &str,
        name: &str,
        input: &serde_json::Value,
        ptuid: Option<&str>,
        model: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        let content = serde_json::to_string(input).unwrap_or_default();
        let row_id = crate::domain::features::repository::persist_tool_call_message(
            &self.write_pool,
            crate::domain::features::repository::ToolCallMessage {
                session_id,
                tool_use_id: id,
                tool_name: name,
                content: &content,
                parent_tool_use_id: ptuid,
                model,
            },
        )
        .await?;

        let key = (stream_scope.clone(), index);
        self.pending_tool_row_ids.insert(key.clone(), row_id);
        self.pending_tool_inputs
            .insert(key, RuntimeToolInputBuffer::new(name, input));

        if !self.file_change_marked && is_file_change_tool_name(name) {
            self.mark_has_file_changes(session_id).await;
        }

        Ok(Some(PersistedMessageRef { id: row_id }))
    }

    async fn persist_tool_input_delta(
        &mut self,
        stream_scope: &RuntimeStreamScope,
        index: u64,
        partial_json: &str,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        let key = (stream_scope.clone(), index);
        let parsed = self
            .pending_tool_inputs
            .get_mut(&key)
            .and_then(|buffer| buffer.apply_delta(partial_json));

        let Some(row_id) = self.pending_tool_row_ids.get(&key).copied() else {
            return Ok(None);
        };
        if let Some(parsed) = parsed {
            let content = serde_json::to_string(&parsed).unwrap_or_default();
            let result = sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ?")
                .bind(&content)
                .bind(row_id)
                .execute(&self.write_pool)
                .await;
            if result?.rows_affected() != 1 {
                return Err(TranscriptPersistenceError::MissingRow(row_id));
            }
        }
        Ok(Some(PersistedMessageRef { id: row_id }))
    }

    async fn persist_content_block_stop(
        &mut self,
        stream_scope: &RuntimeStreamScope,
        index: u64,
    ) -> Result<(), TranscriptPersistenceError> {
        let key = (stream_scope.clone(), index);
        self.pending_mergeable_blocks.remove(&key);
        if let Some(buffer) = self.pending_tool_inputs.remove(&key) {
            self.flush_tool_input_buffer(&key, buffer).await?;
        }
        self.pending_tool_row_ids.remove(&key);
        Ok(())
    }

    async fn flush_tool_input_buffer(
        &self,
        key: &(RuntimeStreamScope, u64),
        buffer: RuntimeToolInputBuffer,
    ) -> Result<(), TranscriptPersistenceError> {
        if buffer.accumulated().is_empty() {
            return Ok(());
        }
        let Some(&row_id) = self.pending_tool_row_ids.get(key) else {
            return Ok(());
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(buffer.accumulated()) else {
            return Ok(());
        };
        let is_trivial_object = parsed.as_object().map_or(false, |obj| obj.is_empty());
        if is_trivial_object {
            return Ok(());
        }
        let content = serde_json::to_string(&parsed).unwrap_or_default();
        let result = sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ?")
            .bind(&content)
            .bind(row_id)
            .execute(&self.write_pool)
            .await;
        if result?.rows_affected() != 1 {
            return Err(TranscriptPersistenceError::MissingRow(row_id));
        }
        Ok(())
    }
}
