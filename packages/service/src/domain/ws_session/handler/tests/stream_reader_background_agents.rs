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

fn result() -> RuntimeEvent {
    RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result)
}

async fn insert_running_session(app_state: &AppState, db_session_id: i64, feature_id: i64) {
    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES (?, ?, 'session', 'running')",
    )
    .bind(db_session_id)
    .bind(feature_id)
    .execute(&app_state.write_pool)
    .await
    .unwrap();
}

async fn db_status(app_state: &AppState, db_session_id: i64) -> String {
    sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
        .bind(db_session_id)
        .fetch_one(&app_state.write_pool)
        .await
        .unwrap()
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
    msg_tx.send(Ok(result())).await.unwrap();
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
    let mut status_rx = app_state.session_status_tx.subscribe();
    let db_session_id = 582i64;
    let feature_id = 1i64;
    insert_running_session(&app_state, db_session_id, feature_id).await;

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
        result(),
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
