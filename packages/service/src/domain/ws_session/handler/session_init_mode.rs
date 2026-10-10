use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimePermissionMode;
use crate::domain::agents::permission_modes::{
    permission_mode_wire, supported_or_default_permission_mode,
};
use crate::domain::ws_session::persistence::WsSessionPersistence;

/// The permission mode a session starts with, plus its wire form for the
/// `initialized` reply.
///
/// The frontend seeds every new conversation with the default provider's mode
/// (Claude's `auto`), even one that starts on Codex or Cursor. A mode the
/// provider can't run becomes the provider default, and that correction is
/// persisted and reported: otherwise the client replays its stale mode right
/// after init and the provider rejects it with a `MODE_NOT_SUPPORTED` toast.
pub(super) async fn resolve(
    app_state: &AppState,
    db_session_id: i64,
    provider: &str,
    requested: Option<&str>,
) -> (Option<RuntimePermissionMode>, Option<String>) {
    let mode = supported_or_default_permission_mode(provider, requested);
    let wire = mode.as_ref().map(permission_mode_wire);
    if let (Some(requested), Some(wire)) = (requested, wire.as_deref()) {
        if requested != wire {
            // `find_or_create_session` already stored the requested mode.
            WsSessionPersistence::update_permission_mode_static(
                &app_state.write_pool,
                db_session_id,
                wire,
            )
            .await;
        }
    }
    (mode, wire)
}
