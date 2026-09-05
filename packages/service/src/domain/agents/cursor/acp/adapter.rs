use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::schema::v1::SessionConfigOption;
use async_trait::async_trait;
use serde_json::Value;

use crate::domain::agents::acp::runtime::provider_hooks::{
    AcpExtensionRequest, AcpProviderHooks, AcpServerRequestResolution,
};
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeEventMetadata, RuntimePermissionDecision,
    RuntimePermissionMode, RuntimePermissionRequest, RuntimePermissionResponse,
    RuntimePermissionResponseKind, RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
    RuntimeSlashCommand,
};

use super::extensions;
use super::model_config::{catalog_model_encodes_effort, lock_mutex, CursorModelConfigState};
use super::normalize::{canonical_tool_name, derive_permission_tool_input, normalize_tool_input};
use super::permission_policy;

const AUTH_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) struct CursorAcpAdapter {
    /// Live access mode driving the host-side Auto Review preflight in
    /// [`automatic_permission_decision`]. Held behind a `Mutex` so a
    /// mid-conversation `access_mode.set` (via [`Self::update_access_mode`])
    /// changes approval behavior on the current turn instead of only on the
    /// next respawn. The sandbox/`--force` launch flags still ride the respawn.
    access_mode: Mutex<Option<RuntimeAccessMode>>,
    plan_requests: Mutex<std::collections::HashSet<String>>,
    model_config: Mutex<CursorModelConfigState>,
}

impl CursorAcpAdapter {
    pub(super) fn new(access_mode: Option<RuntimeAccessMode>) -> Self {
        Self {
            access_mode: Mutex::new(access_mode),
            plan_requests: Mutex::new(std::collections::HashSet::new()),
            model_config: Mutex::new(CursorModelConfigState::default()),
        }
    }

    fn records_plan_request(&self, request_id: &str) {
        lock_mutex(&self.plan_requests).insert(request_id.to_string());
    }

    fn plan_requests(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        lock_mutex(&self.plan_requests)
    }
}

#[async_trait]
impl AcpProviderHooks for CursorAcpAdapter {
    async fn authenticate(
        &self,
        client: &AcpClient,
        initialize_response: &Value,
    ) -> Result<(), RuntimeError> {
        if !advertises_cursor_login(initialize_response) {
            return Ok(());
        }
        client
            .request_with_timeout(
                "authenticate",
                serde_json::json!({ "methodId": "cursor_login" }),
                AUTH_TIMEOUT,
            )
            .await
            .map(|_| ())
            .map_err(|error| {
                RuntimeError::new(format!(
                    "Cursor authentication failed; run `agent login`: {error}"
                ))
            })
    }

    fn normalize_tool_name(&self, raw: &str) -> String {
        canonical_tool_name(raw)
    }

    fn normalize_tool_input(&self, tool_name: &str, input: Value) -> Value {
        normalize_tool_input(tool_name, input)
    }

    fn derive_permission_tool_input(&self, tool_name: &str, input: Value, params: &Value) -> Value {
        derive_permission_tool_input(tool_name, input, params)
    }

    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String> {
        Some(match mode {
            RuntimePermissionMode::Plan => "plan".to_string(),
            RuntimePermissionMode::Ask => "ask".to_string(),
            _ => "agent".to_string(),
        })
    }

    fn model_config_id(&self) -> Option<&str> {
        Some("model")
    }

    fn client_capabilities_meta(&self) -> agent_client_protocol::schema::v1::Meta {
        let mut meta = agent_client_protocol::schema::v1::Meta::new();
        meta.insert("parameterizedModelPicker".to_string(), Value::Bool(true));
        meta
    }

    fn observe_session_config_options(&self, options: &[SessionConfigOption]) {
        lock_mutex(&self.model_config).observe(options);
    }

    fn model_config_value(&self, model: &str) -> String {
        lock_mutex(&self.model_config).model_config_value(model)
    }

    fn model_config_companions(&self, model: &str) -> Vec<(String, RuntimeSessionConfigValue)> {
        lock_mutex(&self.model_config).companions(model)
    }

    fn legacy_model_from_session_config(
        &self,
        _model_value: &str,
        _snapshot: &RuntimeSessionConfigSnapshot,
    ) -> Option<String> {
        // Cursor's catalog model includes companion fast/thinking parameters,
        // while ACP exposes the base model and companions as separate options.
        None
    }

    fn model_encodes_thinking_effort(&self, model: &str) -> bool {
        catalog_model_encodes_effort(model)
    }

    fn thinking_effort_config_id(&self) -> Option<String> {
        lock_mutex(&self.model_config).thinking_effort_config_id()
    }

