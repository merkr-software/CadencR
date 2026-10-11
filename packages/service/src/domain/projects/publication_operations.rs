//! Durable, content-bound publication operations. Disconnects do not cancel work.
mod identity;
mod journal;
pub(crate) mod routes;
mod runner;

use super::publication_release::{registry::PublicationRegistryResult, PublishedProviderRelease};
pub use identity::operation_id;
pub use routes::router;
pub use runner::execute;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationOperationKind {
    Release,
    Registry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationOperationStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum PublicationOperationResult {
    Release(PublishedProviderRelease),
    Registry(PublicationRegistryResult),
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublicationOperation {
    pub operation_id: String,
    pub project_id: i64,
    pub kind: PublicationOperationKind,
    pub plan_sha256: String,
    pub status: PublicationOperationStatus,
    pub attempt: u64,
    pub created_at: String,
    pub updated_at: String,
    pub result: Option<PublicationOperationResult>,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PublicationOperationsPage {
    pub operations: Vec<PublicationOperation>,
    pub next_cursor: Option<String>,
}
