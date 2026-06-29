impl WsSessionPersistence {
    /// Persist sub-agent content from an `assistant` message.
    ///
    /// Stream events for sub-agent tool_calls lack `parent_tool_use_id`, so we
    /// update existing rows to add the parent link. Text/thinking are inserted fresh.
    async fn persist_assistant_subagent(
        &self,
        session_id: i64,
        message: &RuntimeAssistantMessage,
        ptuid: &str,
    ) {
        let model = message.model.as_deref();
        for cb in &message.content {
            match cb {
                RuntimeContentBlock::ToolUse { id, name, input } => {
                    let content = serde_json::to_string(input).unwrap_or_default();
                    let result = sqlx::query(
                        "UPDATE agent_messages SET parent_tool_use_id = COALESCE(parent_tool_use_id, ?), \
                         content = ?, tool_name = COALESCE(tool_name, ?), model = COALESCE(model, ?) \
                         WHERE session_id = ? AND tool_use_id = ? AND message_type = 'tool_call' \
                         AND (parent_tool_use_id IS NULL OR parent_tool_use_id = ?)",
                    )
                    .bind(ptuid)
                    .bind(&content)
                    .bind(name)
                    .bind(model)
                    .bind(session_id)
                    .bind(id)
                    .bind(ptuid)
                    .execute(&self.write_pool)
                    .await;

                    match result {
                        Ok(r) if r.rows_affected() == 0 => {
                            let _ = Self::insert_message(
                                &self.write_pool,
                                session_id,
                                "assistant",
                                &content,
                                "tool_call",
                                Some(name),
                                Some(id),
                                Some(ptuid),
                                model,
                            )
                            .await;
                        }
                        Err(e) => {
                            error!(error = %e, session_id, tool_use_id = %id, "failed to update sub-agent tool_call parent");
                        }
                        _ => {}
                    }
                }
                RuntimeContentBlock::Text { text } => {
                    let _ = Self::insert_message(
                        &self.write_pool,
                        session_id,
                        "assistant",
                        text,
                        "text",
                        None,
                        None,
                        Some(ptuid),
                        model,
                    )
                    .await;
                }
                RuntimeContentBlock::Thinking { thinking } => {
                    let _ = Self::insert_message(
                        &self.write_pool,
                        session_id,
                        "assistant",
                        thinking,
                        "thinking",
                        None,
                        None,
                        Some(ptuid),
                        model,
                    )
                    .await;
                }
                RuntimeContentBlock::Other => {}
            }
        }
    }
}

