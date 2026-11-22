use super::super::message_store::insert_message;
use super::super::PersistedMessageRef;
use super::super::TranscriptPersistenceError;
use super::{
    MergeableMessageType, PendingDeltaBuffer, PendingMergeableBlock, TranscriptWriter,
    DELTA_FLUSH_INTERVAL, DELTA_FLUSH_MAX_BYTES,
};
use crate::domain::agents::adapter::RuntimeStreamScope;

#[bon::bon]
impl TranscriptWriter {
    #[builder]
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
        self.pending_delta_buffers
            .remove(&(stream_scope.clone(), index));
        Ok(Some(PersistedMessageRef { id: pending.row_id }))
    }

    pub(super) async fn append_mergeable_delta(
        &mut self,
        session_id: i64,
        stream_scope: RuntimeStreamScope,
        index: u64,
        message_type: MergeableMessageType,
        delta: &str,
        ptuid: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, TranscriptPersistenceError> {
        if self.transcript.is_damaged(&stream_scope) {
            return Err(TranscriptPersistenceError::AwaitingReconciliation);
        }
        let key = (stream_scope, index);
        if let Some(pending) = self.pending_mergeable_blocks.get(&key).copied() {
            if pending.message_type == message_type {
                let entry =
                    self.pending_delta_buffers
                        .entry(key)
                        .or_insert_with(|| PendingDeltaBuffer {
                            row_id: pending.row_id,
                            buffered: String::new(),
                            last_flush_at: None,
                        });
                entry.row_id = pending.row_id;
                entry.buffered.push_str(delta);
                return Ok(Some(PersistedMessageRef { id: pending.row_id }));
            }
            // Block type changed on the same index: persist any buffered bytes
            // belonging to the previous block before inserting the new one.
            self.flush_delta_for_key(&key).await?;
        }

        let stream_scope = key.0;
        let current_model = self.current_models.get(&stream_scope).cloned();
        self.insert_mergeable_block()
            .session_id(session_id)
            .stream_scope(&stream_scope)
            .index(index)
            .message_type(message_type)
            .content(delta)
            .maybe_ptuid(ptuid)
            .maybe_model(current_model.as_deref())
            .call()
            .await
    }

    pub(in super::super) fn next_delta_flush_deadline(&self) -> Option<tokio::time::Instant> {
        if self.pending_delta_buffers.is_empty() {
            return None;
        }
        let mut now = None;
        self.pending_delta_buffers
            .values()
            .filter(|buf| !buf.buffered.is_empty())
            .map(|buf| match buf.last_flush_at {
                Some(last) => last + DELTA_FLUSH_INTERVAL,
                None => *now.get_or_insert_with(tokio::time::Instant::now),
            })
            .min()
    }

    pub(super) async fn flush_delta_for_key(
        &mut self,
        key: &(RuntimeStreamScope, u64),
    ) -> Result<(), TranscriptPersistenceError> {
        let Some((row_id, chunk)) = self.pending_delta_buffers.get_mut(key).and_then(|buf| {
            if buf.buffered.is_empty() {
                None
            } else {
                Some((buf.row_id, std::mem::take(&mut buf.buffered)))
            }
        }) else {
            return Ok(());
        };
        if self.transcript.is_damaged(&key.0) {
            return Err(TranscriptPersistenceError::AwaitingReconciliation);
        }
        let result = sqlx::query("UPDATE agent_messages SET content = content || ? WHERE id = ?")
            .bind(&chunk)
            .bind(row_id)
            .execute(&self.write_pool)
            .await;
        match result {
            Ok(done) if done.rows_affected() == 1 => {
                if let Some(buf) = self.pending_delta_buffers.get_mut(key) {
                    buf.last_flush_at = Some(tokio::time::Instant::now());
                }
                Ok(())
            }
            Ok(_) => {
                self.mark_delta_flush_damaged(&key.0);
                Err(TranscriptPersistenceError::MissingRow(row_id))
            }
            Err(error) => {
                self.mark_delta_flush_damaged(&key.0);
                Err(TranscriptPersistenceError::Database(error))
            }
        }
    }

    async fn flush_deltas_where(
        &mut self,
        predicate: impl Fn(&(RuntimeStreamScope, u64), &PendingDeltaBuffer) -> bool,
    ) -> Result<(), TranscriptPersistenceError> {
        if self.pending_delta_buffers.is_empty() {
            return Ok(());
        }
        let keys: Vec<(RuntimeStreamScope, u64)> = self
            .pending_delta_buffers
            .iter()
            .filter(|(key, buf)| !buf.buffered.is_empty() && predicate(key, buf))
            .map(|(key, _)| key.clone())
            .collect();
        self.flush_delta_keys(keys).await
    }

    pub(in super::super) async fn flush_due_deltas(
        &mut self,
    ) -> Result<(), TranscriptPersistenceError> {
        if self.pending_delta_buffers.is_empty() {
            return Ok(());
        }
        let now = tokio::time::Instant::now();
        self.flush_deltas_where(|_, buf| match buf.last_flush_at {
            None => true,
            Some(last) => {
                now.saturating_duration_since(last) >= DELTA_FLUSH_INTERVAL
                    || buf.buffered.len() >= DELTA_FLUSH_MAX_BYTES
            }
        })
        .await
    }

    pub(super) async fn flush_deltas_for_scope(
        &mut self,
        scope: &RuntimeStreamScope,
    ) -> Result<(), TranscriptPersistenceError> {
        self.flush_deltas_where(|(row_scope, _), _| row_scope == scope)
            .await
    }

    pub(in super::super) async fn flush_all_pending_deltas(
        &mut self,
    ) -> Result<(), TranscriptPersistenceError> {
        self.flush_deltas_where(|_, _| true).await
    }

    async fn flush_delta_keys(
        &mut self,
        keys: Vec<(RuntimeStreamScope, u64)>,
    ) -> Result<(), TranscriptPersistenceError> {
        let mut first_error = None;
        for key in keys {
            if let Err(error) = self.flush_delta_for_key(&key).await {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn mark_delta_flush_damaged(&mut self, scope: &RuntimeStreamScope) {
        self.transcript.record_mergeable_failure(scope);
        self.pending_delta_buffers
            .retain(|(row_scope, _), _| row_scope != scope);
    }
}

#[cfg(test)]
mod tests {
    use super::super::events::session_events_tests::{setup_test_db, stream_event};
    use super::super::transcript::TranscriptPersistenceStatus;
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent,
        RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use sqlx::SqlitePool;

    async fn attach_update_counter(pool: &SqlitePool) {
        sqlx::raw_sql(
            "CREATE TABLE update_counter (count INTEGER NOT NULL);
             INSERT INTO update_counter (count) VALUES (0);
             CREATE TRIGGER count_message_updates AFTER UPDATE ON agent_messages
             BEGIN UPDATE update_counter SET count = count + 1; END;",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn update_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT count FROM update_counter")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn message_content(pool: &SqlitePool) -> String {
        sqlx::query_scalar("SELECT content FROM agent_messages ORDER BY id LIMIT 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    fn text_start(text: &str) -> RuntimeEvent {
        stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockStart {
                index: 0,
                block: RuntimeContentBlock::Text { text: text.into() },
            },
        )
    }

    fn text_delta(text: &str) -> RuntimeEvent {
        stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text { text: text.into() },
            },
        )
    }

    fn thinking_start(thinking: &str) -> RuntimeEvent {
        stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockStart {
                index: 0,
                block: RuntimeContentBlock::Thinking {
                    thinking: thinking.into(),
                },
            },
        )
    }

    fn thinking_delta(thinking: &str) -> RuntimeEvent {
        stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Thinking {
                    thinking: thinking.into(),
                },
            },
        )
    }

    fn block_stop() -> RuntimeEvent {
        stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockStop { index: 0 },
        )
    }

    fn turn_result() -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                ..Default::default()
            },
            RuntimeEventKind::Result,
        )
    }

    #[tokio::test]
    async fn coalesces_rapid_text_deltas_and_flushes_once_on_block_stop() {
        let pool = setup_test_db().await;
        attach_update_counter(&pool).await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        p.persist_runtime_event(&text_start("a")).await.unwrap();
        // First delta flushes immediately so first token lands right away.
        p.persist_runtime_event(&text_delta("b")).await.unwrap();
        assert_eq!(update_count(&pool).await, 1);
        assert_eq!(message_content(&pool).await, "ab");

        // Rapid subsequent deltas within 200ms coalesce in memory with 0 SQLite UPDATEs.
        for chunk in ["c", "d", "e", "f", "g", "h"] {
            p.persist_runtime_event(&text_delta(chunk)).await.unwrap();
        }
        assert_eq!(update_count(&pool).await, 1);
        assert!(p.next_delta_flush_deadline().is_some());

        // Block stop flushes all coalesced chunks in a single UPDATE.
        p.persist_runtime_event(&block_stop()).await.unwrap();
        assert_eq!(update_count(&pool).await, 2);
        assert_eq!(message_content(&pool).await, "abcdefgh");
        assert!(p.next_delta_flush_deadline().is_none());
    }

    #[tokio::test]
    async fn coalesces_thinking_deltas_and_flushes_on_turn_result_and_explicit_flush() {
        let pool = setup_test_db().await;
        attach_update_counter(&pool).await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        p.persist_runtime_event(&thinking_start("step 1"))
            .await
            .unwrap();
        p.persist_runtime_event(&thinking_delta(", 2"))
            .await
            .unwrap();
        assert_eq!(update_count(&pool).await, 1);

        p.persist_runtime_event(&thinking_delta(", 3"))
            .await
            .unwrap();
        p.persist_runtime_event(&thinking_delta(", 4"))
            .await
            .unwrap();
        assert_eq!(update_count(&pool).await, 1);

        // Explicit flush persists buffered chunks immediately.
        p.flush_all_pending_deltas().await.unwrap();
        assert_eq!(update_count(&pool).await, 2);
        assert_eq!(message_content(&pool).await, "step 1, 2, 3, 4");

        // Another buffered delta followed directly by Result (no ContentBlockStop).
        p.persist_runtime_event(&thinking_delta(", 5"))
            .await
            .unwrap();
        assert_eq!(update_count(&pool).await, 2);
        p.persist_runtime_event(&turn_result()).await.unwrap();
        assert_eq!(update_count(&pool).await, 3);
        assert_eq!(message_content(&pool).await, "step 1, 2, 3, 4, 5");
    }

    #[tokio::test]
    async fn flushes_large_delta_immediately_when_byte_threshold_is_reached() {
        let pool = setup_test_db().await;
        attach_update_counter(&pool).await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        p.persist_runtime_event(&text_start("start")).await.unwrap();
        p.persist_runtime_event(&text_delta("1")).await.unwrap();
        assert_eq!(update_count(&pool).await, 1);

        let large = "x".repeat(DELTA_FLUSH_MAX_BYTES);
        p.persist_runtime_event(&text_delta(&large)).await.unwrap();
        assert_eq!(update_count(&pool).await, 2);
        assert_eq!(
            message_content(&pool).await.len(),
            6 + DELTA_FLUSH_MAX_BYTES
        );
    }

    #[tokio::test]
    async fn failed_coalesced_flush_on_block_stop_remains_repairable_by_assistant_message() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        p.persist_runtime_event(&text_start("Hel")).await.unwrap();
        p.persist_runtime_event(&text_delta("l")).await.unwrap();
        // Buffered in memory.
        p.persist_runtime_event(&text_delta("o world"))
            .await
            .unwrap();

        sqlx::query(
            "CREATE TRIGGER fail_update BEFORE UPDATE ON agent_messages \
             BEGIN SELECT RAISE(ABORT, 'disk busy'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(p.persist_runtime_event(&block_stop()).await.is_err());
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );

        sqlx::query("DROP TRIGGER fail_update")
            .execute(&pool)
            .await
            .unwrap();

        let complete = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                ..Default::default()
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Text {
                        text: "Hello world".into(),
                    }],
                },
                parent_tool_use_id: None,
            },
        );
        p.persist_runtime_event(&complete).await.unwrap();
        assert_eq!(message_content(&pool).await, "Hello world");
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }
}
