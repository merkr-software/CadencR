#[cfg(test)]
mod session_events_reconcile_tests {
    use super::session_events_tests::{setup_test_db, stream_event};
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent,
        RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use sqlx::{Row, SqlitePool};

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

    /// Anthropic streams `partial_json` as bare fragments that don't necessarily
    /// start with `{`. The accumulator must concatenate them into a valid object
    /// — when seeded with `"{}"` (the buggy default) the concat path was never
    /// valid and the fallback never triggered, leaving the row at `"{}"`.
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

    /// Even when streaming deltas never assemble a complete input, the trailing
    /// `AssistantMessage` carries the full tool input. A `ContentBlockStop`
    /// arriving after the reconcile must NOT clobber the row with the stale
    /// (empty) buffer.
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

    /// Sub-agent tool calls go through `persist_assistant_subagent` instead of
    /// `reconcile_tool_call_content`, but they share the same stream-side
    /// `ContentBlockStop` handler — so they must be guarded against the same
    /// clobber race.
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
}
