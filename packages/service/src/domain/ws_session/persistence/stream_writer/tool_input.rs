use super::super::PersistedMessageRef;
use super::super::TranscriptPersistenceError;
use super::TranscriptWriter;
use crate::domain::agents::adapter::{RuntimeStreamScope, RuntimeToolInputBuffer};

impl TranscriptWriter {
    pub(super) async fn persist_tool_input_delta(
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

    pub(super) async fn flush_tool_input_buffer(
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

#[cfg(test)]
mod tests {
    use super::super::events::session_events_tests::{setup_test_db, stream_event};
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeContentDelta, RuntimeStreamEvent,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use sqlx::{Row, SqlitePool};

    #[tokio::test]
    async fn tool_json_deltas_support_chunked_replacement_snapshots() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_a".to_string(),
                        name: "Task".to_string(),
                        input: serde_json::json!({ "status": "pending" }),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::InputJson {
                        partial_json: r#"{"nested": "#.to_string(),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::InputJson {
                        partial_json: r#"{"key":"value"}}"#.to_string(),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        let row = sqlx::query(
            "SELECT content FROM agent_messages WHERE session_id = 1 AND tool_use_id = 'tool_a'",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch tool row");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row.get::<String, _>("content"))
                .expect("valid json"),
            serde_json::json!({ "nested": { "key": "value" } })
        );
    }

    #[tokio::test]
    async fn tool_json_deltas_do_not_collide_between_child_sessions() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::MessageStart {
                    model: Some("model-a".to_string()),
                    input_tokens: None,
                },
            ))
            .await
            .expect("persist runtime event");
        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_a".to_string(),
                        name: "Grep".to_string(),
                        input: serde_json::json!({ "status": "pending" }),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&stream_event(
                "child_b",
                Some("task_b"),
                RuntimeStreamEvent::MessageStart {
                    model: Some("model-b".to_string()),
                    input_tokens: None,
                },
            ))
            .await
            .expect("persist runtime event");
        persistence
            .persist_runtime_event(&stream_event(
                "child_b",
                Some("task_b"),
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_b".to_string(),
                        name: "Read".to_string(),
                        input: serde_json::json!({ "status": "pending" }),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&stream_event(
                "child_a",
                Some("task_a"),
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::InputJson {
                        partial_json: r#"{"pattern":"foo"}"#.to_string(),
                    },
                },
            ))
            .await
            .expect("persist runtime event");
        persistence
            .persist_runtime_event(&stream_event(
                "child_b",
                Some("task_b"),
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::InputJson {
                        partial_json: r#"{"file_path":"/tmp/test"}"#.to_string(),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        let rows = sqlx::query(
            "SELECT tool_use_id, tool_name, content, parent_tool_use_id FROM agent_messages WHERE session_id = 1 AND message_type = 'tool_call' ORDER BY tool_use_id",
        )
        .fetch_all(&pool)
        .await
        .expect("fetch tool rows");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<String, _>("tool_use_id"), "tool_a");
        assert_eq!(rows[0].get::<String, _>("tool_name"), "Grep");
        assert_eq!(rows[0].get::<String, _>("parent_tool_use_id"), "task_a");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rows[0].get::<String, _>("content"))
                .expect("valid json"),
            serde_json::json!({ "pattern": "foo" })
        );

        assert_eq!(rows[1].get::<String, _>("tool_use_id"), "tool_b");
        assert_eq!(rows[1].get::<String, _>("tool_name"), "Read");
        assert_eq!(rows[1].get::<String, _>("parent_tool_use_id"), "task_b");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rows[1].get::<String, _>("content"))
                .expect("valid json"),
            serde_json::json!({ "file_path": "/tmp/test" })
        );
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
    async fn tool_json_deltas_recover_from_anthropic_fragmentation() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&stream_event(
                "ses_1",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_edit_1".to_string(),
                        name: "Edit".to_string(),
                        input: serde_json::json!({}),
                    },
                },
            ))
            .await
            .expect("persist runtime event");

        for fragment in [
            r#"{"file_path":"#,
            r#""/foo.ts","#,
            r#""old_string":"a","new_string":"b"}"#,
        ] {
            persistence
                .persist_runtime_event(&stream_event(
                    "ses_1",
                    None,
                    RuntimeStreamEvent::ContentBlockDelta {
                        index: 0,
                        delta: RuntimeContentDelta::InputJson {
                            partial_json: fragment.to_string(),
                        },
                    },
                ))
                .await
                .expect("persist runtime event");
        }

        persistence
            .persist_runtime_event(&stream_event(
                "ses_1",
                None,
                RuntimeStreamEvent::ContentBlockStop { index: 0 },
            ))
            .await
            .expect("persist runtime event");

        let content = fetch_tool_call_content(&pool, "tool_edit_1").await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).expect("valid json"),
            serde_json::json!({
                "file_path": "/foo.ts",
                "old_string": "a",
                "new_string": "b",
            })
        );
    }
}