    fn default_mode_id(&self) -> Option<&'static str> {
        Some("agent")
    }

    fn compact_prompt(&self) -> Option<&'static str> {
        Some("/compress")
    }

    fn supports_durable_resume(&self) -> bool {
        true
    }

    fn extension_request(
        &self,
        request_id: &str,
        method: &str,
        params: &Value,
        metadata: RuntimeEventMetadata,
    ) -> Option<AcpExtensionRequest> {
        let request = extensions::extension_request(request_id, method, params, metadata)?;
        if method == "cursor/create_plan" {
            self.records_plan_request(request_id);
        }
        Some(request)
    }

    fn extension_notification(
        &self,
        method: &str,
        params: &Value,
        metadata: RuntimeEventMetadata,
    ) -> Option<Vec<RuntimeEvent>> {
        extensions::extension_notification(method, params, metadata)
    }

    fn resolve_server_request(
        &self,
        method: &str,
        params: &Value,
        response: &RuntimePermissionResponse,
    ) -> AcpServerRequestResolution {
        if method == "cursor/create_plan" {
            self.plan_requests().remove(&response.request_id);
        }
        let response_payload = extensions::server_request_response(method, params, response)
            .unwrap_or_else(|| {
                crate::domain::agents::acp::runtime::permissions::acp_permission_response_payload(
                    response.decision,
                    response.option_id.as_deref(),
                    response.feedback.as_deref(),
                )
            });
        AcpServerRequestResolution {
            response: response_payload,
            followup: extensions::server_request_followup(method, response),
        }
    }

    fn automatic_permission_decision(
        &self,
        request: &RuntimePermissionRequest,
        params: &Value,
    ) -> Option<RuntimePermissionDecision> {
        let access_mode = lock_mutex(&self.access_mode).clone();
        permission_policy::automatic_permission_decision(access_mode.as_ref(), request, params)
    }

    fn update_access_mode(&self, mode: RuntimeAccessMode) {
        *lock_mutex(&self.access_mode) = Some(mode);
    }

    fn permission_response_kind(&self, request_id: &str) -> RuntimePermissionResponseKind {
        if self.plan_requests().contains(request_id) {
            RuntimePermissionResponseKind::PlanApproval
        } else {
            RuntimePermissionResponseKind::Normal
        }
    }

    async fn record_available_commands(&self, cwd: &Path, commands: Vec<RuntimeSlashCommand>) {
        crate::domain::agents::cursor::commands::record_snapshot(&cwd.to_string_lossy(), commands)
            .await;
    }
}

fn advertises_cursor_login(response: &Value) -> bool {
    response
        .get("authMethods")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods.iter().any(|method| {
                method
                    .get("id")
                    .or_else(|| method.get("methodId"))
                    .and_then(Value::as_str)
                    == Some("cursor_login")
            })
        })
}

#[cfg(test)]
mod tests {
    use super::{advertises_cursor_login, CursorAcpAdapter};
    use crate::domain::agents::acp::runtime::events::session_update_to_events;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::adapter::{
        RuntimeAccessMode, RuntimeContentBlock, RuntimePermissionDecision, RuntimePermissionMode,
        RuntimePermissionRequest, RuntimePermissionResponse, RuntimePermissionResponseKind,
        RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue, RuntimeStreamEvent,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };
    use serde_json::json;

    fn allowlist_miss_request(command: &str) -> RuntimePermissionRequest {
        RuntimePermissionRequest {
            request_id: "permission-1".to_string(),
            tool_use_id: Some("tool-1".to_string()),
            tool_name: "Bash".to_string(),
            tool_input: json!({ "command": command }),
            description: Some(format!("`{command}`")),
            pattern: None,
            preview: Some(command.to_string()),
            options: Vec::new(),
        }
    }

