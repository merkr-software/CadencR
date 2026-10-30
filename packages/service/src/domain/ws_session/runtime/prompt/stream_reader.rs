use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeMessageRx, RuntimeSessionWeakHandle};
use crate::domain::session_status::SessionStatusBroadcaster;
use crate::domain::ws_session::runtime::output::SessionOutput;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::super::SdkSessions;
use super::stream_reader_task::StreamReaderTask;

/// Spawn a background task that forwards runtime messages to the WebSocket client.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_stream_reader(
    db_session_id: i64,
    feature_id: i64,
    message_rx: RuntimeMessageRx,
    runtime_session_handle: Option<RuntimeSessionWeakHandle>,
    sender: SessionOutput,
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
    let shutdown_runtime = runtime_session_handle.clone();
    let task = StreamReaderTask {
        db_session_id,
        feature_id,
        persistence_reader_id: app_state.persistence_health.reader_id(),
        message_rx,
        runtime_session_handle,
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
    crate::domain::ws_session::stream_readers::spawn(db_session_id, shutdown_runtime, async move {
        task.run().await;
    });
}
