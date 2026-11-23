//! The real stream reader against coalesced text deltas: when the buffer is
//! written, what an attaching viewer receives, and what a rewind waits for.
//!
//! Every test freezes the paused clock (see [`freeze_paused_clock`]), so a
//! delta after the first stays buffered until a boundary writes it — which
//! is what each test is about.

use super::support::*;
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeContentDelta, RuntimeEventMetadata, RuntimeStreamEvent,
};
use std::time::Duration;

const FEATURE_ID: i64 = 1;

type EventTx = mpsc::Sender<Result<RuntimeEvent, RuntimeError>>;

/// A runtime whose stream ends some time after it is closed, like a provider
/// process exiting.
struct ClosableRuntime {
    tx: Option<EventTx>,
    rx: Option<RuntimeMessageRx>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for ClosableRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        self.rx.take().unwrap()
    }
    async fn session_id(&self) -> Option<String> {
        None
    }
    async fn stream_input(&self, _: Value) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn close(&mut self) -> Result<(), RuntimeError> {
        let tx = self.tx.take();
        tokio::spawn(async move {
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
            drop(tx);
        });
        Ok(())
    }
    async fn set_model(&self, _: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn set_permission_mode(&self, _: RuntimePermissionMode) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn pid(&self) -> Option<u32> {
        None
    }
}

struct Harness {
    app_state: AppState,
    sessions: SdkSessions,
    db_id: i64,
    ws_rx: mpsc::UnboundedReceiver<Message>,
    /// `None` once the runtime owns the only sender (`closable`).
    events: Option<EventTx>,
    _clock: FrozenClock,
}

fn stream(event: RuntimeStreamEvent) -> RuntimeEvent {
    RuntimeEvent::new(
        RuntimeEventMetadata {
            session_id: Some("runtime".into()),
            raw: serde_json::json!({ "type": "stream_event" }),
            ..Default::default()
        },
        RuntimeEventKind::StreamEvent {
            event,
            parent_tool_use_id: None,
        },
    )
}

fn text_start(text: &str) -> RuntimeEvent {
    stream(RuntimeStreamEvent::ContentBlockStart {
        index: 0,
        block: RuntimeContentBlock::Text { text: text.into() },
    })
}

fn text_delta(text: &str) -> RuntimeEvent {
    stream(RuntimeStreamEvent::ContentBlockDelta {
        index: 0,
        delta: RuntimeContentDelta::Text { text: text.into() },
    })
}

/// "Hel" + "lo" (written at once) + " world" (buffered).
const STREAMED: [&str; 3] = ["Hel", "lo", " world"];

impl Harness {
    /// A running session whose reader has processed `STREAMED`. With
    /// `closable`, closing the runtime ends the stream.
    async fn streaming(db_id: i64, closable: bool) -> Self {
        let clock = freeze_paused_clock();
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, db_id, FEATURE_ID).await;
        let (tx, rx) = mpsc::channel(16);
        let runtime = ClosableRuntime {
            tx: closable.then(|| tx.clone()),
            rx: Some(rx),
        };
        let mut handle = make_active_handle(FEATURE_ID, None);
        let QueryState::Active { query, .. } = &mut handle.state else {
            unreachable!()
        };
        *query = Arc::new(RwLock::new(Box::new(runtime)));
        let message_rx = query.write().await.take_message_rx();
        let sessions: SdkSessions = Arc::new(Mutex::new(HashMap::from([(db_id, handle)])));
        let (ws_tx, ws_rx) = mpsc::unbounded_channel();
        spawn_test_stream_reader(
            &app_state,
            db_id,
            FEATURE_ID,
            message_rx,
            ws_tx,
            sessions.clone(),
            "claude_code",
        );
        let mut harness = Self {
            app_state,
            sessions,
            db_id,
            ws_rx,
            events: (!closable).then_some(tx.clone()),
            _clock: clock,
        };
        tx.send(Ok(text_start(STREAMED[0]))).await.unwrap();
        for delta in &STREAMED[1..] {
            tx.send(Ok(text_delta(delta))).await.unwrap();
        }
        drop(tx);
        for _ in STREAMED {
            harness.next_message().await;
        }
        assert_eq!(
            harness.content().await,
            "Hello",
            "the last delta is buffered"
        );
        harness
    }

    /// Next `session.message` payload block (frames are published before the
    /// buffer is written, so this also marks the reader's progress).
    async fn next_message(&mut self) -> Value {
        loop {
            let Some(Message::Text(text)) = recv_bounded(&mut self.ws_rx).await else {
                panic!("the reader ended before sending a message");
            };
            let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
            if envelope.action == "message" {
                return envelope.payload["blocks"][0].clone();
            }
        }
    }

    /// Every action the reader sends until it ends.
    async fn remaining_actions(&mut self) -> Vec<(String, Value)> {
        let mut actions = Vec::new();
        while let Some(message) = recv_bounded(&mut self.ws_rx).await {
            if let Message::Text(text) = message {
                let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
                actions.push((envelope.action, envelope.payload));
            }
        }
        actions
    }

    async fn content(&self) -> String {
        sqlx::query_scalar(
            "SELECT COALESCE(group_concat(content, '|'), '') FROM agent_messages \
             WHERE session_id = ? AND message_type = 'text'",
        )
        .bind(self.db_id)
        .fetch_one(&self.app_state.write_pool)
        .await
        .unwrap()
    }

    async fn content_after_reader_ends(&mut self) -> String {
        self.remaining_actions().await;
        self.content().await
    }
}

