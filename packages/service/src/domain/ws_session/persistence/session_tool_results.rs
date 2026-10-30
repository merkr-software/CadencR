impl WsSessionPersistence {
    async fn persist_user_tool_results(
        &self,
        session_id: i64,
        message: &RuntimeUserMessage,
        ptuid: Option<&str>,
    ) -> Result<Vec<(String, i64)>, TranscriptPersistenceError> {
        let mut results = Vec::new();
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
                results.push((tool_use_id.as_deref(), *is_error, content));
            }
        }
        if results.is_empty() {
            return Ok(Vec::new());
        }
        let mut identities = Vec::new();
        let mut tx = self.write_pool.begin().await?;
        for (tool_use_id, is_error, content) in &results {
            let row = sqlx::query(INSERT_MESSAGE_SQL)
                .bind(session_id)
                .bind("tool")
                .bind(content)
                .bind(if *is_error {
                    "tool_error"
                } else {
                    "tool_result"
                })
                .bind(Option::<&str>::None)
                .bind(tool_use_id)
                .bind(ptuid)
                .bind(Option::<&str>::None)
                .execute(&mut *tx)
                .await?;
            if let Some(tool_id) = tool_use_id {
                identities.push(((*tool_id).to_owned(), row.last_insert_rowid()));
            }
        }
        tx.commit().await?;
        // Run duplicate-output cleanup after releasing the transaction: the
        // authoritative result must exist, and single-connection pools must not deadlock.
        for (tool_use_id, _, content) in &results {
            if let Some(tool_id) = tool_use_id {
                Self::drop_duplicated_tool_call_output(
                    &self.write_pool,
                    session_id,
                    tool_id,
                    content,
                )
                .await;
            }
        }
        Ok(identities)
    }
}

#[cfg(test)]
mod tool_result_identity_tests {
    use super::*;
    use crate::domain::agents::adapter::{RuntimeEventKind, RuntimeEventMetadata};
    use serde_json::json;

    #[tokio::test]
    async fn persisted_batch_ids_load_the_correct_full_results() {
        let pool = session_events_tests::setup_test_db().await;
        let mut persistence = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        let contents = ["first".repeat(30_000), "second".repeat(30_000)];
        let message = RuntimeUserMessage {
            content: contents
                .iter()
                .enumerate()
                .map(|(index, content)| RuntimeUserContentBlock::ToolResult {
                    tool_use_id: Some(format!("tool-{index}")),
                    is_error: index == 1,
                    content: json!(content),
                })
                .collect(),
        };
        let raw = json!({"type":"user", "message":{"content":[
            {"type":"tool_result", "tool_use_id":"tool-0", "content":contents[0]},
            {"type":"tool_result", "tool_use_id":"tool-1", "content":contents[1]}
        ]}});
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: None,
                usage: None,
                context_window: None,
                raw: raw.clone(),
            },
            RuntimeEventKind::UserMessage {
                message,
                parent_tool_use_id: Some("parent".into()),
            },
        );
        let identities = persistence
            .persist_runtime_event(&event)
            .await
            .expect("persist runtime event");
        let stamped = raw_event_with_agent_message_id(&raw, identities);
        for (index, expected) in contents.iter().enumerate() {
            let id = stamped["message"]["content"][index]["agent_message_id"]
                .as_i64()
                .unwrap();
            let (content, parent, kind): (String, String, String) = sqlx::query_as(
                "SELECT content, parent_tool_use_id, message_type FROM agent_messages WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(&content, expected);
            assert_eq!(parent, "parent");
            assert_eq!(
                kind,
                if index == 1 {
                    "tool_error"
                } else {
                    "tool_result"
                }
            );
        }
    }
    #[tokio::test]
    async fn failing_second_result_rolls_back_the_whole_identity_batch() {
        let pool = session_events_tests::setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        sqlx::query("CREATE TRIGGER fail_second_result BEFORE INSERT ON agent_messages WHEN NEW.content = 'second' BEGIN SELECT RAISE(ABORT, 'second result rejected'); END")
            .execute(&pool).await.unwrap();
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: None,
                usage: None,
                context_window: None,
                raw: json!({}),
            },
            RuntimeEventKind::UserMessage {
                message: RuntimeUserMessage {
                    content: ["first", "second"]
                        .into_iter()
                        .enumerate()
                        .map(|(index, content)| RuntimeUserContentBlock::ToolResult {
                            tool_use_id: Some(format!("tool-{index}")),
                            is_error: false,
                            content: json!(content),
                        })
                        .collect(),
                },
                parent_tool_use_id: None,
            },
        );
        assert!(matches!(
            p.persist_runtime_event(&event).await,
            Err(TranscriptPersistenceError::Database(_))
        ));
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "a failed batch must not orphan previously committed identities"
        );
        sqlx::query("DROP TRIGGER fail_second_result")
            .execute(&pool)
            .await
            .unwrap();
        let identities = p.persist_runtime_event(&event).await.unwrap();
        let Some(PersistedEventRef::ToolResults(ids)) = identities else {
            panic!("expected durable tool identities")
        };
        assert_eq!(ids.len(), 2);
    }
}
