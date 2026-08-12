use super::adapter_normalize::normalize_edit_input;
use super::events_subagent_synthesis::{extract_subagent_body, synthesize_subagent_text_event};
use super::events_tool_call_question::{question_start_event, question_update_event};
use super::mcp_status::merge_configured_mcp_servers;
use super::permission_reply::route_subagent_permission_reply;
use super::prompt_usage::prompt_response_usage;
use super::question_sidecar::QuestionSidecar;
use super::tool_result_flatten::flatten_tool_result_content;
use super::upstream_workaround::{
    spawn_side_channel_listeners, PendingSubagentState, PendingSubagentTasks, PermissionRegistry,
};
use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
use crate::domain::agents::acp::runtime::provider_hooks::{
    AcpProviderHooks, PermissionFallbackOutcome,
};
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventMetadata, RuntimeMcpServerStatus,
    RuntimePermissionDecision, RuntimePermissionMode, RuntimePermissionResponse,
    RuntimeSlashCommand, RuntimeUsage,
};
use crate::domain::agents::mcp_tool_names::McpToolNameResolver;
use crate::domain::agents::opencode::questions::extract_question_answers;
use crate::domain::agents::opencode::tool_names::{
    canonical_acp_tool_name, canonical_cadencr_tool_name,
};
use async_trait::async_trait;
use opencode_sdk_rs::OpenCodeClient;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
pub struct OpenCodeAcpAdapter {
    question_sidecar: QuestionSidecar,
    /// Shared HTTP client (pooled) reused by sidecar + permission reply.
    http: OpenCodeClient,
    /// `directory` scope for workspace-routed calls; upstream's
    /// `WorkspaceRoutingMiddleware` uses it to keep list/reply on the same map.
    cwd: String,
    pending_subagent_calls: PendingSubagentTasks,
    permissions: PermissionRegistry,
    mcp_tool_names: McpToolNameResolver,
}
impl OpenCodeAcpAdapter {
    pub fn new(question_sidecar: QuestionSidecar, opencode_http_port: u16, cwd: &Path) -> Self {
        Self {
            question_sidecar,
            http: OpenCodeClient::new(opencode_http_port),
            cwd: cwd.to_string_lossy().into_owned(),
            pending_subagent_calls: Arc::new(StdMutex::new(PendingSubagentState::default())),
            permissions: Arc::new(RwLock::new(HashMap::new())),
            mcp_tool_names: McpToolNameResolver::default(),
        }
    }
}
#[async_trait]
impl AcpProviderHooks for OpenCodeAcpAdapter {
    async fn run_user_shell_command(
        &self,
        session_id: &str,
        agent: &str,
        command: &str,
    ) -> Result<(), RuntimeError> {
        self.http
            .shell_command()
            .session_id(session_id)
            .agent(agent)
            .command(command)
            .directory(&self.cwd)
            .call()
            .await
            .map(|_| ())
            .map_err(|error| RuntimeError::new(format!("OpenCode shell command failed: {error}")))
    }

