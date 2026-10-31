use super::super::PersistedMessageRef;
use super::super::TranscriptPersistenceError;
use super::TranscriptWriter;
use crate::domain::agents::adapter::{
    is_file_change_tool_name, RuntimeStreamScope, RuntimeToolInputBuffer,
};

impl TranscriptWriter {
    pub(super) async fn insert_tool_call_block(
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

    pub(super) async fn persist_content_block_stop(
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
}

#[cfg(test)]
mod tests {
    use super::super::events::session_events_tests::{setup_test_db, stream_event};
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent,
        RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent, RuntimeToolInputBuffer,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use sqlx::{Row, SqlitePool};

    #[tokio::test]
    async fn content_block_start_reuses_existing_tool_call_row() {
        let pool = setup_test_db().await;
        sqlx::query(
            "INSERT INTO agent_messages
             (session_id, role, content, message_type, tool_name, tool_use_id)
             VALUES (1, 'assistant', '{}', 'tool_call', 'ExitPlanMode', 'tool_existing')",
        )
        .execute(&pool)
        .await
        .expect("insert existing row");
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_existing".to_string(),
                        name: "ExitPlanMode".to_string(),
                        input: serde_json::json!({ "plan": "ready" }),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        let row: (i64, String) = sqlx::query_as(
            "SELECT COUNT(*), MAX(content) FROM agent_messages
             WHERE session_id = 1 AND tool_use_id = 'tool_existing'",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch row summary");
        assert_eq!(row, (1, r#"{"plan":"ready"}"#.to_string()));
    }

    #[tokio::test]
    async fn content_block_start_preserves_existing_enriched_tool_call_row() {
        let pool = setup_test_db().await;
        sqlx::query(
            "INSERT INTO agent_messages
             (session_id, role, content, message_type, tool_name, tool_use_id)
             VALUES (1, 'assistant', '{\"command\":\"x\",\"plan\":\"ready\"}', 'tool_call', 'ExitPlanMode', 'tool_existing')",
        )
        .execute(&pool)
        .await
        .expect("insert enriched row");
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_existing".to_string(),
                        name: "ExitPlanMode".to_string(),
                        input: serde_json::json!({ "command": "x" }),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        let row: (i64, String) = sqlx::query_as(
            "SELECT COUNT(*), MAX(content) FROM agent_messages
             WHERE session_id = 1 AND tool_use_id = 'tool_existing'",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch row summary");
        assert_eq!(row, (1, r#"{"command":"x","plan":"ready"}"#.to_string()));
    }

    fn assistant_event(
        runtime_session_id: &str,
        parent_tool_use_id: Option<&str>,
        message: RuntimeAssistantMessage,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(runtime_session_id.to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::AssistantMessage {
                message,
                parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
            },
        )
    }

    async fn fetch_tool_call_content(pool: &SqlitePool, tool_use_id: &str) -> String {
        sqlx::query("SELECT content FROM agent_messages WHERE tool_use_id = ?")
            .bind(tool_use_id)
            .fetch_one(pool)
            .await
            .expect("fetch tool_call row")
            .get::<String, _>("content")
    }

    #[tokio::test]
    async fn content_block_stop_does_not_clobber_reconciled_content() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "ses_1",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_edit_2".to_string(),
                        name: "Edit".to_string(),
                        input: serde_json::json!({}),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        // No deltas advance the accumulator (simulates the failure mode where
        // every fragment is rejected by the buffer).

        persistence
            .persist_runtime_event(&assistant_event(
                "ses_1",
                None,
                RuntimeAssistantMessage {
                    model: Some("claude-sonnet-4".to_string()),
                    content: vec![RuntimeContentBlock::ToolUse {
                        id: "tool_edit_2".to_string(),
                        name: "Edit".to_string(),
                        input: serde_json::json!({
                            "file_path": "/bar.ts",
                            "old_string": "x",
                            "new_string": "y",
                        }),
                    }],
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&stream_event(
                "ses_1",
                None,
                RuntimeStreamEvent::ContentBlockStop { index: 0 },
            ))
            .await
            .expect("persist runtime event");

        let content = fetch_tool_call_content(&pool, "tool_edit_2").await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).expect("valid json"),
            serde_json::json!({
                "file_path": "/bar.ts",
                "old_string": "x",
                "new_string": "y",
            })
        );
    }

    #[tokio::test]
    async fn content_block_stop_does_not_clobber_subagent_reconciled_content() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_sub_1".to_string(),
                        name: "Edit".to_string(),
                        input: serde_json::json!({}),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&assistant_event(
                "child_a",
                Some("task_a"),
                RuntimeAssistantMessage {
                    model: Some("claude-sonnet-4".to_string()),
                    content: vec![RuntimeContentBlock::ToolUse {
                        id: "tool_sub_1".to_string(),
                        name: "Edit".to_string(),
                        input: serde_json::json!({
                            "file_path": "/baz.ts",
                            "old_string": "p",
                            "new_string": "q",
                        }),
                    }],
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockStop { index: 0 },
            ))
            .await
            .expect("persist runtime event");

        let content = fetch_tool_call_content(&pool, "tool_sub_1").await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).expect("valid json"),
            serde_json::json!({
                "file_path": "/baz.ts",
                "old_string": "p",
                "new_string": "q",
            })
        );
    }
    #[tokio::test]
    async fn bash_output_deltas_preserve_command_input() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "cmd".to_string(),
                        name: "Bash".to_string(),
                        input: serde_json::json!({
                            "command": "printf hi",
                            "status": "running"
                        }),
                    },
                },
            ))
            .await
            .expect("persist runtime event");
        persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::InputJson {
                        partial_json: serde_json::json!({ "output": "hi" }).to_string(),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        let row = sqlx::query(
            "SELECT content FROM agent_messages WHERE session_id = 1 AND tool_use_id = 'cmd'",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch bash row");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row.get::<String, _>("content"))
                .expect("valid json"),
            serde_json::json!({
                "command": "printf hi",
                "status": "running",
                "output": "hi"
            })
        );
    }

    #[test]
    fn bash_output_delta_append_patches_accumulate_output() {
        let mut buffer = RuntimeToolInputBuffer::new(
            "Bash",
            &serde_json::json!({
                "command": "printf hi",
                "status": "running"
            }),
        );

        for chunk in ["hi", " there"] {
            buffer.apply_delta(
                &serde_json::json!({
                    "__cadencr_output_delta": chunk,
                    "status": "running"
                })
                .to_string(),
            );
        }

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(buffer.accumulated()).expect("valid json"),
            serde_json::json!({
                "command": "printf hi",
                "status": "running",
                "output": "hi there"
            })
        );
    }
}
