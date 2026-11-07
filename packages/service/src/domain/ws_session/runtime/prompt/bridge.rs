use crate::domain::ws_session::protocol::WsSessionEvent;
use crate::domain::ws_session::runtime::output::{OutputTarget, SessionOutput};
use async_trait::async_trait;
use axum::extract::ws::Message;
use tracing::{debug, error, info};

use crate::domain::agents::adapter::{
    RuntimeToolPermissionHandler, RuntimeToolPermissionRequest, RuntimeToolPermissionResult,
};
use crate::domain::permission_bridge;
use crate::domain::ws_session::persistence::{PendingUserInput, PendingUserInputKind};
use crate::domain::ws_session::protocol::{
    permission_request_envelope, PermissionDecision, PermissionRequestPayload, SessionErrorPayload,
    WsEnvelope,
};
use crate::domain::ws_session::runtime::application::{mark_agent_resumed, mark_awaiting_user};

use super::super::post_plan_mode::transition_session_to_post_plan_mode;
use super::super::state::SdkSessions;
use super::permission_responses::PermissionResponseWaiters;

use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

#[derive(Clone)]
pub struct PermissionResponse {
    pub(crate) request_id: String,
    pub(crate) message_uuid: Option<String>,
    pub(crate) decision: PermissionDecision,
    #[allow(dead_code)]
    pub(crate) option_id: Option<String>,
    pub(crate) feedback: Option<String>,
    pub(crate) updated_input: Option<serde_json::Value>,
    #[allow(dead_code)]
    pub(crate) is_approval_gate: bool,
}

pub(crate) struct WsBridgeCanUseTool {
    pub(crate) app_state: crate::app_state::AppState,
    pub(crate) sender: SessionOutput,
    /// Every other device viewing this feature. A gate is mirrored to them so
    /// it appears on all connected clients, not just whichever one owns the
    /// live turn.
    pub(crate) feature_senders: WsFeatureSenderRegistry,
    /// Responses are routed to each open request by its id, so concurrent
    /// requests can never consume one another's answers.
    pub(crate) permission_waiters: PermissionResponseWaiters,
    pub(crate) feature_id: i64,
    pub(crate) db_session_id: i64,
    pub(crate) write_pool: sqlx::SqlitePool,
    pub(crate) session_status_tx: crate::domain::session_status::SessionStatusBroadcaster,
    pub(crate) sdk_sessions: SdkSessions,
}

#[async_trait]
impl RuntimeToolPermissionHandler for WsBridgeCanUseTool {
    async fn can_use_tool(
        &self,
        request: RuntimeToolPermissionRequest,
    ) -> RuntimeToolPermissionResult {
        debug!(
            tool_name = %request.tool_name,
            tool_use_id = %request.tool_use_id,
            "WsBridgeCanUseTool::can_use_tool called"
        );

        if request.tool_name == "EnterPlanMode" {
            if let Err(error) =
                crate::domain::ws_session::persistence::WsSessionPersistence::update_permission_mode_static(
                    &self.write_pool,
                    self.db_session_id,
                    "plan",
                )
                .await
            {
                crate::domain::ws_session::runtime::helpers::report_session_write_failure(
                    &self.feature_senders,
                    self.feature_id,
                    self.db_session_id,
                    "that the agent entered plan mode",
                    &error,
                )
                .await;
            }
            return RuntimeToolPermissionResult::Allow {
                updated_input: request.input,
                updated_permissions: None,
                tool_use_id: Some(request.tool_use_id),
            };
        }

        if request.tool_name == "ExitPlanMode" {
            return self.handle_exit_plan_mode(&request).await;
        }

        self.handle_provider_permission_prompt(&request).await
    }
}