    fn normalize_tool_name(&self, raw: &str) -> String {
        let canonical = canonical_cadencr_tool_name(&canonical_acp_tool_name(raw));
        self.mcp_tool_names
            .canonical_name(&canonical)
            .unwrap_or(canonical)
    }
    fn normalize_tool_input(&self, tool_name: &str, input: Value) -> Value {
        normalize_edit_input(tool_name, input)
    }
    fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
        flatten_tool_result_content(blocks)
    }
    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String> {
        Some(match mode {
            RuntimePermissionMode::Plan => "plan".to_string(),
            RuntimePermissionMode::OpenCodeAgent(name) => name,
            _ => "build".to_string(),
        })
    }
    fn model_config_id(&self) -> Option<&str> {
        Some("model")
    }
    fn thinking_effort_config_id(&self) -> Option<String> {
        Some("effort".to_string())
    }
    fn default_mode_id(&self) -> Option<&'static str> {
        Some("build")
    }
    fn compact_prompt(&self) -> Option<&'static str> {
        Some("/compact")
    }
    fn prompt_response_usage(&self, response: &Value) -> Option<RuntimeUsage> {
        prompt_response_usage(response)
    }
    async fn available_mcp_servers(
        &self,
        cwd: &Path,
        configured: Vec<RuntimeMcpServerStatus>,
    ) -> Vec<RuntimeMcpServerStatus> {
        let servers = match opencode_sdk_rs::list_mcp_servers_from_cli(Some(cwd)).await {
            Ok(servers) if !servers.is_empty() => merge_configured_mcp_servers(
                servers
                    .into_iter()
                    .map(|server| RuntimeMcpServerStatus {
                        name: server.name,
                        status: server.status,
                    })
                    .collect(),
                configured,
            ),
            Ok(_) => configured,
            Err(error) => {
                tracing::warn!(%error, "failed to read OpenCode MCP server statuses");
                configured
            }
        };
        self.mcp_tool_names.remember(&servers);
        servers
    }
    fn supports_durable_resume(&self) -> bool {
        true
    }
    fn tool_call_start_override(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        tool_input: &Value,
        metadata: &RuntimeEventMetadata,
        parent_tool_use_id: Option<&str>,
        indexer: &mut EventIndexer,
    ) -> Option<RuntimeEvent> {
        if tool_name != "AskUserQuestion" {
            return None;
        }
        question_start_event(
            tool_call_id,
            tool_input.clone(),
            metadata.clone(),
            parent_tool_use_id.map(ToOwned::to_owned),
            indexer,
        )
    }
    fn tool_call_update_override(
        &self,
        tool_call_id: &str,
        body: &Value,
        status: &str,
        metadata: &RuntimeEventMetadata,
        parent_tool_use_id: Option<&str>,
        indexer: &mut EventIndexer,
    ) -> Option<RuntimeEvent> {
        question_update_event(
            tool_call_id,
            body,
            status,
            metadata.clone(),
            parent_tool_use_id.map(ToOwned::to_owned),
            indexer,
        )
    }
    fn suppresses_raw_output(&self, tool_name: &str) -> bool {
        matches!(tool_name, "Task" | "Agent")
    }
    fn synthesize_tool_call_completion(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        body: &Value,
        _status: &str,
        metadata: &RuntimeEventMetadata,
        _indexer: &mut EventIndexer,
    ) -> Vec<RuntimeEvent> {
        if !matches!(tool_name, "Task" | "Agent") {
            return Vec::new();
        }
        let Some(body_text) = extract_subagent_body(body) else {
            return Vec::new();
        };
        vec![synthesize_subagent_text_event(
            metadata,
            tool_call_id,
            &body_text,
        )]
    }
    fn record_tool_call_start(&self, tool_call_id: &str, tool_name: &str) {
        if matches!(tool_name, "Task" | "Agent") {
            if let Ok(mut pending) = self.pending_subagent_calls.lock() {
                pending.push_tool_call(tool_call_id.to_string());
            }
        }
    }

    fn observe_tool_call_update(&self, tool_call_id: &str, tool_name: &str, body: &Value) {
        if !(tool_name.eq_ignore_ascii_case("task") || tool_name.eq_ignore_ascii_case("agent")) {
            return;
        }
        let Some(child_session_id) = child_session_id_from_task_body(body) else {
            return;
        };
        if let Ok(mut pending) = self.pending_subagent_calls.lock() {
            pending.bind_child_session(child_session_id, tool_call_id);
        }
    }
    fn start_side_channel(
        &self,
        session_id: &str,
        cwd: &Path,
        context_window: Option<u64>,
        tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    ) -> Option<JoinHandle<()>> {
        Some(spawn_side_channel_listeners(
            self.http.clone(),
            cwd.to_path_buf(),
            session_id.to_string(),
            context_window,
            Arc::clone(&self.pending_subagent_calls),
            Arc::clone(&self.permissions),
            tx,
        ))
    }
    async fn record_available_commands(&self, cwd: &Path, commands: Vec<RuntimeSlashCommand>) {
        let cwd = cwd.to_string_lossy().into_owned();
        crate::domain::agents::opencode::commands::record_snapshot(&cwd, commands).await;
    }
    async fn respond_permission_fallback(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<PermissionFallbackOutcome, RuntimeError> {
        // 1. Polled sub-agent permission? POSTs to OpenCode REST and
        //    returns a cache key so the runtime records the decision.
        if let Some(outcome) =
            route_subagent_permission_reply(&self.http, &self.cwd, &self.permissions, &response)
                .await?
        {
            return Ok(outcome);
        }

        // 2. AskUserQuestion (denial path).
        if matches!(response.decision, RuntimePermissionDecision::Deny) {
            self.question_sidecar
                .reject_tool_call(&response.request_id)
                .await?;
            return Ok(PermissionFallbackOutcome::Handled);
        }
        // 3. AskUserQuestion (answer path).
        if response.updated_input.is_none() && response.feedback.is_none() {
            return Ok(PermissionFallbackOutcome::NotHandled);
        }
        let answers = extract_question_answers(
            response.updated_input.as_ref(),
            response.feedback.as_deref(),
        );
        if answers.iter().all(Vec::is_empty) {
            return Ok(PermissionFallbackOutcome::NotHandled);
        }
        self.question_sidecar
            .reply_tool_call(&response.request_id, answers)
            .await?;
        Ok(PermissionFallbackOutcome::Handled)
    }
}

