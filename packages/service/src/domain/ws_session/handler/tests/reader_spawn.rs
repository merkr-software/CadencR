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
    session_prompt::spawn_stream_reader(
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        app_state.ws_feature_senders.clone(),
        app_state.write_pool.clone(),
        app_state.session_status_tx.clone(),
        sdk_sessions,
        runtime_provider.to_string(),
        None,
        None,
        app_state.clone(),
        false,
    );
}
