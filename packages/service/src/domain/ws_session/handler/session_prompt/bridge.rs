use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::ws::Message;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info};

use crate::domain::agents::adapter::{
    RuntimeToolPermissionHandler, RuntimeToolPermissionRequest, RuntimeToolPermissionResult,
};
use crate::domain::mcp::trusted::is_trusted_cadencr_browser_tool_name;
use crate::domain::permission_bridge;
use crate::domain::ws_session::persistence::{
    PendingUserInput, PendingUserInputKind, WsSessionPersistence,
};
use crate::domain::ws_session::protocol::{
    permission_request_envelope, PermissionDecision, PermissionRequestPayload, SessionErrorPayload,
    WsEnvelope,
};

use super::super::post_plan_mode::transition_session_to_post_plan_mode;
use super::super::types::SdkSessions;
use super::super::WsSender;
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

#[derive(Clone)]
pub struct PermissionResponse {
    pub(crate) request_id: String,
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
    pub(crate) sender: WsSender,
    /// Every other device viewing this feature. A gate is mirrored to them so
    /// it appears on all connected clients, not just whichever one owns the
    /// live turn.
    pub(crate) feature_senders: WsFeatureSenderRegistry,
    pub(crate) response_rx: Arc<Mutex<mpsc::Receiver<PermissionResponse>>>,
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
            let _ = sqlx::query("UPDATE agent_sessions SET permission_mode = 'plan' WHERE id = ?")
                .bind(self.db_session_id)
                .execute(&self.write_pool)
                .await;
            return RuntimeToolPermissionResult::Allow {
                updated_input: request.input,
                updated_permissions: None,
                tool_use_id: Some(request.tool_use_id),
            };
        }

        if request.tool_name == "ExitPlanMode" {
            return self.handle_exit_plan_mode(&request).await;
        }

        if is_trusted_cadencr_browser_tool_name(&request.tool_name) {
            return RuntimeToolPermissionResult::Allow {
                updated_input: request.input,
                updated_permissions: None,
                tool_use_id: Some(request.tool_use_id),
            };
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
        WsSessionPersistence::mark_awaiting_user_static(
            &self.app_state,
            self.db_session_id,
            self.feature_id,
            &PendingUserInput::Permission(&payload),
        )
        .await;
        self.send_permission_payload(payload).await;

        let mut rx = self.response_rx.lock().await;
        match rx.recv().await {
            Some(response) => {
                let decision = response.decision.clone();
                if response.request_id != request.tool_use_id {
                    debug!(
                        expected_request_id = %request.tool_use_id,
                        received_request_id = %response.request_id,
                        "permission response request_id mismatch, applying latest response",
                    );
                }
                WsSessionPersistence::mark_agent_resumed_static(
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
                WsSessionPersistence::mark_agent_resumed_static(
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
        match response.decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowFuture => {
                let p = WsSessionPersistence::with_session_id(
                    self.write_pool.clone(),
                    self.feature_id,
                    Some(self.db_session_id),
                );
                p.persist_user_message("Plan approved.").await;
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
                let p = WsSessionPersistence::with_session_id(
                    self.write_pool.clone(),
                    self.feature_id,
                    Some(self.db_session_id),
                );
                p.persist_user_message(&feedback).await;
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
            let err = WsEnvelope::new(
                "session",
                "error",
                serde_json::to_value(SessionErrorPayload {
                    code: "SDK_ERROR".into(),
                    message: format!("Failed to apply post-plan permission mode: {e}"),
                    ..Default::default()
                })
                .unwrap(),
            );
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
                let envelope = WsEnvelope::new(
                    "session",
                    "error",
                    serde_json::to_value(SessionErrorPayload {
                        code: "DB_ERROR".into(),
                        message: "Failed to persist the enriched plan approval request.".into(),
                        ..Default::default()
                    })
                    .unwrap(),
                );
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

        let payload = PermissionRequestPayload {
            request_id: request.tool_use_id.clone(),
            tool_name: request.tool_name.clone(),
            tool_input: request.input.clone(),
            description: Some(permission_bridge::provider_permission_description(request)),
            pattern: None,
            preview: permission_bridge::extract_permission_preview(&request.input),
            options: permission_bridge::build_provider_permission_options(&permission_updates),
        };
        let question_payload = is_question.then(|| {
            serde_json::to_value(&payload).expect("question permission payload should serialize")
        });
        let pending = question_payload
            .as_ref()
            .map(PendingUserInput::Question)
            .unwrap_or(PendingUserInput::Permission(&payload));
        WsSessionPersistence::mark_awaiting_user_static(
            &self.app_state,
            self.db_session_id,
            self.feature_id,
            &pending,
        )
        .await;
        self.send_permission_payload(payload).await;

        // `wait_and_apply_decision` owns the clear + terminal-turn broadcast.
        let result = permission_bridge::wait_and_apply_decision(
            &self.response_rx,
            &request.tool_use_id,
            request.input.clone(),
            &permission_updates,
            &self.session_status_tx,
            self.feature_id,
            &self.write_pool,
            self.db_session_id,
            pending_kind,
        )
        .await;
        if is_question {
            crate::domain::agents::claude_code::question_answers::normalize_result(result)
        } else {
            result
        }
    }
}
