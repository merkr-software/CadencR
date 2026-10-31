/// Serialize compaction metadata for a persisted `compact_divider` row.
pub(super) fn serialize_compact_metadata(
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
mod tests {
    use super::super::events::session_events_tests::setup_test_db;
    use crate::domain::agents::adapter::{
        RuntimeCompactMetadata, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use sqlx::Row;
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
