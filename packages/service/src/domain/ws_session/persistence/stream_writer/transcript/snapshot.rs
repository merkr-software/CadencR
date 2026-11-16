use super::super::{MergeableMessageType, TranscriptWriter};
use super::{ExpectedContent, TranscriptPersistenceError};
use crate::domain::agents::adapter::{
    RuntimeAssistantMessage, RuntimeContentBlock, RuntimeStreamScope,
};

impl TranscriptWriter {
    pub(super) fn prepare_assistant_snapshot(
        &mut self,
        scope: &RuntimeStreamScope,
        message: &RuntimeAssistantMessage,
    ) -> Result<(), TranscriptPersistenceError> {
        let damaged = self.transcript.is_damaged(scope);
        if self.streamed_assistant_content.contains(scope) && !damaged {
            return Ok(());
        }
        self.validate_assistant_snapshot(scope, message, damaged)?;
        // Remember the entire authoritative snapshot before any fallible writes.
        // A failed unstreamed message must not later be "repaired" by a shorter one.
        for (index, block) in message.content.iter().enumerate() {
            let (kind, content) = match block {
                RuntimeContentBlock::Text { text } => (MergeableMessageType::Text, text),
                RuntimeContentBlock::Thinking { thinking } => {
                    (MergeableMessageType::Thinking, thinking)
                }
                _ => continue,
            };
            if self.transcript.can_track(scope, index as u64) {
                self.transcript.expected.insert(
                    (scope.clone(), index as u64),
                    ExpectedContent::new(kind, content),
                );
            }
        }
        Ok(())
    }

    fn validate_assistant_snapshot(
        &self,
        scope: &RuntimeStreamScope,
        message: &RuntimeAssistantMessage,
        damaged: bool,
    ) -> Result<(), TranscriptPersistenceError> {
        if damaged && self.transcript.recovery_limited {
            return Err(TranscriptPersistenceError::RecoveryLimit);
        }
        if damaged
            && self
                .transcript
                .expected
                .iter()
                .any(|((s, index), expected)| {
                    s == scope
                        && match message.content.get(*index as usize) {
                            Some(RuntimeContentBlock::Text { text }) => {
                                expected.kind != MergeableMessageType::Text
                                    || !expected.matches(text)
                            }
                            Some(RuntimeContentBlock::Thinking { thinking }) => {
                                expected.kind != MergeableMessageType::Thinking
                                    || !expected.matches(thinking)
                            }
                            _ => true,
                        }
                })
        {
            return Err(TranscriptPersistenceError::AwaitingReconciliation);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_helpers::*;
    use super::*;
    use crate::domain::agents::adapter::RuntimeStreamEvent;
    use crate::domain::ws_session::persistence::{
        TranscriptPersistenceStatus, WsSessionPersistence,
    };
    #[tokio::test]
    async fn partial_snapshot_never_overwrites_other_block_types_or_claims_recovery() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        p.persist_runtime_event(&stream_event(
            "root",
            None,
            RuntimeStreamEvent::ContentBlockStart {
                index: 0,
                block: RuntimeContentBlock::Thinking {
                    thinking: "Thinking".into(),
                },
            },
        ))
        .await
        .unwrap();
        fail_statement(&pool, "INSERT").await;
        assert!(p
            .persist_runtime_event(&text_start("root", 1, "Hello"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        assert!(p
            .persist_runtime_event(&complete("root", vec![text("Hello world")]))
            .await
            .is_err());
        assert_eq!(contents(&pool).await[0].1, "Thinking");
        assert_eq!(
            p.take_transcript_status_change(true),
            Some(TranscriptPersistenceStatus::Failed)
        );
        p.persist_runtime_event(&complete(
            "root",
            vec![
                RuntimeContentBlock::Thinking {
                    thinking: "Thinking fully".into(),
                },
                text("Hello world"),
            ],
        ))
        .await
        .unwrap();
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }

    #[tokio::test]
    async fn partial_same_type_snapshot_cannot_drop_saved_or_failed_deltas() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        p.persist_runtime_event(&text_start("root", 0, "saved prefix"))
            .await
            .unwrap();
        fail_statement(&pool, "UPDATE").await;
        assert!(p
            .persist_runtime_event(&text_delta("root", " missing suffix"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        for candidate in ["saved", "saved prefix", "saved prefix wrong suffix"] {
            assert!(p
                .persist_runtime_event(&complete("root", vec![text(candidate)]))
                .await
                .is_err());
            assert_eq!(contents(&pool).await[0].1, "saved prefix");
            assert_eq!(p.take_transcript_status_change(false), None);
        }
        p.persist_runtime_event(&complete("root", vec![text("saved prefix missing suffix")]))
            .await
            .unwrap();
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }
    #[tokio::test]
    async fn unstreamed_failed_full_message_requires_its_complete_original_content() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        let full = complete("root", vec![text("complete unstreamed answer")]);
        fail_statement(&pool, "INSERT").await;
        assert!(p.persist_runtime_event(&full).await.is_err());
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Degraded)
        );
        recover_database(&pool).await;
        assert!(p
            .persist_runtime_event(&complete("root", vec![text("complete")]))
            .await
            .is_err());
        assert!(contents(&pool).await.is_empty());
        p.persist_runtime_event(&full).await.unwrap();
        assert_eq!(contents(&pool).await[0].1, "complete unstreamed answer");
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Recovered)
        );
    }
}
