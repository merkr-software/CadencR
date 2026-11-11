#![allow(dead_code)]

// Disabled in `cadencr-browser`; reserved for the future `cadencr-workspace`
// MCP server.

use std::sync::Arc;

use crate::domain::mcp::McpContext;

pub struct ListConversationsTool {
    pub ctx: Arc<McpContext>,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: i64,
    agent_type: String,
    status: String,
    started_at: String,
}

impl ListConversationsTool {
    pub fn new(ctx: Arc<McpContext>) -> Self {
        Self { ctx }
    }

    pub async fn call(&self) -> Result<String, String> {
        let rows: Vec<SessionRow> = sqlx::query_as(
            "SELECT id, agent_type, status, started_at FROM agent_sessions WHERE feature_id = ? ORDER BY started_at DESC"
        )
        .bind(self.ctx.feature_id)
        .fetch_all(&self.ctx.read_pool)
        .await
        .map_err(|e| format!("Failed to list conversations: {e}"))?;

        if rows.is_empty() {
            return Ok("No conversations found.".to_string());
        }

        let mut out = String::from("| ID | Agent Type | Status | Started At |\n|-----|------------|--------|------------|\n");
        for r in &rows {
            out.push_str(&format!(
                "| {} | {} | {} | {} |\n",
                r.id, r.agent_type, r.status, r.started_at,
            ));
        }

        Ok(out)
    }
}
