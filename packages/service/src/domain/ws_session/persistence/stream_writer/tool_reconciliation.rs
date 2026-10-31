use super::super::TranscriptPersistenceError;
use super::TranscriptWriter;
use crate::domain::agents::adapter::{RuntimeAssistantMessage, RuntimeContentBlock};

impl TranscriptWriter {
    pub(super) async fn reconcile_tool_call_content(
        &self,
        session_id: i64,
        message: &RuntimeAssistantMessage,
    ) -> Result<(), TranscriptPersistenceError> {
        for block in &message.content {
            let RuntimeContentBlock::ToolUse { id, name, input } = block else {
                continue;
            };

            let content = serde_json::to_string(input).unwrap_or_default();
            crate::domain::features::repository::persist_tool_call_message(
                &self.write_pool,
                crate::domain::features::repository::ToolCallMessage {
                    session_id,
                    tool_use_id: id,
                    tool_name: name,
                    content: &content,
                    parent_tool_use_id: None,
                    model: message.model.as_deref(),
                },
            )
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod session_tool_reconciliation_tests {
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeEvent, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect test db");

        sqlx::query(
            "CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feature_id INTEGER NOT NULL,
                agent_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                started_at TEXT,
                ended_at TEXT,
                runtime_provider TEXT,
                runtime_session_id TEXT,
                has_file_changes INTEGER DEFAULT 0,
                model TEXT DEFAULT NULL,
                profile TEXT,
                permission_mode TEXT DEFAULT 'bypassPermissions',
                codex_permission_mode TEXT DEFAULT 'default',
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                context_window INTEGER,
                was_compacted INTEGER DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .expect("create sessions");

        sqlx::query(
            "CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                message_type TEXT NOT NULL DEFAULT 'text',
                tool_name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                tool_use_id TEXT,
                parent_tool_use_id TEXT,
                model TEXT DEFAULT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create messages");

        sqlx::query(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (1, 'session', 'running')",
        )
        .execute(&pool)
        .await
        .expect("insert session");

        pool
    }

    fn assistant_event(message: RuntimeAssistantMessage) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("ses_1".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::AssistantMessage {
                message,
                parent_tool_use_id: None,
            },
        )
    }

    #[tokio::test]
    async fn persists_enriched_tool_call_content_from_assistant_fallback() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        let initial = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("ses_1".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::ToolUse {
                        id: "tool_1".to_string(),
                        name: "Bash".to_string(),
                        input: serde_json::json!({ "status": "pending" }),
                    },
                },
                parent_tool_use_id: None,
            },
        );
        persistence
            .persist_runtime_event(&initial)
            .await
            .expect("persist runtime event");

        persistence
            .persist_runtime_event(&assistant_event(RuntimeAssistantMessage {
                model: Some("openai/gpt-5.4".to_string()),
                content: vec![RuntimeContentBlock::ToolUse {
                    id: "tool_1".to_string(),
                    name: "Bash".to_string(),
                    input: serde_json::json!({
                        "command": "pnpm lint",
                        "status": "completed",
                        "output": "ok\n",
                    }),
                }],
            }))
            .await
            .expect("persist runtime event");

        let row = sqlx::query(
            "SELECT content FROM agent_messages WHERE session_id = 1 AND tool_use_id = 'tool_1'",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch tool_call");
        let content: String = row.get("content");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).expect("valid json"),
            serde_json::json!({
                "command": "pnpm lint",
                "status": "completed",
                "output": "ok\n",
            })
        );
    }

    #[tokio::test]
    async fn inserts_tool_call_when_only_assistant_fallback_exists() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&assistant_event(RuntimeAssistantMessage {
                model: Some("openai/gpt-5.4".to_string()),
                content: vec![RuntimeContentBlock::ToolUse {
                    id: "tool_2".to_string(),
                    name: "Read".to_string(),
                    input: serde_json::json!({
                        "file_path": "packages/service/src/main.rs",
                        "status": "completed",
                    }),
                }],
            }))
            .await
            .expect("persist runtime event");

        let row = sqlx::query(
            "SELECT tool_name, content FROM agent_messages WHERE session_id = 1 AND tool_use_id = 'tool_2'",
        )
        .fetch_one(&pool)
        .await
        .expect("fetch inserted tool_call");

        let tool_name: String = row.get("tool_name");
        let content: String = row.get("content");
        assert_eq!(tool_name, "Read");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).expect("valid json"),
            serde_json::json!({
                "file_path": "packages/service/src/main.rs",
                "status": "completed",
            })
        );
    }

    fn stream_ev(event: RuntimeStreamEvent) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("ses_1".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::StreamEvent {
                event,
                parent_tool_use_id: None,
            },
        )
    }

    #[tokio::test]
    async fn streamed_text_is_not_duplicated_by_the_full_assistant_message() {
        // A normal streamed turn persists text live; the full assistant message
        // that follows must only reconcile tool calls, NOT re-write the text.
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        p.persist_runtime_event(&stream_ev(RuntimeStreamEvent::MessageStart {
            model: Some("claude-opus-4-8".to_string()),
            input_tokens: None,
        }))
        .await
        .expect("persist runtime event");
        p.persist_runtime_event(&stream_ev(RuntimeStreamEvent::ContentBlockStart {
            index: 0,
            block: RuntimeContentBlock::Text {
                text: "Hello".to_string(),
            },
        }))
        .await
        .expect("persist runtime event");

        p.persist_runtime_event(&RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("ses_1".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: Some("claude-opus-4-8".to_string()),
                    content: vec![RuntimeContentBlock::Text {
                        text: "Hello".to_string(),
                    }],
                },
                parent_tool_use_id: None,
            },
        ))
        .await
        .expect("persist runtime event");

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT message_type, content FROM agent_messages WHERE session_id = 1 ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("fetch rows");
        assert_eq!(
            rows.len(),
            1,
            "streamed text must not be duplicated: {rows:?}"
        );
        assert_eq!(rows[0].0, "text");
        assert_eq!(rows[0].1, "Hello");
    }

    #[tokio::test]
    async fn unstreamed_full_assistant_text_is_persisted() {
        // A full assistant message that was NOT streamed (no prior text deltas
        // for this cycle) must still have its text persisted — otherwise the
        // turn's only output vanishes. This is the core of the fix; the test
        // above guards the no-duplication side of the same path.
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        p.persist_runtime_event(&RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("ses_1".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: Some("claude-opus-4-8".to_string()),
                    content: vec![RuntimeContentBlock::Text {
                        text: "Unstreamed answer".to_string(),
                    }],
                },
                parent_tool_use_id: None,
            },
        ))
        .await
        .expect("persist runtime event");

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT message_type, content FROM agent_messages WHERE session_id = 1 ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("fetch rows");
        assert_eq!(rows.len(), 1, "unstreamed text must be persisted: {rows:?}");
        assert_eq!(rows[0].0, "text");
        assert_eq!(rows[0].1, "Unstreamed answer");
    }
}
