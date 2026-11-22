use super::super::PersistedMessageRef;
use super::{PersistEventError, TranscriptWriter};
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamEvent, RuntimeStreamScope};

impl TranscriptWriter {
    pub(super) async fn persist_stream_event(
        &mut self,
        session_id: i64,
        runtime_session_id: Option<&str>,
        event: &RuntimeStreamEvent,
        ptuid: Option<&str>,
    ) -> Result<Option<PersistedMessageRef>, PersistEventError> {
        let stream_scope = RuntimeStreamScope::new(runtime_session_id, ptuid);

        match event {
            RuntimeStreamEvent::MessageStart { model, .. } => {
                // Flush any buffered deltas from the previous cycle before
                // starting a fresh one; if that flush fails, `begin_cycle`
                // promotes the damaged scope to unrecoverable.
                let flush_result = self.flush_deltas_for_scope(&stream_scope).await;
                self.transcript.begin_cycle(&stream_scope);
                self.pending_mergeable_blocks
                    .retain(|(scope, _), _| scope != &stream_scope);
                self.pending_delta_buffers
                    .retain(|(scope, _), _| scope != &stream_scope);
                self.streamed_assistant_content.remove(&stream_scope);
                if let Some(model) = model.clone() {
                    self.current_models.insert(stream_scope, model);
                }
                flush_result.map_err(PersistEventError::EventFailure)?;
                Ok(None)
            }
            RuntimeStreamEvent::ContentBlockStart { index, block } => {
                if let Err(error) = self.flush_deltas_for_scope(&stream_scope).await {
                    self.log_boundary_delta_flush_error(session_id, "content_block_start", &error);
                }
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
                .map_err(PersistEventError::EventFailure)
            }
            RuntimeStreamEvent::ContentBlockDelta { index, delta } => self
                .persist_content_block_delta(session_id, stream_scope, *index, delta, ptuid)
                .await
                .map_err(PersistEventError::EventFailure),
            RuntimeStreamEvent::ContentBlockStop { index } => {
                self.persist_content_block_stop(stream_scope, *index)
                    .await?;
                Ok(None)
            }
            RuntimeStreamEvent::Other => Ok(None),
        }
    }

    /// Model captured from the most recent `message_start` for this event's
    /// runtime session, if any. The forward path stamps this onto live blocks so
    /// a client that missed `message_start` (e.g. a remote device that joined the
    /// turn late) still labels streamed text with the right model.
    pub(in super::super) fn current_model_for_event(
        &self,
        runtime_event: &RuntimeEvent,
    ) -> Option<&str> {
        let scope = RuntimeStreamScope::for_event(runtime_event);
        self.current_models.get(&scope).map(String::as_str)
    }

    /// Flag the session as having changed files. Only a saved flag counts:
    /// after a failure the next file-change tool tries again, so the
    /// indicator is late rather than lost.
    pub(super) async fn mark_has_file_changes(&mut self, session_id: i64) {
        match sqlx::query("UPDATE agent_sessions SET has_file_changes = 1 WHERE id = ?")
            .bind(session_id)
            .execute(&self.write_pool)
            .await
        {
            Ok(_) => self.file_change_marked = true,
            Err(error) => tracing::warn!(
                session_id,
                %error,
                "failed to flag file changes; retrying on the next file-change tool"
            ),
        }
    }
}

#[cfg(test)]
pub(super) mod session_events_tests {
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimeEventKind,
        RuntimeEventMetadata, RuntimeStreamEvent,
    };
    use crate::domain::ws_session::persistence::PersistedEventRef;
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    pub(in super::super) async fn setup_test_db() -> SqlitePool {
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

    pub(in super::super) fn stream_event(
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

    /// A failed flag write used to count as done, so the file-change
    /// indicator never showed for that session. It now retries.
    #[tokio::test]
    async fn file_change_flag_is_retried_after_a_failed_write() {
        let pool = setup_test_db().await;
        sqlx::query(
            "CREATE TRIGGER refuse_flag BEFORE UPDATE OF has_file_changes ON agent_sessions
             BEGIN SELECT RAISE(FAIL, 'refused'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut writer = super::super::TranscriptWriter::new(pool.clone());

        writer.mark_has_file_changes(1).await;
        assert!(!writer.file_change_marked);

        sqlx::query("DROP TRIGGER refuse_flag")
            .execute(&pool)
            .await
            .unwrap();
        writer.mark_has_file_changes(1).await;
        assert!(writer.file_change_marked);
        let flagged: i64 = sqlx::query_scalar("SELECT has_file_changes FROM agent_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(flagged, 1);
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
            .await
            .expect("persist runtime event");

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
            persistence
                .persist_runtime_event(&event)
                .await
                .expect("persist runtime event");
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
            .expect("persist runtime event")
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
            .expect("persist runtime event")
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