#[cfg(test)]
mod session_subagents_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn setup_test_db() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feature_id INTEGER NOT NULL,
                agent_type TEXT NOT NULL DEFAULT 'session',
                status TEXT NOT NULL DEFAULT 'idle',
                runtime_provider TEXT,
                runtime_session_id TEXT,

                model TEXT,
                profile TEXT,
                permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default',
                has_file_changes INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                context_window INTEGER NOT NULL DEFAULT 200000,
                started_at TEXT,
                ended_at TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT,
                content TEXT NOT NULL DEFAULT '',
                message_type TEXT NOT NULL DEFAULT 'text',
                tool_name TEXT,
                tool_use_id TEXT,
                parent_tool_use_id TEXT,
                model TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"CREATE TABLE session_runtime_ids (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                runtime_session_id TEXT NOT NULL,
                created_at TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    fn make_assistant_message(content: Vec<RuntimeContentBlock>) -> RuntimeAssistantMessage {
        RuntimeAssistantMessage {
            model: Some("claude-sonnet-4-20250514".to_string()),
            content,
        }
    }

    fn make_assistant_event(
        content: Vec<RuntimeContentBlock>,
        parent_tool_use_id: Option<&str>,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("s1".to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            crate::domain::agents::adapter::RuntimeEventKind::AssistantMessage {
                message: make_assistant_message(content),
                parent_tool_use_id: parent_tool_use_id.map(|id| id.to_string()),
            },
        )
    }

    #[tokio::test]
    async fn test_assistant_subagent_updates_tool_call_parent() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let sid = p.find_or_create_session(None, None).await.unwrap();

        let _ = WsSessionPersistence::insert_message(
            &pool,
            sid,
            "assistant",
            "{\"command\":\"ls\"}",
            "tool_call",
            Some("Bash"),
            Some("toolu_child1"),
            None,
            None,
        )
        .await;

        let msg = make_assistant_message(vec![RuntimeContentBlock::ToolUse {
            id: "toolu_child1".to_string(),
            name: "Bash".to_string(),
            input: serde_json::json!({"command": "ls -la"}),
        }]);
        p.persist_assistant_subagent(sid, &msg, "toolu_parent")
            .await;

        let row: (Option<String>, String) = sqlx::query_as(
            "SELECT parent_tool_use_id, content FROM agent_messages WHERE tool_use_id = 'toolu_child1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0.as_deref(), Some("toolu_parent"));
        assert!(row.1.contains("ls -la"));

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM agent_messages WHERE tool_use_id = 'toolu_child1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn test_assistant_subagent_inserts_when_no_existing_row() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let sid = p.find_or_create_session(None, None).await.unwrap();

        let msg = make_assistant_message(vec![RuntimeContentBlock::ToolUse {
            id: "toolu_new".to_string(),
            name: "Read".to_string(),
            input: serde_json::json!({"file_path": "/tmp/test"}),
        }]);
        p.persist_assistant_subagent(sid, &msg, "toolu_parent")
            .await;

        let row: (String, String, Option<String>) = sqlx::query_as(
            "SELECT tool_name, content, parent_tool_use_id FROM agent_messages WHERE tool_use_id = 'toolu_new'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "Read");
        assert!(row.1.contains("/tmp/test"));
        assert_eq!(row.2.as_deref(), Some("toolu_parent"));
    }

    #[tokio::test]
    async fn test_assistant_subagent_updates_existing_row_with_same_parent() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let sid = p.find_or_create_session(None, None).await.unwrap();

        let _ = WsSessionPersistence::insert_message(
            &pool,
            sid,
            "assistant",
            r#"{"status":"pending"}"#,
            "tool_call",
            Some("Read"),
            Some("toolu_same_parent"),
            Some("toolu_parent"),
            None,
        )
        .await;

        let msg = make_assistant_message(vec![RuntimeContentBlock::ToolUse {
            id: "toolu_same_parent".to_string(),
            name: "Read".to_string(),
            input: serde_json::json!({"file_path": "/tmp/test"}),
        }]);
        p.persist_assistant_subagent(sid, &msg, "toolu_parent")
            .await;

        let row: (String, Option<String>) = sqlx::query_as(
            "SELECT content, parent_tool_use_id FROM agent_messages WHERE tool_use_id = 'toolu_same_parent'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM agent_messages WHERE tool_use_id = 'toolu_same_parent'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(count.0, 1);
        assert!(row.0.contains("/tmp/test"));
        assert_eq!(row.1.as_deref(), Some("toolu_parent"));
    }

    #[tokio::test]
    async fn test_assistant_subagent_persists_text_and_thinking() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let sid = p.find_or_create_session(None, None).await.unwrap();

        let msg = make_assistant_message(vec![
            RuntimeContentBlock::Thinking {
                thinking: "Let me analyze...".to_string(),
            },
            RuntimeContentBlock::Text {
                text: "Here are my findings.".to_string(),
            },
        ]);
        p.persist_assistant_subagent(sid, &msg, "toolu_parent")
            .await;

        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT message_type, content, parent_tool_use_id FROM agent_messages WHERE session_id = ? ORDER BY id",
        )
        .bind(sid)
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "thinking");
        assert_eq!(rows[0].1, "Let me analyze...");
        assert_eq!(rows[0].2.as_deref(), Some("toolu_parent"));
        assert_eq!(rows[1].0, "text");
        assert_eq!(rows[1].1, "Here are my findings.");
        assert_eq!(rows[1].2.as_deref(), Some("toolu_parent"));
    }

    #[tokio::test]
    async fn test_unstreamed_top_level_assistant_text_is_persisted() {
        // A top-level assistant text message that was NOT streamed (no prior
        // `message_start`/deltas) must be persisted — otherwise the agent's
        // reply silently vanishes. (Streamed turns are covered separately and
        // must NOT double-write; see the reconciliation tests.)
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let sid = p.find_or_create_session(None, None).await.unwrap();

        let runtime_event = make_assistant_event(
            vec![RuntimeContentBlock::Text {
                text: "top-level response".to_string(),
            }],
            None,
        );
        p.persist_runtime_event(&runtime_event).await;

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT message_type, content FROM agent_messages WHERE session_id = ? ORDER BY id",
        )
        .bind(sid)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "text");
        assert_eq!(rows[0].1, "top-level response");
    }

    #[tokio::test]
    async fn test_assistant_subagent_dispatched_via_persist_runtime_event() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let _sid = p.find_or_create_session(None, None).await.unwrap();

        let runtime_event = make_assistant_event(
            vec![RuntimeContentBlock::ToolUse {
                id: "toolu_via_sdk".to_string(),
                name: "Grep".to_string(),
                input: serde_json::json!({"pattern": "foo"}),
            }],
            Some("toolu_agent"),
        );
        p.persist_runtime_event(&runtime_event).await;

        let row: (String, Option<String>) = sqlx::query_as(
            "SELECT tool_name, parent_tool_use_id FROM agent_messages WHERE tool_use_id = 'toolu_via_sdk'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "Grep");
        assert_eq!(row.1.as_deref(), Some("toolu_agent"));
    }
}
