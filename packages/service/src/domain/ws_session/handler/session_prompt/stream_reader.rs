use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeMessageRx;
use crate::domain::session_status::SessionStatusBroadcaster;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::super::{SdkSessions, WsSender};
use super::stream_reader_task::StreamReaderTask;

/// Spawn a background task that forwards runtime messages to the WebSocket client.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_stream_reader(
    db_session_id: i64,
    feature_id: i64,
    message_rx: RuntimeMessageRx,
    sender: WsSender,
    feature_senders: WsFeatureSenderRegistry,
    write_pool: sqlx::SqlitePool,
    session_status_tx: SessionStatusBroadcaster,
    sdk_sessions: SdkSessions,
    runtime_provider: String,
    _model: Option<&str>,
    provider_context_window: Option<u64>,
    app_state: AppState,
    cleanup_session_on_end: bool,
) {
    let task = StreamReaderTask {
        db_session_id,
        feature_id,
        message_rx,
        sender,
        feature_senders,
        write_pool,
        session_status_tx,
        sdk_sessions,
        runtime_provider,
        provider_context_window,
        app_state,
        cleanup_session_on_end,
    };
    tokio::spawn(async move {
        task.run().await;
    });
}
