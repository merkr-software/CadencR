use super::{MergeableMessageType, PendingMergeableBlock, TranscriptWriter};
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeContentDelta, RuntimeEvent, RuntimeStreamEvent, RuntimeStreamScope,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_TRACKED_BLOCKS: usize = 4096;
const MAX_DAMAGED_SCOPES: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum TranscriptPersistenceError {
    #[error("transcript session has no database identity")]
    MissingSession,
    #[error("transcript database write failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("transcript row {0} is missing")]
    MissingRow(i64),
    #[error("transcript is waiting for a complete assistant message to repair missing content")]
    AwaitingReconciliation,
    #[error("transcript recovery metadata limit reached")]
    RecoveryLimit,
}

pub use crate::domain::ws_session::protocol::PersistenceStatusState as TranscriptPersistenceStatus;

impl TranscriptPersistenceStatus {
    pub fn message(self) -> &'static str {
        match self {
            Self::Degraded => "Conversation history could not be saved. Live output continues; waiting for a complete message to repair history.",
            Self::Recovered => "Conversation history has been repaired and saved.",
            Self::Failed => "Some conversation history could not be saved. Live output may be missing after reopening this conversation.",
        }
    }
}

pub(super) struct ExpectedContent {
    kind: MergeableMessageType,
    bytes: usize,
    digest: Sha256,
}

impl ExpectedContent {
    fn new(kind: MergeableMessageType, content: &str) -> Self {
        Self {
            kind,
            bytes: content.len(),
            digest: Sha256::new().chain_update(content.as_bytes()),
        }
    }

    fn append(&mut self, delta: &str) {
        self.bytes = self.bytes.saturating_add(delta.len());
        self.digest.update(delta.as_bytes());
    }

    fn matches(&self, content: &str) -> bool {
        content
            .as_bytes()
            .get(..self.bytes)
            .is_some_and(|prefix| Sha256::digest(prefix) == self.digest.clone().finalize())
    }
}

#[derive(Default)]
pub(super) struct TranscriptDurability {
    pub(super) rows: HashMap<(RuntimeStreamScope, u64), PendingMergeableBlock>,
    pub(super) expected: HashMap<(RuntimeStreamScope, u64), ExpectedContent>,
    damaged: HashSet<RuntimeStreamScope>,
    unrecoverable: bool,
    // Once any proof was omitted, conservatively keep it unknown for this reader.
    // Healthy writes continue; only a subsequent actual write failure surfaces it.
    recovery_limited: bool,
    emitted: Option<TranscriptPersistenceStatus>,
}

impl TranscriptDurability {
    fn can_track(&mut self, scope: &RuntimeStreamScope, index: u64) -> bool {
        let available = self.expected.len() < MAX_TRACKED_BLOCKS
            || self.expected.contains_key(&(scope.clone(), index));
        if !available {
            self.recovery_limited = true;
        }
        available
    }

    pub(super) fn observe_start(
        &mut self,
        scope: &RuntimeStreamScope,
        index: u64,
        kind: MergeableMessageType,
        content: &str,
    ) -> Result<(), TranscriptPersistenceError> {
        if !self.can_track(scope, index) {
            return Ok(());
        }
        self.expected
            .entry((scope.clone(), index))
            .or_insert_with(|| ExpectedContent::new(kind, content));
        Ok(())
    }

    pub(super) fn observe_delta(
        &mut self,
        scope: &RuntimeStreamScope,
        index: u64,
        kind: MergeableMessageType,
        delta: &str,
    ) -> Result<(), TranscriptPersistenceError> {
        if !self.can_track(scope, index) {
            return Ok(());
        }
        self.expected
            .entry((scope.clone(), index))
            .and_modify(|expected| expected.append(delta))
            .or_insert_with(|| ExpectedContent::new(kind, delta));
        Ok(())
    }

    pub(super) fn is_damaged(&self, scope: &RuntimeStreamScope) -> bool {
        self.damaged.contains(scope)
    }

