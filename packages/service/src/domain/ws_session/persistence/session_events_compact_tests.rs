#[cfg(test)]
mod session_events_compact_tests {
    use super::session_events_tests::{setup_test_db, stream_event};
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeCompactMetadata, RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent,
        RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use sqlx::Row;

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

    fn compact_boundary_event(metadata: Option<RuntimeCompactMetadata>) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("sess".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::CompactBoundary { metadata },
        )
    }

    #[tokio::test]
    async fn compact_boundary_sets_was_compacted_and_stores_metadata() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&compact_boundary_event(Some(RuntimeCompactMetadata {
                trigger: Some("auto".to_string()),
                pre_tokens: Some(90_000),
            })))
            .await
            .expect("persist runtime event");

        let session_row = sqlx::query("SELECT was_compacted FROM agent_sessions WHERE id = 1")
            .fetch_one(&pool)
            .await
            .expect("fetch session row");
        assert_eq!(session_row.get::<i64, _>("was_compacted"), 1);

        let message_row =
            sqlx::query("SELECT content, message_type FROM agent_messages WHERE session_id = 1")
                .fetch_one(&pool)
                .await
                .expect("fetch message row");
        assert_eq!(
            message_row.get::<String, _>("message_type"),
            "compact_divider"
        );
        let content = message_row.get::<String, _>("content");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).expect("valid json"),
            serde_json::json!({ "trigger": "auto", "pre_tokens": 90_000 })
        );
    }

    #[tokio::test]
    async fn compact_boundary_without_metadata_stores_empty_content() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        persistence
            .persist_runtime_event(&compact_boundary_event(None))
            .await
            .expect("persist runtime event");

        let message_row = sqlx::query("SELECT content FROM agent_messages WHERE session_id = 1")
            .fetch_one(&pool)
            .await
            .expect("fetch message row");
        assert_eq!(message_row.get::<String, _>("content"), "");
    }
}