/// Child session id carried on OpenCode Task tool updates/completions.
fn child_session_id_from_task_body(body: &Value) -> Option<&str> {
    body.get("rawInput")
        .or_else(|| body.get("toolInput"))
        .and_then(|input| {
            input
                .get("task_id")
                .or_else(|| input.get("sessionId"))
                .or_else(|| input.get("session_id"))
        })
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .or_else(|| {
            body.get("rawOutput")
                .and_then(|output| output.get("metadata"))
                .and_then(|metadata| metadata.get("sessionId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        })
}

#[cfg(test)]
mod tests {
    use super::OpenCodeAcpAdapter;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::adapter::{
        RuntimeContentBlock, RuntimeEventMetadata, RuntimeMcpServerStatus,
    };
    use serde_json::json;
    fn metadata() -> RuntimeEventMetadata {
        RuntimeEventMetadata {
            raw: json!({}),
            ..RuntimeEventMetadata::default()
        }
    }
    fn adapter() -> OpenCodeAcpAdapter {
        OpenCodeAcpAdapter::new(
            super::QuestionSidecar::new(0, std::path::Path::new("/tmp")),
            0,
            std::path::Path::new("/tmp"),
        )
    }
    #[test]
    fn adapter_normalizes_lowercase_acp_tool_names() {
        let adapter = adapter();
        assert!(adapter.supports_durable_resume());
        assert_eq!(adapter.normalize_tool_name("write"), "Write");
        assert_eq!(adapter.normalize_tool_name("question"), "AskUserQuestion");
        adapter.mcp_tool_names.remember(&[RuntimeMcpServerStatus {
            name: "chrome-devtools".to_string(),
            status: "connected".to_string(),
        }]);
        assert_eq!(
            adapter.normalize_tool_name("chrome-devtools_take_screenshot"),
            "mcp__chrome-devtools__take_screenshot"
        );
        assert_eq!(
            adapter.normalize_tool_name("cadencr-browser_browser_open_url"),
            "mcp__cadencr-browser__browser_open_url"
        );
    }

    #[test]
    fn adapter_normalize_tool_input_renames_edit_keys() {
        let adapter = adapter();
        let value = adapter.normalize_tool_input(
            "Edit",
            json!({ "path": "/x", "oldText": "a", "newText": "b" }),
        );
        assert_eq!(value["file_path"], "/x");
        assert_eq!(value["old_string"], "a");
        assert_eq!(value["new_string"], "b");
    }
    #[test]
    fn tool_call_start_override_swallows_empty_question_payload() {
        let adapter = adapter();
        let mut idx = EventIndexer::default();
        let event = adapter.tool_call_start_override(
            "q-1",
            "AskUserQuestion",
            &json!({}),
            &metadata(),
            None,
            &mut idx,
        );
        assert!(event.is_none());
    }
    #[test]
    fn tool_call_update_override_emits_permission_event_with_real_payload() {
        let adapter = adapter();
        let mut idx = EventIndexer::default();
        let event = adapter
            .tool_call_update_override(
                "q-2",
                &json!({
                    "rawInput": {
                        "questions": [{ "question": "Pick", "options": [] }]
                    }
                }),
                "in_progress",
                &metadata(),
                None,
                &mut idx,
            )
            .expect("event");
        let raw = event.raw_json();
        assert_eq!(raw["type"], "acp_permission_request");
        assert_eq!(raw["tool_name"], "AskUserQuestion");
    }
    #[test]
    fn suppresses_raw_output_for_task_and_agent_only() {
        let adapter = adapter();
        assert!(adapter.suppresses_raw_output("Task"));
        assert!(adapter.suppresses_raw_output("Agent"));
        assert!(!adapter.suppresses_raw_output("Bash"));
        assert!(!adapter.suppresses_raw_output("Write"));
    }
    #[test]
    fn synthesize_tool_call_completion_emits_text_under_parent_for_task() {
        let body = json!({
            "toolCallId": "call_TASK_PARENT",
            "status": "completed",
            "rawOutput": {
                "output": "<task id=\"ses_child\" state=\"completed\">\n<task_result>\nfindings line 1\nfindings line 2\n</task_result>\n</task>",
                "metadata": { "sessionId": "ses_child" }
            }
        });
        let events = adapter().synthesize_tool_call_completion(
            "call_TASK_PARENT",
            "Task",
            &body,
            "completed",
            &metadata(),
            &mut EventIndexer::default(),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].parent_tool_use_id(), Some("call_TASK_PARENT"));
        let RuntimeContentBlock::Text { text } =
            &events[0].assistant_message().expect("assistant").content[0]
        else {
            panic!("expected text block");
        };
        assert_eq!(text, "findings line 1\nfindings line 2");
    }
    #[test]
    fn synthesize_tool_call_completion_returns_empty_for_non_subagent_or_blank_body() {
        let adapter = adapter();
        let mut idx = EventIndexer::default();
        assert!(adapter
            .synthesize_tool_call_completion(
                "call_BASH",
                "Bash",
                &json!({ "rawOutput": { "output": "ls -la output" } }),
                "completed",
                &metadata(),
                &mut idx,
            )
            .is_empty());
        assert!(adapter
            .synthesize_tool_call_completion(
                "call_TASK",
                "Task",
                &json!({ "rawOutput": { "output": "" } }),
                "completed",
                &metadata(),
                &mut idx,
            )
            .is_empty());
    }
}
