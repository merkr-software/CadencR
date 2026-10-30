use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionAcknowledgedPayload {
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionCompactingPayload {
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionDeletedPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionClearedPayload {
    pub session_id: String,
    pub previous_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionMcpServersPayload {
    pub mcp_servers: Vec<McpServerStatusPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct McpServerStatusPayload {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HistoryResultPayload {
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HistoryAddedPayload {
    pub added: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DraftResultPayload {
    pub draft: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DraftSavedPayload {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BranchNeedsConfirmPayload {
    pub session_id: String,
    pub message_id: i64,
    pub kind: String,
    pub reason: String,
}

/// `compact.started` has always carried JSON null rather than an empty object.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SessionCompactStartedPayload;

impl utoipa::PartialSchema for SessionCompactStartedPayload {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        utoipa::openapi::schema::ObjectBuilder::new()
            .schema_type(utoipa::openapi::schema::Type::Null)
            .into()
    }
}

impl ToSchema for SessionCompactStartedPayload {}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RetryWorktreeSetupOkPayload {
    pub feature_id: i64,
}
