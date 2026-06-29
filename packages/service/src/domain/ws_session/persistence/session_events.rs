impl WsSessionPersistence {
    /// Main dispatch for normalized runtime events.
    pub async fn persist_runtime_event(
        &mut self,
        runtime_event: &RuntimeEvent,
    ) -> Option<PersistedMessageRef> {
        let Some(session_id) = self.session_db_id else {
            return None;
        };

        if let Some(event) = runtime_event.stream_event() {
            return self
                .persist_stream_event(
                    session_id,
                    runtime_event.session_id(),
                    event,
                    runtime_event.parent_tool_use_id(),
                )
                .await;
        }

        if let Some(message) = runtime_event.user_message() {
            self.persist_user_tool_results(session_id, message, runtime_event.parent_tool_use_id())
                .await;
            return None;
        }

        if let Some(message) = runtime_event.assistant_message() {
            if let Some(ptuid) = runtime_event.parent_tool_use_id() {
                self.persist_assistant_subagent(session_id, message, ptuid)
                    .await;
            } else {
                self.reconcile_tool_call_content(session_id, message).await;
                let runtime_key = runtime_stream_key(runtime_event.session_id());
                self.persist_unstreamed_assistant_text(session_id, &runtime_key, message)
                    .await;
            }
            return None;
        }

        if runtime_event.is_compact_boundary() {
            let content = serialize_compact_metadata(runtime_event.compact_metadata());
            let result = Self::insert_message(
                &self.write_pool,
                session_id,
                "system",
                &content,
                "compact_divider",
                None,
                None,
                None,
                None,
            )
            .await;
            let _ = sqlx::query("UPDATE agent_sessions SET was_compacted = 1 WHERE id = ?")
                .bind(session_id)
                .execute(&self.write_pool)
                .await;
            return result
                .ok()
                .map(|row| PersistedMessageRef { id: row.last_insert_rowid() });
        }

        None
    }

    async fn insert_message(
        pool: &SqlitePool,
        session_id: i64,
        role: &str,
        content: &str,
        message_type: &str,
        tool_name: Option<&str>,
        tool_use_id: Option<&str>,
        ptuid: Option<&str>,
        model: Option<&str>,
    ) -> Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error> {
        sqlx::query(INSERT_MESSAGE_SQL)
            .bind(session_id)
            .bind(role)
            .bind(content)
            .bind(message_type)
            .bind(tool_name)
            .bind(tool_use_id)
            .bind(ptuid)
            .bind(model)
            .execute(pool)
            .await
    }

    async fn persist_stream_event(
        &mut self,
        session_id: i64,
        runtime_session_id: Option<&str>,
        event: &RuntimeStreamEvent,
        ptuid: Option<&str>,
    ) -> Option<PersistedMessageRef> {
        let runtime_key = runtime_stream_key(runtime_session_id);

        match event {
            RuntimeStreamEvent::MessageStart { model, .. } => {
                // A new message cycle begins: clear the streamed-text marker so
                // each message is judged on its own deltas.
                self.streamed_assistant_content.remove(&runtime_key);
                if let Some(model) = model.clone() {
                    self.current_models.insert(runtime_key, model);
                }
                None
            }
            RuntimeStreamEvent::ContentBlockStart { index, block } => {
                let current_model = self.current_models.get(&runtime_key).cloned();
                self.persist_content_block_start(
                    session_id,
                    &runtime_key,
                    *index,
                    block,
                    ptuid,
                    current_model.as_deref(),
                )
                .await
            }
            RuntimeStreamEvent::ContentBlockDelta { index, delta } => {
                self.persist_content_block_delta(
                    session_id,
                    &runtime_key,
                    *index,
                    delta,
                    ptuid,
                )
                .await
            }
            RuntimeStreamEvent::ContentBlockStop { index } => {
                self.persist_content_block_stop(&runtime_key, *index).await;
                None
            }
            RuntimeStreamEvent::Other => None,
        }
    }

    async fn persist_user_tool_results(
        &self,
        session_id: i64,
        message: &RuntimeUserMessage,
        ptuid: Option<&str>,
    ) {
        for item in &message.content {
            if let RuntimeUserContentBlock::ToolResult {
                tool_use_id,
                is_error,
                content,
            } = item
            {
                let content = match content {
                    serde_json::Value::String(text) => text.clone(),
                    other => serde_json::to_string(other).unwrap_or_default(),
                };
                let message_type = if *is_error { "tool_error" } else { "tool_result" };

                let _ = Self::insert_message(
                    &self.write_pool,
                    session_id,
                    "tool",
                    &content,
                    message_type,
                    None,
                    tool_use_id.as_deref(),
                    ptuid,
                    None,
                )
                .await;
            }
        }
    }

    /// Model captured from the most recent `message_start` for this event's
    /// runtime session, if any. The forward path stamps this onto live blocks so
    /// a client that missed `message_start` (e.g. a remote device that joined the
    /// turn late) still labels streamed text with the right model.
    pub fn current_model_for_event(&self, runtime_event: &RuntimeEvent) -> Option<&str> {
        let key = runtime_stream_key(runtime_event.session_id());
        self.current_models.get(&key).map(String::as_str)
    }

    async fn mark_has_file_changes(&mut self, session_id: i64) {
        self.file_change_marked = true;
        let _ = sqlx::query("UPDATE agent_sessions SET has_file_changes = 1 WHERE id = ?")
            .bind(session_id)
            .execute(&self.write_pool)
            .await;
    }
}

