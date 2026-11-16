//! Single home for the stream-reader spawn helper shared by the
//! `stream_reader*` dispatch-layer tests, so the 13-argument
//! `spawn_stream_reader` call is written exactly once.

use super::support::*;

/// Spawn the real stream reader against an in-memory app state. `runtime_provider`
/// selects the adapter (e.g. [`DEFAULT_PROVIDER`](crate::domain::agents::runtime::DEFAULT_PROVIDER)
/// or `"claude_code"`).
pub(super) fn spawn_test_stream_reader(
    app_state: &AppState,
    db_session_id: i64,
    feature_id: i64,
    msg_rx: RuntimeMessageRx,
    ws_tx: WsSender,
    sdk_sessions: SdkSessions,
    runtime_provider: &str,
) {
    spawn_test_stream_reader_with_cleanup()
        .app_state(app_state)
        .db_session_id(db_session_id)
        .feature_id(feature_id)
        .msg_rx(msg_rx)
        .ws_tx(ws_tx)
        .sdk_sessions(sdk_sessions)
        .runtime_provider(runtime_provider)
        .cleanup_session_on_end(false)
        .call();
}

#[bon::builder]
pub(super) fn spawn_test_stream_reader_with_cleanup(
    app_state: &AppState,
    db_session_id: i64,
    feature_id: i64,
    msg_rx: RuntimeMessageRx,
    ws_tx: WsSender,
    sdk_sessions: SdkSessions,
    runtime_provider: &str,
    cleanup_session_on_end: bool,
) {
    let runtime_session_handle = {
        let sessions = sdk_sessions
            .try_lock()
            .expect("test stream reader spawn must not hold the session-map lock");
        sessions
            .get(&db_session_id)
            .and_then(|handle| match &handle.state {
                QueryState::Active { query, .. } => Some(Some(Arc::downgrade(query))),
                QueryState::Pending(_) => None,
            })
            .unwrap_or(None)
    };
    spawn_test_stream_reader_for_runtime()
        .app_state(app_state)
        .db_session_id(db_session_id)
        .feature_id(feature_id)
        .msg_rx(msg_rx)
        .maybe_runtime_session_handle(runtime_session_handle)
        .ws_tx(ws_tx)
        .sdk_sessions(sdk_sessions)
        .runtime_provider(runtime_provider)
        .cleanup_session_on_end(cleanup_session_on_end)
        .call();
}

#[bon::builder]
pub(super) fn spawn_test_stream_reader_for_runtime(
    app_state: &AppState,
    db_session_id: i64,
    feature_id: i64,
    msg_rx: RuntimeMessageRx,
    runtime_session_handle: Option<RuntimeSessionWeakHandle>,
    ws_tx: WsSender,
    sdk_sessions: SdkSessions,
    runtime_provider: &str,
    cleanup_session_on_end: bool,
) {
    session_prompt::spawn_stream_reader()
        .db_session_id(db_session_id)
        .feature_id(feature_id)
        .message_rx(msg_rx)
        .maybe_runtime_session_handle(runtime_session_handle)
        .sender(ws_tx.into())
        .feature_senders(app_state.ws_feature_senders.clone())
        .write_pool(app_state.write_pool.clone())
        .session_status_tx(app_state.session_status_tx.clone())
        .sdk_sessions(sdk_sessions)
        .runtime_provider(runtime_provider.to_string())
        .app_state(app_state.clone())
        .cleanup_session_on_end(cleanup_session_on_end)
        .call();
}