    fn allowlist_miss_params(command: &str) -> serde_json::Value {
        json!({
            "toolCall": {
                "title": format!("`{command}`"),
                "kind": "execute",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": format!("Not in allowlist: {command}") }
                }]
            }
        })
    }

    /// The whole point of the fix: a mid-conversation `access_mode.set` reaches
    /// the live adapter through `update_access_mode`, so the very next host-side
    /// preflight reflects the new mode without waiting for a respawn.
    #[test]
    fn update_access_mode_flips_live_preflight_decision() {
        let command = "printf cursor-acp-auto-review";
        let adapter = CursorAcpAdapter::new(Some(RuntimeAccessMode::AutoReview));
        let request = allowlist_miss_request(command);
        let params = allowlist_miss_params(command);

        // Auto Review preflights the allowlist miss.
        assert_eq!(
            adapter.automatic_permission_decision(&request, &params),
            Some(RuntimePermissionDecision::AllowOnce)
        );

        // Switching to Default live must stop auto-approving immediately.
        adapter.update_access_mode(RuntimeAccessMode::Default);
        assert_eq!(
            adapter.automatic_permission_decision(&request, &params),
            None
        );

        // And switching back re-enables the preflight on the same live adapter.
        adapter.update_access_mode(RuntimeAccessMode::AutoReview);
        assert_eq!(
            adapter.automatic_permission_decision(&request, &params),
            Some(RuntimePermissionDecision::AllowOnce)
        );
    }

    #[test]
    fn model_config_hooks_map_parameterized_catalog_ids() {
        let adapter = CursorAcpAdapter::new(None);
        let model = SessionConfigOption::select(
            "model",
            "Model",
            "composer-2.5",
            vec![
                SessionConfigSelectOption::new("default", "Auto"),
                SessionConfigSelectOption::new("composer-2.5", "Composer 2.5"),
            ],
        )
        .category(SessionConfigOptionCategory::Model);
        let fast = SessionConfigOption::select(
            "fast",
            "Fast",
            "true",
            vec![
                SessionConfigSelectOption::new("false", "Off"),
                SessionConfigSelectOption::new("true", "Fast"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig);
        adapter.observe_session_config_options(&[model, fast]);

        assert_eq!(adapter.model_config_value("auto"), "default");
        assert_eq!(adapter.model_config_value("composer-2.5"), "composer-2.5");
        assert_eq!(
            adapter.model_config_value("composer-2.5-fast"),
            "composer-2.5"
        );
        assert_eq!(
            adapter.model_config_companions("composer-2.5"),
            vec![(
                "fast".to_string(),
                RuntimeSessionConfigValue::Select("false".to_string())
            )]
        );
        assert_eq!(
            adapter.model_config_companions("composer-2.5-fast"),
            vec![(
                "fast".to_string(),
                RuntimeSessionConfigValue::Select("true".to_string())
            )]
        );
        assert!(adapter.model_encodes_thinking_effort("gpt-5.3-codex-high"));
        assert!(!adapter.model_encodes_thinking_effort("composer-2.5"));
        assert!(adapter
            .legacy_model_from_session_config(
                "composer-2.5",
                &RuntimeSessionConfigSnapshot::default()
            )
            .is_none());
        let meta = adapter.client_capabilities_meta();
        assert_eq!(meta.get("parameterizedModelPicker"), Some(&json!(true)));
    }

    #[test]
    fn detects_cursor_auth_method() {
        assert!(advertises_cursor_login(&json!({
            "authMethods": [{ "id": "cursor_login", "name": "Cursor" }]
        })));
        assert!(!advertises_cursor_login(&json!({})));
    }

    #[test]
    fn composer_subagent_title_becomes_visible_agent_tool() {
        let adapter = CursorAcpAdapter::new(None);
        let mut indexer = EventIndexer::default();
        let events = session_update_to_events(
            &json!({
                "sessionId": "cursor-session",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-task-1",
                    "title": "Task: Subagent task",
                    "kind": "other",
                    "rawInput": { "_toolName": "task" },
                },
            }),
            &mut indexer,
            None,
            Some("cursor-session"),
            &adapter,
        )
        .events;

        let start = events
            .iter()
            .find_map(|event| event.stream_event())
            .expect("tool start event");
        assert!(matches!(
            start,
            RuntimeStreamEvent::ContentBlockStart {
                block: RuntimeContentBlock::ToolUse { name, input, .. },
                ..
            } if name == "Agent" && input["description"] == "Task: Subagent task"
        ));
    }

    #[test]
    fn maps_runtime_modes_and_compaction() {
        let adapter = CursorAcpAdapter::new(None);
        assert_eq!(
            adapter.mode_for_permission_mode(RuntimePermissionMode::Plan),
            Some("plan".to_string())
        );
        assert_eq!(
            adapter.mode_for_permission_mode(RuntimePermissionMode::AcceptEdits),
            Some("agent".to_string())
        );
        assert_eq!(
            adapter.mode_for_permission_mode(RuntimePermissionMode::Ask),
            Some("ask".to_string())
        );
        assert_eq!(adapter.compact_prompt(), Some("/compress"));
    }

    #[test]
    fn classifies_recorded_plan_requests() {
        let adapter = CursorAcpAdapter::new(None);
        adapter.records_plan_request("plan-1");
        assert_eq!(
            adapter.permission_response_kind("plan-1"),
            RuntimePermissionResponseKind::PlanApproval
        );
        assert_eq!(
            adapter.permission_response_kind("question-1"),
            RuntimePermissionResponseKind::Normal
        );
    }

    #[test]
    fn accepted_plan_queues_backend_owned_followup() {
        let adapter = CursorAcpAdapter::new(None);
        let response = RuntimePermissionResponse {
            request_id: "plan-1".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        let resolution =
            adapter.resolve_server_request("cursor/create_plan", &json!({}), &response);
        assert_eq!(
            resolution.followup,
            Some(json!("Plan approved. Proceed with execution."))
        );
    }
}
