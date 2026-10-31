use sqlx::SqlitePool;

use super::super::turns::ActiveTurnRegistry;
use crate::domain::feature_events::FeatureEventBroadcaster;
use crate::domain::gate_registry::GateRegistry;
use crate::domain::session_status::SessionStatusBroadcaster;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

/// Capabilities used by a permission response, supplied by its transport boundary.
/// The borrowed handles preserve the live registries and their runtime identity.
#[derive(bon::Builder)]
pub(crate) struct PermissionContext<'a> {
    pub(super) read_pool: &'a SqlitePool,
    pub(super) write_pool: &'a SqlitePool,
    pub(super) pending_gates: &'a GateRegistry,
    pub(super) active_turns: &'a ActiveTurnRegistry,
    pub(super) session_status: &'a SessionStatusBroadcaster,
    pub(super) feature_senders: &'a WsFeatureSenderRegistry,
    pub(super) feature_events: &'a FeatureEventBroadcaster,
}

impl PermissionContext<'_> {
    pub(super) fn answer_messages(&self) -> PermissionMessageContext<'_> {
        PermissionMessageContext {
            pool: self.write_pool,
            feature_senders: self.feature_senders,
            feature_events: self.feature_events,
        }
    }
}

/// Persistence and delivery needed only when a permission response contains an answer.
pub(super) struct PermissionMessageContext<'a> {
    pub(super) pool: &'a SqlitePool,
    pub(super) feature_senders: &'a WsFeatureSenderRegistry,
    pub(super) feature_events: &'a FeatureEventBroadcaster,
}
