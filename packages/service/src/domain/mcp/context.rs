use sqlx::SqlitePool;
use std::sync::Arc;

/// Shared context injected into all MCP tool handlers. The `feature_id` is
/// pinned at subprocess spawn time (1:1 subprocess ↔ feature, see
/// `mcp_spawn.rs`) so tools can access it via plain field reads without
/// depending on task-local propagation — `rmcp`'s internal request dispatch
/// sometimes runs handlers on freshly-spawned tokio tasks that don't inherit
/// a task-local scope, so the earlier scope-based approach was unreliable.
pub struct McpContext {
    // Reserved for the future `cadencr-workspace` MCP server's conversation
    // read tools.
    #[allow(dead_code)]
    pub read_pool: SqlitePool,
    #[allow(dead_code)]
    pub write_pool: SqlitePool,
    pub feature_id: i64,
    pub source_session_id: Option<i64>,
}

impl McpContext {
    pub fn new(read_pool: SqlitePool, write_pool: SqlitePool, feature_id: i64) -> Arc<Self> {
        Self::new_with_source_session(read_pool, write_pool, feature_id, None)
    }

    pub fn new_with_source_session(
        read_pool: SqlitePool,
        write_pool: SqlitePool,
        feature_id: i64,
        source_session_id: Option<i64>,
    ) -> Arc<Self> {
        Arc::new(Self {
            read_pool,
            write_pool,
            feature_id,
            source_session_id,
        })
    }

    // Reserved for future MCP tools that should read the pinned feature id via
    // an accessor instead of direct field access.
    #[allow(dead_code)]
    pub fn feature_id(&self) -> i64 {
        self.feature_id
    }
}
