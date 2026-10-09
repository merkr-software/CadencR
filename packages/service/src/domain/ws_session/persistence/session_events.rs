impl WsSessionPersistence {
    /// Main dispatch for normalized runtime events.
    pub async fn persist_runtime_event(
        &mut self,
        runtime_event: &RuntimeEvent,
    ) -> Option<PersistedEventRef> {
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
                .await
                .map(PersistedEventRef::Message);
        }

        if let Some(message) = runtime_event.user_message() {
            let results = self
                .persist_user_tool_results(session_id, message, runtime_event.parent_tool_use_id())
                .await;
            return (!results.is_empty()).then_some(PersistedEventRef::ToolResults(results));
        }

        if let Some(message) = runtime_event.assistant_message() {
            if let Some(ptuid) = runtime_event.parent_tool_use_id() {
                self.persist_assistant_subagent(session_id, message, ptuid)
                    .await;
            } else {
                self.reconcile_tool_call_content(session_id, message).await;
                let stream_scope = RuntimeStreamScope::new(runtime_event.session_id(), None);
                self.persist_unstreamed_assistant_text(session_id, &stream_scope, message)
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
            return result.ok().map(|row| {
                PersistedEventRef::Message(PersistedMessageRef {
                    id: row.last_insert_rowid(),
                })
            });
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
        // Only user-message image blocks have a desktop consumer that resolves
        // `cadencr-blob://`. Tool arguments/results may contain image-looking
        // strings as source code or protocol data and must remain byte-for-byte.
        let offloaded = if message_type == "user_message" {
            crate::domain::blobs::offload_content_async(content).await
        } else {
            None
        };
        let content = offloaded.as_deref().unwrap_or(content);

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
        let stream_scope = RuntimeStreamScope::new(runtime_session_id, ptuid);

        match event {
            RuntimeStreamEvent::MessageStart { model, .. } => {
                // A new message cycle begins: clear the streamed-text marker so
                // each message is judged on its own deltas.
                self.streamed_assistant_content.remove(&stream_scope);
                if let Some(model) = model.clone() {
                    self.current_models.insert(stream_scope, model);
                }
                None
            }
            RuntimeStreamEvent::ContentBlockStart { index, block } => {
                let current_model = self.current_models.get(&stream_scope).cloned();
                self.persist_content_block_start(
                    session_id,
                    &stream_scope,
                    *index,
                    block,
                    ptuid,
                    current_model.as_deref(),
                )
                .await
            }
            RuntimeStreamEvent::ContentBlockDelta { index, delta } => {
                self.persist_content_block_delta(session_id, &stream_scope, *index, delta, ptuid)
                    .await
            }
            RuntimeStreamEvent::ContentBlockStop { index } => {
                self.persist_content_block_stop(&stream_scope, *index).await;
                None
            }
            RuntimeStreamEvent::Other => None,
        }
    }

    /// Model captured from the most recent `message_start` for this event's
    /// runtime session, if any. The forward path stamps this onto live blocks so
    /// a client that missed `message_start` (e.g. a remote device that joined the
    /// turn late) still labels streamed text with the right model.
    pub fn current_model_for_event(&self, runtime_event: &RuntimeEvent) -> Option<&str> {
        let scope = RuntimeStreamScope::for_event(runtime_event);
        self.current_models.get(&scope).map(String::as_str)
    }

    async fn mark_has_file_changes(&mut self, session_id: i64) {
        self.file_change_marked = true;
        let _ = sqlx::query("UPDATE agent_sessions SET has_file_changes = 1 WHERE id = ?")
            .bind(session_id)
            .execute(&self.write_pool)
            .await;
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
    async fn root_and_subagent_streams_keep_independent_rows_and_models() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));

        for event in [
            stream_event(
                "thread",
                None,
                RuntimeStreamEvent::MessageStart {
                    model: Some("root-model".to_string()),
                    input_tokens: None,
                },
            ),
            stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::Text {
                        text: "R".to_string(),
                    },
                },
            ),
            stream_event(
                "thread",
                Some("tool-parent"),
                RuntimeStreamEvent::MessageStart {
                    model: Some("child-model".to_string()),
                    input_tokens: None,
                },
            ),
            stream_event(
                "thread",
                Some("tool-parent"),
                RuntimeStreamEvent::ContentBlockStart {
                    index: 0,
                    block: RuntimeContentBlock::Text {
                        text: "C".to_string(),
                    },
                },
            ),
            stream_event(
                "thread",
                None,
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::Text {
                        text: "oot".to_string(),
                    },
                },
            ),
            stream_event(
                "thread",
                Some("tool-parent"),
                RuntimeStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: RuntimeContentDelta::Text {
                        text: "hild".to_string(),
                    },
                },
            ),
        ] {
            persistence.persist_runtime_event(&event).await;
        }

        let root_event = stream_event("thread", None, RuntimeStreamEvent::Other);
        let child_event = stream_event("thread", Some("tool-parent"), RuntimeStreamEvent::Other);
        assert_eq!(
            persistence.current_model_for_event(&root_event),
            Some("root-model")
        );
        assert_eq!(
            persistence.current_model_for_event(&child_event),
            Some("child-model")
        );

        let rows = sqlx::query(
            "SELECT content, parent_tool_use_id, model FROM agent_messages ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("fetch scoped stream rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<String, _>("content"), "Root");
        assert_eq!(rows[0].get::<Option<String>, _>("parent_tool_use_id"), None);
        assert_eq!(
            rows[0].get::<Option<String>, _>("model").as_deref(),
            Some("root-model")
        );
        assert_eq!(rows[1].get::<String, _>("content"), "Child");
        assert_eq!(
            rows[1]
                .get::<Option<String>, _>("parent_tool_use_id")
                .as_deref(),
            Some("tool-parent")
        );
        assert_eq!(
            rows[1].get::<Option<String>, _>("model").as_deref(),
            Some("child-model")
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

        assert!(
            matches!((start_ref, delta_ref), (PersistedEventRef::Message(start), PersistedEventRef::Message(delta)) if start.id == delta.id)
        );

        let rows = sqlx::query("SELECT content, message_type FROM agent_messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .expect("fetch text rows");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<String, _>("message_type"), "text");
        assert_eq!(rows[0].get::<String, _>("content"), "Hello");
    }
}
