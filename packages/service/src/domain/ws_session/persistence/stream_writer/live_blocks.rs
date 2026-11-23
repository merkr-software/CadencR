//! Full text of the current message cycle's text/thinking rows, for a viewer
//! that attached mid-stream.
//!
//! A viewer's history snapshot is read before its socket joins the stream, so
//! it can miss the deltas published in between, and — because deltas are
//! buffered (see [`super::DELTA_FLUSH_INTERVAL`]) — ones already published but
//! not yet written. The reader flushes its buffers, reads these rows back, and
//! publishes their full text in stream order, so every later delta continues
//! the complete text.

use super::super::TranscriptPersistenceError;
use super::TranscriptWriter;
use crate::domain::agents::adapter::RuntimeStreamScope;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveBlockContent {
    pub(crate) scope: RuntimeStreamScope,
    pub(crate) index: u64,
    pub(crate) row_id: i64,
    pub(crate) message_type: &'static str,
    pub(crate) content: String,
    /// The row's own model and creation time, so restating the block never
    /// relabels or re-dates what the viewer already shows.
    pub(crate) model: Option<String>,
    pub(crate) created_at: String,
    /// Deltas may still extend it: only an open block claims its stream
    /// index on the viewer.
    pub(crate) open: bool,
}

type LiveRow = (i64, String, Option<String>, String);

impl TranscriptWriter {
    /// Rows are read as they are now: flush the buffered deltas first so the
    /// text includes everything already published. A row a rewind deleted
    /// has nothing left to show and is skipped.
    pub(in super::super) async fn live_block_contents(
        &self,
    ) -> Result<Vec<LiveBlockContent>, TranscriptPersistenceError> {
        if self.cycle_text_rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(
            &self
                .cycle_text_rows
                .values()
                .map(|row| row.row_id)
                .collect::<Vec<_>>(),
        )
        .expect("row ids serialize");
        let rows: Vec<LiveRow> = sqlx::query_as(
            "SELECT id, content, model, created_at FROM agent_messages \
             WHERE id IN (SELECT value FROM json_each(?))",
        )
        .bind(ids)
        .fetch_all(&self.write_pool)
        .await?;
        let mut rows: std::collections::HashMap<i64, LiveRow> =
            rows.into_iter().map(|row| (row.0, row)).collect();
        let mut contents: Vec<_> = self
            .cycle_text_rows
            .iter()
            .filter_map(|(key, row)| {
                let (_, content, model, created_at) = rows.remove(&row.row_id)?;
                Some(LiveBlockContent {
                    scope: key.0.clone(),
                    index: key.1,
                    row_id: row.row_id,
                    message_type: row.message_type.db_value(),
                    content,
                    model,
                    created_at,
                    open: self.pending_mergeable_blocks.contains_key(key),
                })
            })
            .collect();
        contents.sort_by_key(|block| block.row_id);
        Ok(contents)
    }
}

#[cfg(test)]
mod tests {
    use super::super::events::session_events_tests::{setup_test_db, stream_event};
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeContentDelta, RuntimeStreamEvent,
    };
    use crate::domain::ws_session::handler::tests::support::freeze_paused_clock;
    use crate::domain::ws_session::persistence::WsSessionPersistence;

    fn start(index: u64, text: &str) -> RuntimeStreamEvent {
        RuntimeStreamEvent::ContentBlockStart {
            index,
            block: RuntimeContentBlock::Text { text: text.into() },
        }
    }

    async fn persist(
        p: &mut WsSessionPersistence,
        scope: &str,
        ptuid: Option<&str>,
        event: RuntimeStreamEvent,
    ) {
        p.persist_runtime_event_buffered(&stream_event(scope, ptuid, event))
            .await
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn includes_buffered_and_stopped_blocks_of_every_scope_until_the_cycle_ends() {
        let _clock = freeze_paused_clock();
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        persist(&mut p, "root", None, start(0, "Hel")).await;
        persist(
            &mut p,
            "root",
            None,
            RuntimeStreamEvent::ContentBlockStop { index: 0 },
        )
        .await;
        persist(&mut p, "root", None, start(1, "second")).await;
        persist(&mut p, "root", Some("task"), start(0, "sub")).await;
        for (ptuid, index, text) in [(None, 1, " block"), (Some("task"), 0, "agent")] {
            let delta = RuntimeStreamEvent::ContentBlockDelta {
                index,
                delta: RuntimeContentDelta::Text { text: text.into() },
            };
            persist(&mut p, "root", ptuid, delta).await;
        }

        // Deltas still in the buffer are not in the rows yet.
        let before: Vec<_> = p
            .live_block_contents()
            .await
            .unwrap()
            .into_iter()
            .map(|block| block.content)
            .collect();
        assert_eq!(before, ["Hel", "second", "sub"]);

        p.flush_all_pending_deltas().await.unwrap();
        let blocks = p.live_block_contents().await.unwrap();
        let summary: Vec<_> = blocks
            .iter()
            .map(|b| (b.index, b.message_type, b.content.as_str(), b.open))
            .collect();
        assert_eq!(
            summary,
            [
                (0, "text", "Hel", false),
                (1, "text", "second block", true),
                (0, "text", "subagent", true)
            ]
        );
        let stored: (Option<String>, String) =
            sqlx::query_as("SELECT model, created_at FROM agent_messages WHERE id = ?")
                .bind(blocks[0].row_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            (blocks[0].model.clone(), blocks[0].created_at.clone()),
            stored
        );

        // A new message cycle of the root scope drops its rows only.
        let message_start = RuntimeStreamEvent::MessageStart {
            model: None,
            input_tokens: None,
        };
        persist(&mut p, "root", None, message_start).await;
        let left: Vec<_> = p
            .live_block_contents()
            .await
            .unwrap()
            .into_iter()
            .map(|block| block.content)
            .collect();
        assert_eq!(left, ["subagent"]);

        sqlx::query("DELETE FROM agent_messages")
            .execute(&pool)
            .await
            .unwrap();
        assert!(p.live_block_contents().await.unwrap().is_empty());
    }

    /// Found in review: a sub-agent scope never gets a `Result` of its own, so
    /// its rows outlived the turn and every later catch-up restated them.
    #[tokio::test(start_paused = true)]
    async fn the_turns_result_retires_sub_agent_rows_too() {
        let _clock = freeze_paused_clock();
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(1));
        persist(&mut p, "root", Some("task"), start(0, "sub")).await;
        persist(&mut p, "root", None, start(0, "root")).await;
        assert_eq!(p.live_block_contents().await.unwrap().len(), 2);

        let result = crate::domain::agents::adapter::RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata {
                session_id: Some("root".into()),
                ..Default::default()
            },
            crate::domain::agents::adapter::RuntimeEventKind::Result,
        );
        p.persist_runtime_event_buffered(&result).await.unwrap();
        assert!(p.live_block_contents().await.unwrap().is_empty());
    }
}
