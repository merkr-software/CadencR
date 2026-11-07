//! End-to-end coverage for issue #58: a turn's `Result` must not drop the
//! session to idle while a `run_in_background` agent it launched is still
//! alive. Exercises the real stream reader + DB, not just the helpers.

use super::support::*;

use crate::domain::agents::adapter::{BackgroundAgentSignal, RuntimeEventMetadata};
use crate::domain::agents::runtime::DEFAULT_PROVIDER;

fn bg(signal: BackgroundAgentSignal) -> RuntimeEvent {
    RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
        .with_background_agent(Some(signal))
}

/// Drain until the reader closes the stream, returning every `ended` reason
/// seen along the way. A `turn_complete` reason is what flips the frontend turn
/// lifecycle to `terminal` (stopping the header timer); issue #58 requires it to
/// be withheld while a background agent is still alive.
async fn drain_ended_reasons_until_closed(
    ws_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Message>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    while let Some(Message::Text(text)) = ws_rx.recv().await {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        if env.action == "ended" {
            let payload: SessionEndedPayload = serde_json::from_value(env.payload).unwrap();
            let reason = payload.reason.clone();
            reasons.push(reason.clone());
            if reason == "stream_closed" {
                break;
            }
        }
    }
    reasons
}

#[tokio::test]
async fn result_keeps_session_running_while_background_agent_alive() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let mut status_rx = app_state.session_status_tx.subscribe();
    let db_session_id = 581i64;
    let feature_id = 1i64;
    insert_running_session(&app_state, db_session_id, feature_id).await;

    // A background agent starts, then the launching turn ends.
    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
    msg_tx
        .send(Ok(bg(BackgroundAgentSignal::Started {
            agent_id: "task-1".into(),
        })))
        .await
        .unwrap();
    msg_tx.send(Ok(result_event())).await.unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        DEFAULT_PROVIDER,
    );
    let ended_reasons = drain_ended_reasons_until_closed(&mut ws_rx).await;

    assert_eq!(
        db_status(&app_state, db_session_id).await,
        "running",
        "session must stay running while a background agent is alive"
    );
    assert!(
        matches!(
            status_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "turn result must not broadcast idle while a background agent is alive"
    );
    // The launching turn's `Result` must not emit a `turn_complete` envelope:
    // that is what would flip the frontend lifecycle to `terminal` and reset the
    // header's elapsed timer on the CLI's auto-resume. Only the final
    // `stream_closed` should appear here.
    assert!(
        !ended_reasons.iter().any(|reason| reason == "turn_complete"),
        "turn result must not emit turn_complete while a background agent is alive, saw {ended_reasons:?}"
    );
}

#[tokio::test]
async fn result_goes_idle_once_the_background_agent_finishes() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let db_session_id = 582i64;
    let feature_id = 1i64;
    insert_running_session(&app_state, db_session_id, feature_id).await;
    // The turn was announced when it started, as `mark_agent_running` does.
    app_state
        .session_status_tx
        .broadcast_running(db_session_id, feature_id);
    let mut status_rx = app_state.session_status_tx.subscribe();

    // Start, finish (the CLI's terminal notification), then the resume turn's
    // result arrives with the live set empty.
    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
    for event in [
        bg(BackgroundAgentSignal::Started {
            agent_id: "task-1".into(),
        }),
        bg(BackgroundAgentSignal::Finished {
            agent_id: "task-1".into(),
        }),
        result_event(),
    ] {
        msg_tx.send(Ok(event)).await.unwrap();
    }
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        DEFAULT_PROVIDER,
    );
    let ended_reasons = drain_ended_reasons_until_closed(&mut ws_rx).await;

    assert_eq!(
        db_status(&app_state, db_session_id).await,
        "completed",
        "session completes once no background agent remains"
    );
    // Once the background agent is gone, the resume turn's `Result` ends the turn
    // normally so the header timer stops and shows the final duration.
    assert!(
        ended_reasons.iter().any(|reason| reason == "turn_complete"),
        "final result must emit turn_complete once no background agent remains, saw {ended_reasons:?}"
    );
    let event = status_rx
        .try_recv()
        .expect("a status update must be broadcast when the last agent finishes");
    assert_eq!(
        event.status,
        crate::domain::session_status::AgentStatus::Idle,
        "the final result must broadcast idle"
    );
}

/// Stop while only a background agent runs (its launching turn already sent
/// its `result`): Claude Code stops the agent and acknowledges, but sends no
/// `result`, since no turn was running. The agent's end must end the stop, or
/// the conversation stays "Working" with nothing left to stop.
#[tokio::test]
async fn a_stop_between_turns_ends_when_the_background_agent_stops() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let db_session_id = 583i64;
    let feature_id = 1i64;
    insert_running_session(&app_state, db_session_id, feature_id).await;
    let runtime = make_active_handle(feature_id, Some("cli".into()));
    let query = runtime.state.active_query().unwrap();
    sdk_sessions.lock().await.insert(db_session_id, runtime);
    app_state
        .active_turns
        .begin_turn(db_session_id, &sdk_sessions)
        .await;
    app_state
        .session_status_tx
        .broadcast_running(db_session_id, feature_id);

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(4);
    let quiet = RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other);
    for event in [
        bg(BackgroundAgentSignal::Started {
            agent_id: "task-1".into(),
        }),
        result_event(),
        quiet,
    ] {
        msg_tx.send(Ok(event)).await.unwrap();
    }
    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        DEFAULT_PROVIDER,
    );
    // The reader took the last event, so it has handled the result.
    while msg_tx.capacity() < 4 {
        tokio::task::yield_now().await;
    }
    app_state
        .active_turns
        .request_interruption(db_session_id, &query)
        .await
        .expect("the live runtime accepts the stop");
    let mut status_rx = app_state.session_status_tx.subscribe();
    msg_tx
        .send(Ok(bg(BackgroundAgentSignal::Finished {
            agent_id: "task-1".into(),
        })))
        .await
        .unwrap();

    // The runtime stays open: closing it would end the stop by itself.
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(Message::Text(text)) = ws_rx.recv().await {
            let env: WsEnvelope = serde_json::from_str(&text).unwrap();
            if env.action == "ended" {
                return env.payload["reason"].clone();
            }
        }
        serde_json::Value::Null
    })
    .await
    .expect("the stop must end once the background agent stops");
    assert_eq!(ended, "turn_interrupted");
    drop(msg_tx);
    assert_eq!(db_status(&app_state, db_session_id).await, "completed");
    let event = status_rx
        .try_recv()
        .expect("the stop must broadcast a status");
    assert_eq!(
        event.status,
        crate::domain::session_status::AgentStatus::Idle
    );
}
