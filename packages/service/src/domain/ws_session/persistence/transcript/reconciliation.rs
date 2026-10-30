use super::*;

impl WsSessionPersistence {
    pub(in super::super) async fn reconcile_assistant_text(
        &mut self,
        session_id: i64,
        scope: &RuntimeStreamScope,
        parent_tool_use_id: Option<&str>,
        message: &RuntimeAssistantMessage,
    ) -> Result<Vec<(usize, i64)>, TranscriptPersistenceError> {
        let streamed = self.streamed_assistant_content.contains(scope);
        let damaged = self.transcript.is_damaged(scope);
        if streamed && !damaged {
            return Ok(self
                .transcript
                .rows
                .iter()
                .filter(|((row_scope, _), _)| row_scope == scope)
                .map(|((_, index), pending)| (*index as usize, pending.row_id))
                .collect());
        }
        let mut tx = self.write_pool.begin().await?;
        let mut rows = Vec::new();
        for (index, block) in message.content.iter().enumerate() {
            let (kind, content) = match block {
                RuntimeContentBlock::Text { text } => (MergeableMessageType::Text, text),
                RuntimeContentBlock::Thinking { thinking } => {
                    (MergeableMessageType::Thinking, thinking)
                }
                _ => continue,
            };
            let key = (scope.clone(), index as u64);
            let id = if let Some(pending) = self.transcript.rows.get(&key) {
                let changed = sqlx::query("UPDATE agent_messages SET content = ?, message_type = ? WHERE id = ? AND session_id = ?")
                    .bind(content).bind(kind.db_value()).bind(pending.row_id).bind(session_id)
                    .execute(&mut *tx).await?;
                if changed.rows_affected() != 1 {
                    return Err(TranscriptPersistenceError::MissingRow(pending.row_id));
                }
                pending.row_id
            } else {
                if content.trim().is_empty() {
                    continue;
                }
                sqlx::query(INSERT_MESSAGE_SQL)
                    .bind(session_id)
                    .bind("assistant")
                    .bind(content)
                    .bind(kind.db_value())
                    .bind(Option::<&str>::None)
                    .bind(Option::<&str>::None)
                    .bind(parent_tool_use_id)
                    .bind(message.model.as_deref())
                    .execute(&mut *tx)
                    .await?
                    .last_insert_rowid()
            };
            rows.push((index, id));
        }
        tx.commit().await?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_helpers::*;
    use super::*;
    #[tokio::test]
    async fn failed_initial_insert_is_reconciled_without_lost_or_duplicate_text() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        fail_statement(&pool, "INSERT").await;
        assert!(matches!(
            p.persist_runtime_event(&text_start("root", 0, "Hello"))
                .await,
            Err(TranscriptPersistenceError::Database(_))
        ));
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );
        recover_database(&pool).await;
        assert!(matches!(
            p.persist_runtime_event(&text_delta("root", " world")).await,
            Err(TranscriptPersistenceError::AwaitingReconciliation)
        ));
        assert!(contents(&pool).await.is_empty());
        p.persist_runtime_event(&complete("root", vec![text("Hello world")]))
            .await
            .unwrap();
        assert_eq!(
            contents(&pool)
                .await
                .iter()
                .map(|r| r.1.as_str())
                .collect::<Vec<_>>(),
            vec!["Hello world"]
        );
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }

    #[tokio::test]
    async fn failed_append_repairs_the_same_row_after_stop_without_truncation() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        p.persist_runtime_event(&text_start("root", 0, "Hello"))
            .await
            .unwrap();
        let id = contents(&pool).await[0].0;
        fail_statement(&pool, "UPDATE").await;
        assert!(p
            .persist_runtime_event(&text_delta("root", " world"))
            .await
            .is_err());
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );
        recover_database(&pool).await;
        assert!(p
            .persist_runtime_event(&text_delta("root", "!"))
            .await
            .is_err());
        p.persist_runtime_event(&stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockStop { index: 0 },
        ))
        .await
        .unwrap();
        p.persist_runtime_event(&complete("root", vec![text("Hello world!")]))
            .await
            .unwrap();
        assert_eq!(contents(&pool).await, vec![(id, "Hello world!".into())]);
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }

    #[tokio::test]
    async fn reconciliation_is_atomic_and_retries_without_duplicates() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        p.persist_runtime_event(&text_start("root", 0, "prefix"))
            .await
            .unwrap();
        fail_statement(&pool, "UPDATE").await;
        assert!(p
            .persist_runtime_event(&text_delta("root", " missing"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        fail_statement(&pool, "INSERT").await;
        let full = complete("root", vec![text("prefix missing"), text("second block")]);
        assert!(p.persist_runtime_event(&full).await.is_err());
        assert_eq!(
            contents(&pool).await[0].1,
            "prefix",
            "update must roll back when insert fails"
        );
        assert_eq!(p.take_transcript_status_change(false), None);
        recover_database(&pool).await;
        p.persist_runtime_event(&full).await.unwrap();
        let rows = contents(&pool).await;
        assert_eq!(
            rows.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(),
            vec!["prefix missing", "second block"]
        );
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }

    #[tokio::test]
    async fn interleaved_failures_only_recover_when_every_scope_is_saved() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        fail_statement(&pool, "INSERT").await;
        assert!(p
            .persist_runtime_event(&text_start("root", 0, "root"))
            .await
            .is_err());
        assert!(p
            .persist_runtime_event(&text_start("child", 0, "child"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        p.persist_runtime_event(&complete("child", vec![text("child complete")]))
            .await
            .unwrap();
        assert_eq!(p.take_transcript_status_change(false), None);
        assert_eq!(
            p.take_transcript_status_change(true),
            Some(TranscriptPersistenceStatus::Failed)
        );
        p.persist_runtime_event(&complete("root", vec![text("root complete")]))
            .await
            .unwrap();
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }

    #[tokio::test]
    async fn assistant_tool_failure_cannot_orphan_committed_text_identities() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        fail_statement(&pool, "INSERT").await;
        assert!(p
            .persist_runtime_event(&text_start("root", 0, "Hello"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        sqlx::query("CREATE TRIGGER fail_tool BEFORE INSERT ON agent_messages WHEN NEW.message_type = 'tool_call' BEGIN SELECT RAISE(ABORT, 'tool insert rejected'); END")
            .execute(&pool).await.unwrap();
        let message = complete(
            "root",
            vec![
                text("Hello world"),
                RuntimeContentBlock::ToolUse {
                    id: "tool-1".into(),
                    name: "Read".into(),
                    input: serde_json::json!({}),
                },
            ],
        );
        assert!(p.persist_runtime_event(&message).await.is_err());
        assert!(
            contents(&pool).await.is_empty(),
            "tool failure must precede repaired text insertion"
        );
        sqlx::query("DROP TRIGGER fail_tool")
            .execute(&pool)
            .await
            .unwrap();
        let identities = p.persist_runtime_event(&message).await.unwrap();
        let Some(PersistedEventRef::AssistantContent(ids)) = identities else {
            panic!("expected durable assistant identities")
        };
        let rows = contents(&pool).await;
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].0, 0);
        assert_eq!(
            rows.iter().find(|(id, _)| *id == ids[0].1).unwrap().1,
            "Hello world"
        );
    }
    #[tokio::test]
    async fn root_result_preserves_child_proof_and_row_identity_for_later_repair() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        p.persist_runtime_event(&text_start("root", 0, "root"))
            .await
            .unwrap();
        p.persist_runtime_event(&text_start("child", 0, "child"))
            .await
            .unwrap();
        let child_id = contents(&pool).await[1].0;
        p.persist_runtime_event(&result("root")).await.unwrap();
        assert_eq!(p.take_transcript_status_change(true), None);
        fail_statement(&pool, "UPDATE").await;
        assert!(p
            .persist_runtime_event(&text_delta("child", " suffix"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        p.persist_runtime_event(&complete("child", vec![text("child suffix")]))
            .await
            .unwrap();
        assert_eq!(
            contents(&pool).await,
            vec![(1, "root".into()), (child_id, "child suffix".into())]
        );
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }
    #[tokio::test]
    async fn omitted_tool_after_failed_assistant_insert_never_claims_recovery() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        sqlx::query("CREATE TRIGGER fail_tool BEFORE INSERT ON agent_messages WHEN NEW.message_type = 'tool_call' BEGIN SELECT RAISE(ABORT, 'tool insert rejected'); END")
            .execute(&pool).await.unwrap();
        let original = complete(
            "root",
            vec![
                text("answer"),
                RuntimeContentBlock::ToolUse {
                    id: "missing-tool".into(),
                    name: "Read".into(),
                    input: serde_json::json!({}),
                },
            ],
        );
        assert!(matches!(
            p.persist_runtime_event(&original).await,
            Err(TranscriptPersistenceError::Database(_))
        ));
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Failed)
        );
        sqlx::query("DROP TRIGGER fail_tool")
            .execute(&pool)
            .await
            .unwrap();
        p.persist_runtime_event(&complete("root", vec![text("answer")]))
            .await
            .unwrap();
        assert_eq!(
            contents(&pool)
                .await
                .iter()
                .map(|(_, content)| content.as_str())
                .collect::<Vec<_>>(),
            vec!["answer"]
        );
        assert_eq!(
            p.take_transcript_status_change(false),
            None,
            "saving matching text cannot prove the omitted tool was saved"
        );
        assert_eq!(p.take_transcript_status_change(true), None);
    }
}