impl WsBridgeCanUseTool {
    async fn handle_exit_plan_mode(
        &self,
        request: &RuntimeToolPermissionRequest,
    ) -> RuntimeToolPermissionResult {
        info!("ExitPlanMode detected, sending permission request and blocking");

        let enriched_input = self.attach_plan_to_exit_block(request).await;
        let payload = self.plan_permission_payload(request, enriched_input);
        let waiter = self.permission_waiters.register(&payload.request_id);
        mark_awaiting_user(
            &self.app_state,
            self.db_session_id,
            self.feature_id,
            &PendingUserInput::Permission(&payload),
        )
        .await;
        self.send_permission_payload(payload).await;

        match waiter.recv().await {
            Some(response) => {
                let decision = response.decision.clone();
                mark_agent_resumed(
                    &self.write_pool,
                    &self.session_status_tx,
                    self.db_session_id,
                    self.feature_id,
                    PendingUserInputKind::Permission,
                    crate::domain::permission_bridge::status_after_approval(
                        decision,
                        response.feedback.as_deref(),
                    ),
                )
                .await;
                self.apply_exit_plan_decision(request, response).await
            }
            None => {
                mark_agent_resumed(
                    &self.write_pool,
                    &self.session_status_tx,
                    self.db_session_id,
                    self.feature_id,
                    PendingUserInputKind::Permission,
                    crate::domain::session_status::AgentStatus::Idle,
                )
                .await;
                RuntimeToolPermissionResult::Deny {
                    message: "Plan approval channel closed".to_string(),
                    interrupt: Some(false),
                    tool_use_id: Some(request.tool_use_id.clone()),
                }
            }
        }
    }

