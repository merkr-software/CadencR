//! End-to-end coverage for deferred teardown under a background task: once the
//! owner socket is gone (a viewer evicted after 5 minutes, a sleeping phone),
//! an idle runtime is closed — but never while a `run_in_background` task still
//! has to report back or a scheduled wake-up is pending, or the work dies and
//! the provider's auto-resume never happens. Exercises the real stream reader
//! + DB.

use std::time::Duration;

use super::support::*;

use crate::domain::agents::adapter::{RuntimeEventMetadata, ScheduledWakeup};
use crate::domain::agents::runtime::DEFAULT_PROVIDER;

fn background_snapshot(live: usize) -> RuntimeEvent {
    RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
        .with_background_task_count(Some(live))
}

async fn runtime_is_active(sdk_sessions: &SdkSessions, db_session_id: i64) -> bool {
    sdk_sessions
        .lock()
        .await
        .get(&db_session_id)
        .is_some_and(|handle| matches!(handle.state, QueryState::Active { .. }))
}

/// Run a turn whose owner socket is already gone, with the runtime stream left
/// open (the CLI is still alive between turns). Returns the sender so the
/// stream stays open for the duration of the test.
async fn orphaned_turn(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    events: Vec<RuntimeEvent>,
) -> mpsc::Sender<Result<RuntimeEvent, RuntimeError>> {
    let feature_id = 1i64;
    insert_running_session(app_state, db_session_id, feature_id).await;
    sdk_sessions
        .lock()
        .await
        .insert(db_session_id, make_active_handle(feature_id, None));
    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(8);
    for event in events {
        msg_tx.send(Ok(event)).await.unwrap();
    }
    let (ws_tx, ws_rx) = mpsc::unbounded_channel();
    drop(ws_rx);
    spawn_test_stream_reader(
        app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions.clone(),
        DEFAULT_PROVIDER,
    );
    msg_tx
}

#[tokio::test]
async fn orphaned_idle_runtime_is_closed_as_completed() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let db_session_id = 591i64;
    let _msg_tx = orphaned_turn(
        &app_state,
        &sdk_sessions,
        db_session_id,
        vec![result_event()],
    )
    .await;

    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert!(
        !runtime_is_active(&sdk_sessions, db_session_id).await,
        "an idle runtime with no owner and no background work must be closed"
    );
    assert_eq!(
        db_status(&app_state, db_session_id).await,
        "completed",
        "a torn-down idle runtime must not restore as a paused turn"
    );
}

#[tokio::test]
async fn orphaned_runtime_stays_alive_while_a_background_task_runs() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let db_session_id = 592i64;
    // A `run_in_background` command starts, then the launching turn ends.
    let _msg_tx = orphaned_turn(
        &app_state,
        &sdk_sessions,
        db_session_id,
        vec![background_snapshot(1), result_event()],
    )
    .await;

    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert!(
        runtime_is_active(&sdk_sessions, db_session_id).await,
        "closing the runtime would kill the background task and its auto-resume"
    );
}

#[tokio::test]
async fn orphaned_runtime_stays_alive_until_a_scheduled_wakeup_fires() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let db_session_id = 593i64;
    // The agent schedules a wake-up (the timer lives in the CLI), then ends.
    let wakeup = RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
        .with_scheduled_wakeup(Some(ScheduledWakeup::Scheduled {
            tool_use_id: "toolu_wake".into(),
            due_in: Duration::from_secs(120),
        }));
    let _msg_tx = orphaned_turn(
        &app_state,
        &sdk_sessions,
        db_session_id,
        vec![wakeup, result_event()],
    )
    .await;

    tokio::time::sleep(Duration::from_millis(1500)).await;

    assert!(
        runtime_is_active(&sdk_sessions, db_session_id).await,
        "closing the runtime would drop the wake-up and the agent never resumes"
    );
}

#[tokio::test]
async fn enabling_claude_bypass_waits_for_background_work_instead_of_killing_it() {
    let app_state = make_test_app_state().await;
    crate::domain::workspace::repository::set_setting(
        &app_state.write_pool,
        "claude_bypass_permissions_enabled",
        "true",
    )
    .await
    .unwrap();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let db_session_id = 594i64;
    // A live Claude runtime spawned without bypass runs a background command.
    let _msg_tx = orphaned_turn(
        &app_state,
        &sdk_sessions,
        db_session_id,
        vec![background_snapshot(1), result_event()],
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    let envelope = make_envelope(
        "session",
        "mode.set",
        serde_json::json!({ "session_id": db_session_id.to_string(), "mode": "bypassPermissions" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let mut actions = Vec::new();
    while let Ok(Message::Text(text)) = rx.try_recv() {
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        let code = env
            .payload
            .get("code")
            .and_then(|c| c.as_str())
            .map(String::from);
        actions.push((env.action, code));
    }
    assert!(
        actions.contains(&("mode.changed".to_string(), None)),
        "{actions:?}"
    );
    assert!(
        actions.contains(&(
            "error".to_string(),
            Some("RUNTIME_CHANGE_DEFERRED".to_string())
        )),
        "the user is told the mode waits: {actions:?}"
    );
    assert!(
        runtime_is_active(&sdk_sessions, db_session_id).await,
        "re-arming bypass now would close the runtime and kill the command"
    );
    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_session_id).unwrap();
    assert_eq!(
        handle.desired_permission_mode,
        Some(RuntimePermissionMode::BypassPermissions)
    );
    assert!(
        !handle.config.allow_bypass_permissions,
        "bypass is armed only by the respawn, once the runtime is free"
    );
}
