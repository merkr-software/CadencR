//! The audit row of an orchestration read tool. The tool reads the database
//! itself (read-only), then asks the service to record the call: the service
//! is the only writer, and it resolves the projects the row names from its own
//! data instead of trusting the subprocess.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::context::McpContext;
use super::control::audit::{elapsed_ms, result_size_bytes};
use super::control_grant::McpControlServer;
use super::tools::project_control::require_source_session;

const PROJECT_READ_TOOLS: &[&str] = &[
    "project_list_sessions",
    "project_read_session",
    "project_get_session_status",
    "project_find_related_sessions",
    "project_read_session_tail",
    "project_get_worktree_status",
    "project_compare_sessions",
    "project_list_agent_providers",
    "project_list_schedules",
];

const WORKSPACE_READ_TOOLS: &[&str] = &[
    "workspace_list_projects",
    "workspace_read_session",
    "workspace_read_sessions",
    "workspace_session_graph",
    "workspace_recent_activity",
];

/// Whether `tool` is one of `server`'s read tools, audited once it ran.
pub(crate) fn is_read_tool(server: McpControlServer, tool: &str) -> bool {
    match server {
        McpControlServer::Project => PROJECT_READ_TOOLS,
        McpControlServer::Workspace => WORKSPACE_READ_TOOLS,
    }
    .contains(&tool)
}

pub(crate) fn endpoint(server: McpControlServer) -> &'static str {
    match server {
        McpControlServer::Project => "/internal/mcp/project/read-audit",
        McpControlServer::Workspace => "/internal/mcp/workspace/read-audit",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReadAuditStatus {
    Ok,
    Error,
}

impl ReadAuditStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
        }
    }
}

/// One read tool call, as the subprocess reports it.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ReadAuditRequest {
    pub source_feature_id: i64,
    pub source_session_id: i64,
    pub tool_name: String,
    pub target_session_id: Option<i64>,
    pub status: ReadAuditStatus,
    pub result_size_bytes: i64,
    pub latency_ms: i64,
    pub error: Option<String>,
}

/// `result` once the service recorded the call. A call that cannot be
/// recorded fails, as it did when the subprocess wrote the row itself; when the
/// read failed too, the agent gets both errors.
pub(crate) async fn audited(
    server: McpControlServer,
    tool_name: &str,
    args: &Value,
    ctx: &McpContext,
    result: Result<Value, String>,
    started_at: Instant,
) -> Result<Value, String> {
    let recorded = record(server, tool_name, args, ctx, &result, started_at).await;
    match (result, recorded) {
        (result, Ok(())) => result,
        (Ok(_), Err(audit)) => Err(audit),
        (Err(error), Err(audit)) => Err(format!("{error}\n{audit}")),
    }
}

async fn record(
    server: McpControlServer,
    tool_name: &str,
    args: &Value,
    ctx: &McpContext,
    result: &Result<Value, String>,
    started_at: Instant,
) -> Result<(), String> {
    let source_session_id = require_source_session(ctx, tool_name)?;
    let (status, result_size_bytes, error) = match result {
        Ok(value) => (ReadAuditStatus::Ok, result_size_bytes(value), None),
        Err(error) => (ReadAuditStatus::Error, 0, Some(error.clone())),
    };
    let request = ReadAuditRequest {
        source_feature_id: ctx.feature_id,
        source_session_id,
        tool_name: tool_name.to_string(),
        target_session_id: target_session_id(args),
        status,
        result_size_bytes,
        latency_ms: elapsed_ms(started_at),
        error,
    };
    let body = serde_json::to_value(request)
        .map_err(|e| format!("Failed to encode MCP tool audit: {e}"))?;
    ctx.control()?
        .post_json_quick(endpoint(server), body)
        .await
        .map(|_| ())
        .map_err(|error| {
            // Unreachable: the read is withheld, which is what the agent needs
            // to know, not that an audit row is missing.
            if error.is_unreachable() {
                error.into()
            } else {
                format!("Failed to record MCP tool audit: {error}")
            }
        })
}

fn target_session_id(args: &Value) -> Option<i64> {
    args.get("session_id")
        .or_else(|| args.get("target_session_id"))
        .and_then(Value::as_i64)
}

#[cfg(test)]
mod tests {
    use super::{is_read_tool, McpControlServer};

    #[test]
    fn each_server_audits_only_its_own_read_tools() {
        assert!(is_read_tool(
            McpControlServer::Project,
            "project_read_session"
        ));
        assert!(is_read_tool(
            McpControlServer::Workspace,
            "workspace_list_projects"
        ));
        for (server, tool) in [
            (McpControlServer::Workspace, "project_read_session"),
            (McpControlServer::Project, "workspace_list_projects"),
            // Writes are audited by the service route that performs them.
            (McpControlServer::Project, "project_link_sessions"),
            (McpControlServer::Project, "project_spawn_session"),
        ] {
            assert!(!is_read_tool(server, tool), "{tool}");
        }
    }
}