/// The frozen clock disables tokio timeouts, so waits are bounded in real
/// time: a reader that stalls fails the test instead of hanging it.
struct RealDeadline(std::time::Instant);

impl RealDeadline {
    fn new() -> Self {
        Self(std::time::Instant::now() + std::time::Duration::from_secs(30))
    }

    fn check(&self, what: &str) {
        assert!(std::time::Instant::now() < self.0, "{what}");
    }
}

async fn recv_bounded(rx: &mut mpsc::UnboundedReceiver<Message>) -> Option<Message> {
    let deadline = RealDeadline::new();
    loop {
        match rx.try_recv() {
            Ok(message) => return Some(message),
            Err(mpsc::error::TryRecvError::Disconnected) => return None,
            Err(mpsc::error::TryRecvError::Empty) => {
                deadline.check("the reader stalled");
                tokio::task::yield_now().await;
            }
        }
    }
}

fn reported_failure(actions: &[(String, Value)]) -> bool {
    actions
        .iter()
        .any(|(action, payload)| action == "persistence_status" && payload["status"] != "recovered")
}

#[tokio::test(start_paused = true)]
async fn a_paused_stream_writes_its_buffer_at_the_flush_deadline() {
    let harness = Harness::streaming(701, false).await;
    tokio::time::advance(Duration::from_millis(199)).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(harness.content().await, "Hello", "the window is still open");

    // No event arrives: the reader wakes on the deadline, not the next event.
    tokio::time::advance(Duration::from_millis(1)).await;
    let deadline = RealDeadline::new();
    while harness.content().await != "Hello world" {
        deadline.check("the buffer was never written");
        tokio::task::yield_now().await;
    }
    drop(harness.events);
}

#[tokio::test(start_paused = true)]
async fn closing_the_stream_writes_the_buffered_text() {
    let mut harness = Harness::streaming(702, false).await;
    drop(harness.events.take());
    assert_eq!(harness.content_after_reader_ends().await, "Hello world");
}

#[tokio::test(start_paused = true)]
async fn a_runtime_error_writes_the_buffered_text() {
    let mut harness = Harness::streaming(703, false).await;
    let events = harness.events.take().unwrap();
    events
        .send(Err(RuntimeError::new("provider crashed")))
        .await
        .unwrap();
    assert_eq!(harness.content_after_reader_ends().await, "Hello world");
}

#[tokio::test(start_paused = true)]
async fn a_superseded_stream_writes_the_buffered_text_before_it_stops() {
    let mut harness = Harness::streaming(704, false).await;
    // Another runtime took the session over: the next event is discarded and
    // the reader stops.
    harness.sessions.lock().await.remove(&harness.db_id);
    let events = harness.events.take().unwrap();
    events.send(Ok(text_delta(" lost"))).await.unwrap();
    assert_eq!(harness.content_after_reader_ends().await, "Hello world");
    drop(events);
}

