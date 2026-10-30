use crate::domain::ws_session::runtime::output::OutputTarget;
use sqlx::SqlitePool;

use crate::domain::session_status::SessionStatusBroadcaster;
use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::super::send_error;

pub(in crate::domain::ws_session) async fn persist_pause_and_send_session_error(
    pool: &SqlitePool,
    session_status_tx: &SessionStatusBroadcaster,
    sender: &impl OutputTarget,
    ref_id: &str,
    feature_id: i64,
    session_id: i64,
    code: &'static str,
    message: &str,
) {
    WsSessionPersistence::persist_error_message_static(pool, session_id, message, None).await;
    WsSessionPersistence::mark_paused_static(pool, session_id).await;
    session_status_tx.broadcast_turn_failed(session_id, feature_id);
    send_error(sender, ref_id, code, message);
}