    pub(super) fn begin_cycle(&mut self, scope: &RuntimeStreamScope) {
        // A new cycle cannot safely reuse the preceding message's row identities.
        if self.damaged.remove(scope) {
            self.unrecoverable = true;
        }
        self.rows.retain(|(row_scope, _), _| row_scope != scope);
        self.expected.retain(|(row_scope, _), _| row_scope != scope);
    }

    fn record_failure(&mut self, event: &RuntimeEvent) {
        let repairable = matches!(
            event.stream_event(),
            Some(
                RuntimeStreamEvent::ContentBlockStart {
                    block: RuntimeContentBlock::Text { .. } | RuntimeContentBlock::Thinking { .. },
                    ..
                } | RuntimeStreamEvent::ContentBlockDelta {
                    delta: RuntimeContentDelta::Text { .. } | RuntimeContentDelta::Thinking { .. },
                    ..
                }
            )
        ) || event.assistant_message().is_some();
        let scope = RuntimeStreamScope::for_event(event);
        if self.recovery_limited {
            self.unrecoverable = true;
        }
        if repairable && (self.damaged.contains(&scope) || self.damaged.len() < MAX_DAMAGED_SCOPES)
        {
            self.damaged.insert(scope);
        } else {
            self.unrecoverable = true;
        }
    }

    fn finish_scope(&mut self, scope: &RuntimeStreamScope) {
        if self.damaged.contains(scope) {
            return;
        }
        self.rows.retain(|(row_scope, _), _| row_scope != scope);
        self.expected.retain(|(row_scope, _), _| row_scope != scope);
    }

    fn repaired(&mut self, scope: &RuntimeStreamScope) {
        self.damaged.remove(scope);
        self.rows.retain(|(row_scope, _), _| row_scope != scope);
        self.expected.retain(|(row_scope, _), _| row_scope != scope);
    }
}

impl TranscriptWriter {
    /// Emit changes only. Successful unrelated writes never claim recovery.
    pub(in super::super) fn take_transcript_status_change(
        &mut self,
        terminal: bool,
    ) -> Option<TranscriptPersistenceStatus> {
        let has_failure = self.transcript.unrecoverable || !self.transcript.damaged.is_empty();
        let status = if has_failure {
            if terminal || self.transcript.unrecoverable {
                TranscriptPersistenceStatus::Failed
            } else {
                TranscriptPersistenceStatus::Degraded
            }
        } else if self.transcript.emitted.is_some() {
            TranscriptPersistenceStatus::Recovered
        } else {
            return None;
        };
        // Do not downgrade a known terminal failure merely because another delta arrives.
        if self.transcript.emitted == Some(TranscriptPersistenceStatus::Failed)
            && status == TranscriptPersistenceStatus::Degraded
        {
            return None;
        }
        if self.transcript.emitted == Some(status) {
            return None;
        }
        self.transcript.emitted = Some(status);
        Some(status)
    }
}

mod events;
mod reconciliation;
mod snapshot;

