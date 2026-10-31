//! The sub-agent registry follows the runtime through the real stream reader:
//! a reader's own sub-agents stop when its runtime goes away, however it went,
//! and a previous runtime's leftovers never complete with a newer turn.

use super::support::*;

use crate::domain::agents::adapter::{
    RuntimeSubagentPatch, RuntimeSubagentStatus, RuntimeSubagentUpdate,
};
use crate::domain::agents::runtime::DEFAULT_PROVIDER;
use crate::domain::subagents::repository::{self, SubagentChange};
use crate::domain::subagents::SubagentRunStatus;

fn launch(tool_use_id: &str, background: bool) -> RuntimeEvent {
    RuntimeEvent::subagent_signal(vec![RuntimeSubagentUpdate::new(
        tool_use_id,
        RuntimeSubagentPatch {
            background: Some(background),
            ..RuntimeSubagentPatch::status(RuntimeSubagentStatus::Running)
        },
    )])
}

async fn run_state(app_state: &AppState, session_id: i64, tool_use_id: &str) -> (String, String) {
    let run = repository::load(&app_state.write_pool, session_id, tool_use_id)
        .await
        .unwrap()
        .expect("the run is registered");
    (
        run.status.as_str().to_string(),
        run.status_reason.unwrap_or_default(),
    )
}

/// Every envelope action the reader sent, with the status a sub-agent push carried.
async fn drain(ws_rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<String> {
    let mut seen = Vec::new();
    while let Some(Message::Text(text)) = ws_rx.recv().await {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        let detail = env.payload["status"]
            .as_str()
            .or_else(|| env.payload["reason"].as_str())
            .unwrap_or_default()
            .to_string();
        seen.push(format!("{}:{detail}", env.action));
    }
    seen
}

/// Poll the registry until `done` holds for the run (the reader runs apart).
async fn wait_for_run(
    app_state: &AppState,
    session_id: i64,
    tool_use_id: &str,
    done: impl Fn(SubagentRunStatus) -> bool,
) {
    for _ in 0..500 {
        let run = repository::load(&app_state.write_pool, session_id, tool_use_id)
            .await
            .unwrap();
        if run.is_some_and(|run| done(run.status)) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{tool_use_id} never reached the expected status");
}

#[tokio::test]
async fn a_destroyed_runtime_stops_its_sub_agents() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, _ws_rx) = mpsc::unbounded_channel();
    let session_id = 701;
    insert_running_session(&app_state, session_id, 1).await;
    let handle = make_active_handle(1, Some("live".into()));
    let QueryState::Active { query, .. } = &handle.state else {
        unreachable!()
    };
    let query = query.clone();
    sdk_sessions.lock().await.insert(session_id, handle);

    let (msg_tx, msg_rx) = mpsc::channel(2);
    spawn_test_stream_reader_for_runtime(
        &app_state,
        session_id,
        1,
        msg_rx,
        Some(Arc::downgrade(&query)),
        ws_tx,
        sdk_sessions.clone(),
        DEFAULT_PROVIDER,
        false,
    );
    msg_tx.send(Ok(launch("toolu_1", false))).await.unwrap();
    wait_for_run(&app_state, session_id, "toolu_1", |status| {
        status == SubagentRunStatus::Running
    })
    .await;

    // Destroy removes the session's handle, then closes its runtime.
    sdk_sessions.lock().await.remove(&session_id);
    drop(msg_tx);
    wait_for_run(&app_state, session_id, "toolu_1", |status| {
        status != SubagentRunStatus::Running
    })
    .await;
    assert_eq!(
        run_state(&app_state, session_id, "toolu_1").await,
        ("stopped".into(), "runtime_ended".into())
    );
}

#[tokio::test]
async fn a_new_runtime_stops_leftovers_instead_of_completing_them() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let session_id = 702;
    insert_running_session(&app_state, session_id, 1).await;
    let leftover = SubagentChange {
        tool_use_id: "toolu_old".into(),
        parent_tool_use_id: None,
        patch: RuntimeSubagentPatch::status(RuntimeSubagentStatus::Running),
    };
    repository::apply_change(&app_state.write_pool, session_id, &leftover)
        .await
        .unwrap();

    let (msg_tx, msg_rx) = mpsc::channel(2);
    msg_tx.send(Ok(result_event())).await.unwrap();
    drop(msg_tx);
    spawn_test_stream_reader(
        &app_state,
        session_id,
        1,
        msg_rx,
        ws_tx,
        sdk_sessions,
        DEFAULT_PROVIDER,
    );
    drain(&mut ws_rx).await;

    assert_eq!(
        run_state(&app_state, session_id, "toolu_old").await,
        ("stopped".into(), "runtime_ended".into())
    );
}

#[tokio::test]
async fn sub_agents_settle_before_the_stream_end_is_announced() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let session_id = 703;
    insert_running_session(&app_state, session_id, 1).await;

    // A background agent outlives its turn, so only the runtime's end stops it.
    let (msg_tx, msg_rx) = mpsc::channel(2);
    msg_tx.send(Ok(launch("toolu_1", true))).await.unwrap();
    msg_tx.send(Ok(result_event())).await.unwrap();
    drop(msg_tx);
    spawn_test_stream_reader(
        &app_state,
        session_id,
        1,
        msg_rx,
        ws_tx,
        sdk_sessions,
        DEFAULT_PROVIDER,
    );
    let seen = drain(&mut ws_rx).await;

    let stopped = seen
        .iter()
        .position(|entry| entry == "subagent_updated:stopped")
        .unwrap_or_else(|| panic!("no stopped push in {seen:?}"));
    let ended = seen
        .iter()
        .position(|entry| entry == "ended:stream_closed")
        .unwrap_or_else(|| panic!("no end in {seen:?}"));
    assert!(stopped < ended, "{seen:?}");
    let run = repository::load(&app_state.write_pool, session_id, "toolu_1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, SubagentRunStatus::Stopped);
}

/// A foreground sub-agent launched and then the turn ended with `result`.
async fn settled_by_turn_end(session_id: i64, result: RuntimeEvent) -> (String, String) {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    insert_running_session(&app_state, session_id, 1).await;

    let (msg_tx, msg_rx) = mpsc::channel(2);
    msg_tx.send(Ok(launch("toolu_fg", false))).await.unwrap();
    msg_tx.send(Ok(result)).await.unwrap();
    drop(msg_tx);
    spawn_test_stream_reader(
        &app_state,
        session_id,
        1,
        msg_rx,
        ws_tx,
        sdk_sessions,
        DEFAULT_PROVIDER,
    );
    drain(&mut ws_rx).await;
    run_state(&app_state, session_id, "toolu_fg").await
}

#[tokio::test]
async fn a_completed_turn_completes_its_foreground_sub_agents() {
    assert_eq!(
        settled_by_turn_end(704, result_event()).await,
        ("completed".into(), String::new())
    );
}

#[tokio::test]
async fn a_failed_turn_stops_its_foreground_sub_agents() {
    let failed = result_event().with_result_error(Some(
        crate::domain::agents::adapter::RuntimeResultError {
            code: "ERROR_DURING_EXECUTION".into(),
            message: "boom".into(),
        },
    ));
    assert_eq!(
        settled_by_turn_end(705, failed).await,
        ("stopped".into(), "turn_failed".into())
    );
}
