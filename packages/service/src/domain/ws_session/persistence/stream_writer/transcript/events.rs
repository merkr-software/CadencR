use super::super::super::{PersistedEventRef, PersistedMessageRef, INSERT_MESSAGE_SQL};
use super::super::compact::serialize_compact_metadata;
use super::super::{PersistEventError, TranscriptWriter};
use super::TranscriptPersistenceError;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamScope};

impl TranscriptWriter {
    /// Report transcript durability separately from successful live streaming.
    /// Text/thinking deltas are buffered in memory; call [`Self::flush_due_deltas`]
    /// or [`Self::flush_all_pending_deltas`] to commit coalesced updates.
    pub(in super::super::super) async fn persist_runtime_event_buffered(
        &mut self,
        session_id: Option<i64>,
        runtime_event: &RuntimeEvent,
    ) -> Result<Option<PersistedEventRef>, TranscriptPersistenceError> {
        match self
            .try_persist_runtime_event(session_id, runtime_event)
            .await
        {
            Ok(persisted) => Ok(persisted),
            Err(PersistEventError::RepairableDeltaFlush(error)) => Err(error),
            Err(PersistEventError::EventFailure(error)) => {
                self.transcript.record_failure(runtime_event);
                Err(error)
            }
        }
    }

    async fn try_persist_runtime_event(
        &mut self,
        session_id: Option<i64>,
        runtime_event: &RuntimeEvent,
    ) -> Result<Option<PersistedEventRef>, PersistEventError> {
        let session_id = session_id.ok_or(PersistEventError::EventFailure(
            TranscriptPersistenceError::MissingSession,
        ))?;
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
            if let Err(error) = self.flush_all_pending_deltas().await {
                self.log_boundary_delta_flush_error(session_id, "user_message", &error);
            }
            let results = self
                .persist_user_tool_results(session_id, message, runtime_event.parent_tool_use_id())
                .await
                .map_err(PersistEventError::EventFailure)?;
            return Ok((!results.is_empty()).then_some(PersistedEventRef::ToolResults(results)));
        }
        if let Some(message) = runtime_event.assistant_message() {
            let scope = RuntimeStreamScope::for_event(runtime_event);
            if let Err(error) = self.flush_deltas_for_scope(&scope).await {
                self.log_boundary_delta_flush_error(session_id, "assistant_message", &error);
            }
            self.prepare_assistant_snapshot(&scope, message)
                .map_err(PersistEventError::EventFailure)?;
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
                return Err(PersistEventError::EventFailure(error));
            }
            let identities = self
                .reconcile_assistant_text(
                    session_id,
                    &scope,
                    runtime_event.parent_tool_use_id(),
                    message,
                )
                .await
                .map_err(PersistEventError::EventFailure)?;
            self.transcript.repaired(&scope);
            self.streamed_assistant_content.remove(&scope);
            return Ok(
                (!identities.is_empty()).then_some(PersistedEventRef::AssistantContent(identities))
            );
        }
        if runtime_event.is_compact_boundary() {
            if let Err(error) = self.flush_all_pending_deltas().await {
                self.log_boundary_delta_flush_error(session_id, "compact_boundary", &error);
            }
            return self
                .persist_compact_boundary(session_id, runtime_event)
                .await
                .map_err(PersistEventError::EventFailure);
        }
        if runtime_event.is_result() {
            let scope = RuntimeStreamScope::for_event(runtime_event);
            let flush_result = self.flush_deltas_for_scope(&scope).await;
            self.transcript.finish_scope(&scope);
            self.pending_mergeable_blocks
                .retain(|(row_scope, _), _| row_scope != &scope);
            self.pending_delta_buffers
                .retain(|(row_scope, _), _| row_scope != &scope);
            self.streamed_assistant_content.remove(&scope);
            flush_result.map_err(PersistEventError::EventFailure)?;
        }
        Ok(None)
    }

    async fn persist_compact_boundary(
        &self,
        session_id: i64,
        runtime_event: &RuntimeEvent,
    ) -> Result<Option<PersistedEventRef>, TranscriptPersistenceError> {
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
        Ok(Some(PersistedEventRef::Message(PersistedMessageRef {
            id: row.last_insert_rowid(),
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_helpers::*;
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeContentDelta, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeStreamEvent, RuntimeUserContentBlock, RuntimeUserMessage,
    };
    use crate::domain::ws_session::persistence::{
        TranscriptPersistenceStatus, WsSessionPersistence,
    };

    async fn buffer_pending_delta(p: &mut WsSessionPersistence, scope: &str, ptuid: Option<&str>) {
        p.persist_runtime_event(&stream_event(
            scope,
            ptuid,
            RuntimeStreamEvent::ContentBlockStart {
                index: 0,
                block: RuntimeContentBlock::Text { text: "Hel".into() },
            },
        ))
        .await
        .unwrap();
        // First delta flushes immediately; second delta stays coalesced in memory.
        p.persist_runtime_event(&stream_event(
            scope,
            ptuid,
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text { text: "l".into() },
            },
        ))
        .await
        .unwrap();
        p.persist_runtime_event(&stream_event(
            scope,
            ptuid,
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text {
                    text: "o world".into(),
                },
            },
        ))
        .await
        .unwrap();
    }

    fn user_tool_result_event(scope: &str, tool_use_id: &str, output: &str) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(scope.into()),
                ..Default::default()
            },
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: vec![RuntimeUserContentBlock::ToolResult {
                        tool_use_id: Some(tool_use_id.into()),
                        is_error: false,
                        content: serde_json::json!(output),
                    }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    fn compact_boundary(scope: &str) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(scope.into()),
                ..Default::default()
            },
            RuntimeEventKind::CompactBoundary { metadata: None },
        )
    }

    fn tool_use_start(scope: &str, index: u64, id: &str) -> RuntimeEvent {
        stream_event(
            scope,
            None,
            RuntimeStreamEvent::ContentBlockStart {
                index,
                block: RuntimeContentBlock::ToolUse {
                    id: id.into(),
                    name: "Read".into(),
                    input: serde_json::json!({ "path": "a.rs" }),
                },
            },
        )
    }

    #[tokio::test]
    async fn failed_delta_flush_before_user_message_still_persists_tool_result() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        buffer_pending_delta(&mut p, "root", None).await;

        fail_statement(&pool, "UPDATE").await;
        let persisted = p
            .persist_runtime_event(&user_tool_result_event("root", "tu-1", "ok"))
            .await
            .expect("user tool_result must persist despite prior delta flush failure");
        assert!(
            matches!(persisted, Some(PersistedEventRef::ToolResults(ref ids)) if ids.len() == 1)
        );
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );

        let tool_results: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE message_type = 'tool_result' AND tool_use_id = 'tu-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tool_results, 1);

        recover_database(&pool).await;
        p.persist_runtime_event(&complete("root", vec![text("Hello world")]))
            .await
            .unwrap();
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }

    #[tokio::test]
    async fn failed_delta_flush_before_compact_boundary_still_persists_divider() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        buffer_pending_delta(&mut p, "root", None).await;

        fail_statement(&pool, "UPDATE").await;
        let persisted = p
            .persist_runtime_event(&compact_boundary("root"))
            .await
            .expect("compact boundary must persist despite prior delta flush failure");
        assert!(matches!(persisted, Some(PersistedEventRef::Message(_))));
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );

        let dividers: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE message_type = 'compact_divider'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let was_compacted: i64 =
            sqlx::query_scalar("SELECT was_compacted FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(dividers, 1);
        assert_eq!(was_compacted, 1);
    }

    #[tokio::test]
    async fn failed_delta_flush_before_tool_use_start_still_persists_tool_call() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        buffer_pending_delta(&mut p, "root", None).await;

        fail_statement(&pool, "UPDATE").await;
        let persisted = p
            .persist_runtime_event(&tool_use_start("root", 1, "tu-tool"))
            .await
            .expect("tool_call must persist despite prior delta flush failure");
        assert!(matches!(persisted, Some(PersistedEventRef::Message(_))));
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );

        let calls: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE message_type = 'tool_call' AND tool_use_id = 'tu-tool'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn boundary_persistence_failure_marks_unrecoverable_even_after_delta_flush_failure() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        buffer_pending_delta(&mut p, "root", None).await;

        sqlx::raw_sql(
            "CREATE TRIGGER fail_update BEFORE UPDATE ON agent_messages
             BEGIN SELECT RAISE(ABORT, 'update failed'); END;
             CREATE TRIGGER fail_insert BEFORE INSERT ON agent_messages
             BEGIN SELECT RAISE(ABORT, 'insert failed'); END;",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(p
            .persist_runtime_event(&tool_use_start("root", 1, "tu-lost"))
            .await
            .is_err());
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Failed)
        );
    }

    #[tokio::test]
    async fn failed_delta_flush_on_result_marks_durability_failed() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        buffer_pending_delta(&mut p, "root", None).await;

        fail_statement(&pool, "UPDATE").await;
        assert!(p.persist_runtime_event(&result("root")).await.is_err());
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Failed)
        );
    }

    #[tokio::test]
    async fn subagent_delta_flush_failure_on_root_user_message_stays_repairable() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        buffer_pending_delta(&mut p, "root", Some("sub-1")).await;

        fail_statement(&pool, "UPDATE").await;
        let persisted = p
            .persist_runtime_event(&user_tool_result_event("root", "tu-root", "ok"))
            .await
            .expect("root user_message must persist when subagent delta flush fails");
        assert!(
            matches!(persisted, Some(PersistedEventRef::ToolResults(ref ids)) if ids.len() == 1)
        );
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );

        recover_database(&pool).await;
        let subagent_complete = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                ..Default::default()
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![text("Hello world")],
                },
                parent_tool_use_id: Some("sub-1".into()),
            },
        );
        p.persist_runtime_event(&subagent_complete).await.unwrap();
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }
}