/// Found in review: a viewer's history snapshot is read before its socket
/// joins the stream, and the buffer is not in the database yet. The reader
/// now re-sends the live block's whole text, buffered tail included.
#[tokio::test(start_paused = true)]
async fn an_attaching_viewer_gets_the_full_text_including_buffered_deltas() {
    let mut harness = Harness::streaming(705, false).await;
    crate::domain::ws_session::stream_readers::request_live_catch_up(harness.db_id);

    let block = harness.next_message().await;
    assert_eq!(block["event"]["type"], "content_block_snapshot");
    assert_eq!(block["event"]["index"], 0);
    assert_eq!(block["event"]["content_block"]["text"], "Hello world");
    assert_eq!(harness.content().await, "Hello world", "written first");
    let row_id: i64 = sqlx::query_scalar("SELECT id FROM agent_messages WHERE session_id = ?")
        .bind(harness.db_id)
        .fetch_one(&harness.app_state.write_pool)
        .await
        .unwrap();
    assert_eq!(block["agent_message_id"], row_id);

    // Later deltas of the same row follow it in the stream.
    let events = harness.events.take().unwrap();
    events.send(Ok(text_delta("!"))).await.unwrap();
    let next = harness.next_message().await;
    assert_eq!(next["agent_message_id"], row_id);
    drop(events);
}

/// Found in review: a reader still draining a runtime the session left must
/// not restate blocks into the live reader's stream.
#[tokio::test(start_paused = true)]
async fn a_superseded_reader_sends_no_catch_up() {
    let mut harness = Harness::streaming(708, false).await;
    harness.sessions.lock().await.remove(&harness.db_id);
    crate::domain::ws_session::stream_readers::request_live_catch_up(harness.db_id);
    drop(harness.events.take());
    let actions = harness.remaining_actions().await;
    let restated = actions
        .iter()
        .any(|(_, payload)| payload.to_string().contains("content_block_snapshot"));
    assert!(!restated, "{actions:?}");
}

/// Found in review: a rewind deleted the cut rows while the stopped turn's
/// reader still held buffered text. Its final flush then found no row and
/// told every viewer that history could not be saved. The branch now waits
/// for that flush before it rewrites the transcript.
#[tokio::test(start_paused = true)]
async fn a_rewind_lets_the_stopped_readers_flush_land_before_deleting() {
    let mut harness = Harness::streaming(706, true).await;
    let branching = super::super::session_branch::stop_live_turn(
        &harness.sessions,
        &harness.app_state,
        harness.db_id,
    )
    .await;
    let flushed = harness.content().await;
    sqlx::query("DELETE FROM agent_messages WHERE session_id = ?")
        .bind(harness.db_id)
        .execute(&harness.app_state.write_pool)
        .await
        .unwrap();
    drop(branching);

    let actions = harness.remaining_actions().await;
    assert!(!reported_failure(&actions), "{actions:?}");
    assert_eq!(flushed, "Hello world", "the branch saw the whole text");
}

/// Found in QA: the stopped turn's closing "Worked …" line was queued when
/// the rewind announced the session idle — after its DELETE — so the cut turn
/// came back as an orphan summary row. The stop now ends the turn and writes
/// its line before returning, so the rewind deletes it with the turn.
#[tokio::test(start_paused = true)]
async fn a_rewind_deletes_the_stopped_turns_summary_with_the_turn() {
    use crate::domain::session_status::AgentStatus;

    let harness = Harness::streaming(707, true).await;
    let statuses = &harness.app_state.session_status_tx;
    statuses.broadcast_running(harness.db_id, FEATURE_ID);
    let branching = super::super::session_branch::stop_live_turn(
        &harness.sessions,
        &harness.app_state,
        harness.db_id,
    )
    .await;
    // What `apply_db_rewind` and `finish_rewind` then do.
    sqlx::query("DELETE FROM agent_messages WHERE session_id = ?")
        .bind(harness.db_id)
        .execute(&harness.app_state.write_pool)
        .await
        .unwrap();
    statuses.broadcast(harness.db_id, FEATURE_ID, AgentStatus::Idle, None);
    drop(branching);
    statuses
        .journal()
        .flush(
            &harness.app_state.write_pool,
            &harness.app_state.ws_feature_senders,
        )
        .await;

    let left: Vec<String> =
        sqlx::query_scalar("SELECT message_type FROM agent_messages WHERE session_id = ?")
            .bind(harness.db_id)
            .fetch_all(&harness.app_state.write_pool)
            .await
            .unwrap();
    assert!(left.is_empty(), "{left:?}");
}
