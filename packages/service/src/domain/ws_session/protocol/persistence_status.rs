use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Transcript durability is independent of provider-stream and turn health.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PersistenceStatusState {
    Degraded,
    Recovered,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionPersistenceStatusPayload {
    pub status: PersistenceStatusState,
    pub message: String,
}