    async fn apply_exit_plan_decision(
        &self,
        request: &RuntimeToolPermissionRequest,
        response: PermissionResponse,
    ) -> RuntimeToolPermissionResult {
        let message_uuid = response.message_uuid.clone();
        match response.decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowFuture => {
                self.persist_and_publish_plan_message("Plan approved.", message_uuid.as_deref())
                    .await;
                self.transition_to_post_plan_mode().await;
                RuntimeToolPermissionResult::Allow {
                    updated_input: request.input.clone(),
                    updated_permissions: None,
                    tool_use_id: Some(request.tool_use_id.clone()),
                }
            }
            PermissionDecision::Deny => {
                let feedback = response
                    .feedback
                    .unwrap_or_else(|| "User requested changes to the plan.".to_string());
                self.persist_and_publish_plan_message(&feedback, message_uuid.as_deref())
                    .await;
                RuntimeToolPermissionResult::Deny {
                    message: feedback,
                    interrupt: Some(false),
                    tool_use_id: Some(request.tool_use_id.clone()),
                }
            }
        }
    }

    /// Push post-plan permission mode to CLI, DB, and UI in one synchronous path.
    async fn transition_to_post_plan_mode(&self) {
        if let Err(e) = transition_session_to_post_plan_mode(
            &self.sdk_sessions,
            self.db_session_id,
            &self.write_pool,
            &self.sender,
        )
        .await
        {
            error!(
                db_session_id = self.db_session_id,
                error = %e,
                "post-plan-approval: failed to push set_permission_mode to CLI"
            );
            let err = WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
                code: "SDK_ERROR".into(),
                message: format!("Failed to apply post-plan permission mode: {e}"),
                ..Default::default()
            }))
            .expect("session event payload should serialize");
            let _ = self.sender.send(Message::Text(String::from(err).into()));
        }
    }

    async fn attach_plan_to_exit_block(
        &self,
        request: &RuntimeToolPermissionRequest,
    ) -> serde_json::Value {
        let plan_path: Option<String> = sqlx::query_scalar(
            "SELECT content FROM agent_messages \
             WHERE session_id = ? AND message_type = 'tool_call' AND tool_name = 'Write' \
             AND content LIKE '%plans/%' \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(self.db_session_id)
        .fetch_optional(&self.write_pool)
        .await
        .ok()
        .flatten();

        let plan_content = match plan_path {
            Some(content_json) => {
                let parsed: Option<String> =
                    serde_json::from_str::<serde_json::Value>(&content_json)
                        .ok()
                        .and_then(|v| v.get("file_path")?.as_str().map(String::from));
                match parsed {
                    Some(file_path) => tokio::fs::read_to_string(&file_path).await.ok(),
                    None => None,
                }
            }
            None => None,
        };

        let mut enriched = request.input.clone();
        if let Some(plan_md) = plan_content {
            enriched["plan"] = serde_json::Value::String(plan_md);
            let updated_content = serde_json::to_string(&enriched).unwrap_or_default();
            if let Err(error) = crate::domain::features::repository::persist_tool_call_message(
                &self.write_pool,
                crate::domain::features::repository::ToolCallMessage {
                    session_id: self.db_session_id,
                    tool_use_id: &request.tool_use_id,
                    tool_name: &request.tool_name,
                    content: &updated_content,
                    parent_tool_use_id: None,
                    model: None,
                },
            )
            .await
            {
                error!(
                    db_session_id = self.db_session_id,
                    tool_use_id = %request.tool_use_id,
                    error = %error,
                    "failed to persist enriched ExitPlanMode tool input"
                );
                let envelope =
                    WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
                        code: "DB_ERROR".into(),
                        message: "Failed to persist the enriched plan approval request.".into(),
                        ..Default::default()
                    }))
                    .expect("session event payload should serialize");
                let _ = self
                    .sender
                    .send(Message::Text(String::from(envelope).into()));
            }
        }
        enriched
    }

    fn plan_permission_payload(
        &self,
        request: &RuntimeToolPermissionRequest,
        tool_input: serde_json::Value,
    ) -> PermissionRequestPayload {
        PermissionRequestPayload {
            request_id: request.tool_use_id.clone(),
            tool_name: request.tool_name.clone(),
            tool_input,
            description: Some("Plan is ready for approval".to_string()),
            pattern: None,
            preview: None,
            options: Vec::new(),
        }
    }

    async fn send_permission_payload(&self, payload: PermissionRequestPayload) {
        let envelope = permission_request_envelope(payload)
            .expect("permission request payload should serialize");
        self.mirror_and_send(Message::Text(String::from(envelope).into()))
            .await;
    }

    /// Send `msg` to the turn owner and mirror it to every other device viewing
    /// this feature. This is how a permission/plan/question gate reaches all
    /// connected clients — the answer can then come back from any of them
    /// (resolved against the owning turn by the active-turn registry).
    async fn mirror_and_send(&self, msg: Message) {
        let _ = self
            .feature_senders
            .send_and_mirror(self.feature_id, &self.sender, msg)
            .await;
    }

    async fn handle_provider_permission_prompt(
        &self,
        request: &RuntimeToolPermissionRequest,
    ) -> RuntimeToolPermissionResult {
        debug!(tool_name = %request.tool_name, "prompting user for provider-native permission");
        let is_question = crate::domain::ws_session::protocol::is_question_tool(&request.tool_name);
        let pending_kind = if is_question {
            PendingUserInputKind::Question
        } else {
            PendingUserInputKind::Permission
        };
        let permission_updates =
            permission_bridge::persistent_permission_updates(&request.permission_updates);

        let mut payload = PermissionRequestPayload {
            request_id: request.tool_use_id.clone(),
            tool_name: request.tool_name.clone(),
            tool_input: request.input.clone(),
            description: Some(permission_bridge::provider_permission_description(request)),
            pattern: None,
            preview: permission_bridge::extract_permission_preview(&request.input),
            options: permission_bridge::build_provider_permission_options(&permission_updates),
        };
        crate::domain::ws_session::protocol::clear_question_permission_chrome(&mut payload);
        let question_payload = is_question.then(|| {
            serde_json::to_value(&payload).expect("question permission payload should serialize")
        });
        let pending = question_payload
            .as_ref()
            .map(PendingUserInput::Question)
            .unwrap_or(PendingUserInput::Permission(&payload));
        let waiter = self.permission_waiters.register(&payload.request_id);
        mark_awaiting_user(
            &self.app_state,
            self.db_session_id,
            self.feature_id,
            &pending,
        )
        .await;
        self.send_permission_payload(payload).await;

        // `wait_and_apply_decision` owns the clear + terminal-turn broadcast.
        permission_bridge::wait_and_apply_decision(
            waiter,
            &request.tool_use_id,
            request.input.clone(),
            &permission_updates,
            &self.session_status_tx,
            self.feature_id,
            &self.write_pool,
            self.db_session_id,
            pending_kind,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::super::permission_responses::{
        permission_response_channel, PermissionDeliveryError, PermissionResponseSender,
    };
    use super::*;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;
    use crate::domain::ws_session::runtime::state::new_sdk_sessions;

    fn tool_request(request_id: &str) -> RuntimeToolPermissionRequest {
        RuntimeToolPermissionRequest {
            tool_name: "Bash".into(),
            tool_use_id: request_id.into(),
            input: serde_json::json!({ "command": format!("echo {request_id}") }),
            permission_updates: Vec::new(),
            blocked_path: None,
            decision_reason: None,
        }
    }

    fn answer(request_id: &str, decision: PermissionDecision) -> PermissionResponse {
        PermissionResponse {
            request_id: request_id.into(),
            message_uuid: None,
            decision,
            option_id: None,
            feedback: None,
            updated_input: None,
            is_approval_gate: false,
        }
    }

    /// Retry until the bridge has registered `request_id` (it registers before
    /// the request reaches any client), then deliver exactly once.
    async fn deliver_when_open(sender: &PermissionResponseSender, response: PermissionResponse) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match sender.deliver(response.clone()) {
                    Ok(()) => return,
                    Err(PermissionDeliveryError::UnknownRequest(_)) => {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    Err(error) => panic!("delivery failed: {error}"),
                }
            }
        })
        .await
        .expect("request was never registered");
    }

    fn result_id(result: &RuntimeToolPermissionResult) -> Option<&str> {
        match result {
            RuntimeToolPermissionResult::Allow { tool_use_id, .. }
            | RuntimeToolPermissionResult::Deny { tool_use_id, .. } => tool_use_id.as_deref(),
        }
    }

    #[tokio::test]
    async fn concurrent_requests_each_receive_only_their_own_answer() {
        let app_state = make_test_app_state().await;
        let db_session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (1, 'session', 'running') RETURNING id",
        )
        .fetch_one(&app_state.write_pool)
        .await
        .unwrap();
        let (sender, waiters) = permission_response_channel();
        let bridge = Arc::new(WsBridgeCanUseTool {
            app_state: app_state.clone(),
            sender: SessionOutput::headless(),
            feature_senders: app_state.ws_feature_senders.clone(),
            permission_waiters: waiters,
            feature_id: 1,
            db_session_id,
            write_pool: app_state.write_pool.clone(),
            session_status_tx: app_state.session_status_tx.clone(),
            sdk_sessions: new_sdk_sessions(),
        });
        let first = tokio::spawn({
            let bridge = Arc::clone(&bridge);
            async move { bridge.can_use_tool(tool_request("req-a")).await }
        });
        let second = tokio::spawn({
            let bridge = Arc::clone(&bridge);
            async move { bridge.can_use_tool(tool_request("req-b")).await }
        });

        deliver_when_open(&sender, answer("req-b", PermissionDecision::Deny)).await;
        let second = second.await.unwrap();
        assert_eq!(result_id(&second), Some("req-b"));
        assert!(matches!(second, RuntimeToolPermissionResult::Deny { .. }));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !first.is_finished(),
            "req-a must not consume req-b's answer"
        );

        deliver_when_open(&sender, answer("req-a", PermissionDecision::AllowOnce)).await;
        let first = first.await.unwrap();
        assert_eq!(result_id(&first), Some("req-a"));
        assert!(matches!(first, RuntimeToolPermissionResult::Allow { .. }));
    }
}
