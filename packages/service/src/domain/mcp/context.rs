use sqlx::SqlitePool;

use super::control_client::McpControlClient;

/// Why a context built without `.control(...)` cannot reach the service.
/// `mcp-serve` always sets it, from its environment (see `stdio.rs`).
const NO_CONTROL_CHANNEL: &str =
    "this Cadencr MCP server has no control channel to the Cadencr service";

/// Shared context injected into all MCP tool handlers. The `feature_id` is
/// pinned at subprocess spawn time (1:1 subprocess ↔ feature, see
/// `mcp_spawn.rs`) so tools can access it via plain field reads without
/// depending on task-local propagation — `rmcp`'s internal request dispatch
/// sometimes runs handlers on freshly-spawned tokio tasks that don't inherit
/// a task-local scope, so the earlier scope-based approach was unreliable.
///
/// The subprocess only reads the database (`read_pool` is read-only): every
/// write goes through the service over `control`, so the service stays the
/// one writer and broadcasts each change to connected clients.
#[derive(bon::Builder)]
pub struct McpContext {
    pub read_pool: SqlitePool,
    pub feature_id: i64,
    pub source_session_id: Option<i64>,
    /// The client for the service's `/internal/mcp/*` routes, or why this
    /// subprocess has none (its control env is missing or invalid).
    #[builder(default = Err(NO_CONTROL_CHANNEL.to_string()))]
    control: Result<McpControlClient, String>,
}

impl McpContext {
    /// The service's control routes, or a clear error when this subprocess
    /// cannot reach them: a tool that changes state never falls back to
    /// writing the database itself, and a read is not served unaudited.
    pub fn control(&self) -> Result<&McpControlClient, String> {
        self.control.as_ref().map_err(|reason| {
            format!(
                "Cannot reach the Cadencr service, so this call could not be completed: {reason}"
            )
        })
    }
}