fn runtime_stream_key(runtime_session_id: Option<&str>) -> String {
    runtime_session_id.unwrap_or_default().to_string()
}

/// Serialize a compaction metadata payload into the `content` column of the
/// persisted `compact_divider` row so history reload can surface `trigger` /
/// `pre_tokens`. Returns an empty string when nothing is worth persisting.
fn serialize_compact_metadata(
    metadata: Option<&crate::domain::agents::adapter::RuntimeCompactMetadata>,
) -> String {
    match metadata {
        Some(meta) if meta.trigger.is_some() || meta.pre_tokens.is_some() => {
            serde_json::to_string(meta).unwrap_or_default()
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod session_events_tests {
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    pub(super) async fn setup_test_db() -> SqlitePool {
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
                context_window INTEGER DEFAULT 200000,
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

    pub(super) fn stream_event(
        runtime_session_id: &str,
        parent_tool_use_id: Option<&str>,
        event: RuntimeStreamEvent,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(runtime_session_id.to_string()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::StreamEvent {
                event,
                parent_tool_use_id: parent_tool_use_id.map(ToOwned::to_owned),
            },
        )
    }

    #[tokio::test]
    async fn message_start_model_is_exposed_for_stamping() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        let content_block = stream_event(
            "thread",
            None,
            RuntimeStreamEvent::ContentBlockStart {
                index: 0,
                block: RuntimeContentBlock::Text {
                    text: "Hi".to_string(),
                },
            },
        );

        // No `message_start` seen yet -> nothing to stamp.
        assert_eq!(persistence.current_model_for_event(&content_block), None);

        persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::MessageStart {
                    model: Some("claude-opus-4-8".to_string()),
                    input_tokens: None,
                },
            ))
            .await;

        // After `message_start`, later events on the same runtime session expose
        // the captured model so the forward path can stamp live blocks.
        assert_eq!(
            persistence.current_model_for_event(&content_block),
            Some("claude-opus-4-8")
        );
    }

    #[tokio::test]
    async fn text_deltas_append_to_the_started_row() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        let start_ref = persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::Text {
                        text: "Hel".to_string(),
                    },
                },
            ))
            .await
            .expect("start row id");
        let delta_ref = persistence
            .persist_runtime_event(&stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::Text {
                        text: "lo".to_string(),
                    },
                },
            ))
            .await
            .expect("delta row id");

        assert_eq!(start_ref.id, delta_ref.id);

        let rows = sqlx::query("SELECT content, message_type FROM agent_messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("fetch text rows");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<String, _>("message_type"), "text");
        assert_eq!(rows[0].get::<String, _>("content"), "Hello");
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
            .await;

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
            .await;

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
            .await;

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
}