#[cfg(test)]
mod test_helpers {
    pub(super) use super::super::events::session_events_tests::{setup_test_db, stream_event};
    use super::*;
    use crate::domain::agents::adapter::RuntimeAssistantMessage;
    use crate::domain::agents::adapter::{RuntimeEventKind, RuntimeEventMetadata};
    use sqlx::SqlitePool;
    pub(super) fn result(scope: &str) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(scope.into()),
                ..Default::default()
            },
            RuntimeEventKind::Result,
        )
    }

    pub(super) fn text_start(scope: &str, index: u64, text: &str) -> RuntimeEvent {
        stream_event(
            scope,
            None,
            RuntimeStreamEvent::ContentBlockStart {
                index,
                block: RuntimeContentBlock::Text { text: text.into() },
            },
        )
    }

    pub(super) fn text_delta(scope: &str, text: &str) -> RuntimeEvent {
        stream_event(
            scope,
            None,
            RuntimeStreamEvent::ContentBlockDelta {
                index: 0,
                delta: RuntimeContentDelta::Text { text: text.into() },
            },
        )
    }

    pub(super) fn complete(scope: &str, blocks: Vec<RuntimeContentBlock>) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some(scope.into()),
                usage: None,
                context_window: None,
                raw: serde_json::json!({}),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: blocks,
                },
                parent_tool_use_id: None,
            },
        )
    }

    pub(super) fn text(value: &str) -> RuntimeContentBlock {
        RuntimeContentBlock::Text { text: value.into() }
    }

    pub(super) async fn fail_statement(pool: &SqlitePool, operation: &str) {
        // Deliberately fail a real SQLite statement, preserving the production code path.
        let sql = match operation {
            "INSERT" => "CREATE TRIGGER fail_transcript BEFORE INSERT ON agent_messages BEGIN SELECT RAISE(ABORT, 'injected transcript failure'); END",
            "UPDATE" => "CREATE TRIGGER fail_transcript BEFORE UPDATE ON agent_messages BEGIN SELECT RAISE(ABORT, 'injected transcript failure'); END",
            _ => panic!("unsupported test operation"),
        };
        sqlx::query(sql).execute(pool).await.unwrap();
    }

    pub(super) async fn recover_database(pool: &SqlitePool) {
        sqlx::query("DROP TRIGGER fail_transcript")
            .execute(pool)
            .await
            .unwrap();
    }

    pub(super) async fn contents(pool: &SqlitePool) -> Vec<(i64, String)> {
        sqlx::query_as("SELECT id, content FROM agent_messages ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::*;
    use super::*;
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    #[tokio::test]
    async fn healthy_stream_only_turn_releases_recovery_metadata() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool, 1, Some(1));
        p.persist_runtime_event(&text_start("root", 0, "saved"))
            .await
            .unwrap();
        assert_eq!(p.writer.transcript.expected.len(), 1);
        p.persist_runtime_event(&result("root")).await.unwrap();
        assert_eq!(p.take_transcript_status_change(true), None);
        assert!(p.writer.transcript.expected.is_empty());
        assert!(p.writer.transcript.rows.is_empty());
    }

    #[tokio::test]
    async fn fresh_cycle_cannot_clear_unreconciled_history_and_metadata_is_bounded() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        fail_statement(&pool, "INSERT").await;
        assert!(p
            .persist_runtime_event(&text_start("root", 0, "missing"))
            .await
            .is_err());
        p.take_transcript_status_change(false);
        recover_database(&pool).await;
        p.persist_runtime_event(&stream_event(
            "root",
            None,
            RuntimeStreamEvent::MessageStart {
                model: None,
                input_tokens: None,
            },
        ))
        .await
        .unwrap();
        p.persist_runtime_event(&complete("root", vec![text("next message")]))
            .await
            .unwrap();
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Failed)
        );
    }
    #[tokio::test]
    async fn saturated_recovery_metadata_never_blocks_healthy_persistence() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        let old_scope = RuntimeStreamScope::new(Some("old"), None);
        for index in 0..MAX_TRACKED_BLOCKS as u64 {
            p.writer
                .transcript
                .observe_start(&old_scope, index, MergeableMessageType::Text, "old")
                .unwrap();
        }
        p.persist_runtime_event(&text_start("new", 0, "saved"))
            .await
            .unwrap();
        assert_eq!(contents(&pool).await[0].1, "saved");
        assert_eq!(p.writer.transcript.expected.len(), MAX_TRACKED_BLOCKS);
        assert_eq!(p.take_transcript_status_change(false), None);
        fail_statement(&pool, "UPDATE").await;
        assert!(p
            .persist_runtime_event(&text_delta("new", " missing"))
            .await
            .is_err());
        assert_eq!(
            p.take_transcript_status_change(false),
            Some(TranscriptPersistenceStatus::Failed)
        );
        recover_database(&pool).await;
        assert!(matches!(
            p.persist_runtime_event(&complete("new", vec![text("saved missing")]))
                .await,
            Err(TranscriptPersistenceError::RecoveryLimit)
        ));
    }
}
