use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use codex_app_server_sdk_rs::{AppServerEvent, AppServerEventReceiver, CodexAppServerClient};
use tokio::sync::{mpsc, Mutex, RwLock};

use super::async_questions::{request_id as async_question_id, PendingAsyncQuestions};
use super::event_lifecycle::SessionLifecycle;
use super::event_state::IndexState;
use super::event_subagent_recovery::recover_interacted_routes;
use super::event_system::{permission_request_event, request_key};
use super::event_turn_state::{update_turn_state, RootTurnTracker};
use super::events::{notification_events, rerouted_model};
use super::permissions::PendingCodexRequest;
use super::prompt_receipts::PendingPromptReceipts;
use super::responses::response_value;
use super::trusted_mcp::trusted_cadencr_browser_permission_response;
use crate::domain::agents::adapter::{KnownSubagent, RuntimeError, RuntimeEvent};

#[bon::builder]
pub(super) fn spawn_event_loop(
    client: CodexAppServerClient,
    source_rx: AppServerEventReceiver,
    tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    pending_requests: Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
    async_questions: Arc<Mutex<PendingAsyncQuestions>>,
    pending_prompt_receipts: Arc<PendingPromptReceipts>,
    turns: RootTurnTracker,
    model: Arc<RwLock<Option<String>>>,
    closing: Arc<AtomicBool>,
    compaction: Arc<super::session::compaction::CompactionState>,
    /// Sub-agents earlier runtimes spawned: a rehydrated child keeps its carrier.
    known_subagents: Vec<KnownSubagent>,
) {
    let event_loop = EventLoop {
        client,
        tx,
        pending_requests,
        async_questions,
        pending_prompt_receipts,
        turns,
        model,
        closing,
        compaction,
    };
    tokio::spawn(async move { event_loop.run(source_rx, known_subagents).await });
}

struct EventLoop {
    client: CodexAppServerClient,
    tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    pending_requests: Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
    async_questions: Arc<Mutex<PendingAsyncQuestions>>,
    pending_prompt_receipts: Arc<PendingPromptReceipts>,
    turns: RootTurnTracker,
    model: Arc<RwLock<Option<String>>>,
    closing: Arc<AtomicBool>,
    compaction: Arc<super::session::compaction::CompactionState>,
}

struct NotificationState {
    command_outputs: HashMap<String, String>,
    index_state: IndexState,
    lifecycle: SessionLifecycle,
}

impl EventLoop {
    async fn run(&self, mut source: AppServerEventReceiver, known_subagents: Vec<KnownSubagent>) {
        let mut index_state = IndexState::for_root_thread(&self.turns.root_thread_id);
        index_state.seed_known_subagents(known_subagents);
        let mut state = NotificationState {
            command_outputs: HashMap::new(),
            index_state,
            lifecycle: SessionLifecycle::default(),
        };
        loop {
            match source.recv().await {
                Some(AppServerEvent::Notification { method, params }) => {
                    if !self.notification(method, params, &mut state).await {
                        return;
                    }
                }
                Some(AppServerEvent::ServerRequest { id, method, params }) => {
                    if let Some(response) =
                        trusted_cadencr_browser_permission_response(&id, &method, &params)
                    {
                        let result = response_value(&method, &params, &response);
                        match self.client.respond_server_request(id.clone(), result).await {
                            Ok(()) => continue,
                            Err(error) => {
                                tracing::warn!(
                                    %error,
                                    "failed to auto-allow trusted Cadencr browser MCP permission"
                                );
                            }
                        }
                    }
                    self.pending_requests.lock().await.insert(
                        request_key(&id),
                        PendingCodexRequest {
                            id: id.clone(),
                            method: method.clone(),
                            params: params.clone(),
                        },
                    );
                    let event = permission_request_event(&id, &method, &params);
                    if self.tx.send(Ok(event)).await.is_err() {
                        return;
                    }
                }
                Some(AppServerEvent::TransportError { message }) => {
                    self.pending_prompt_receipts.clear();
                    if self.closing.load(Ordering::SeqCst) {
                        return;
                    }
                    tracing::warn!(%message, "Codex app-server transport failed");
                    let _ = self
                        .tx
                        .send(Err(RuntimeError::new(format!(
                            "Codex app-server transport failed: {message}"
                        ))))
                        .await;
                    return;
                }
                Some(AppServerEvent::ProcessExited { status, signal }) => {
                    if self.closing.load(Ordering::SeqCst) {
                        return;
                    }
                    tracing::warn!(?status, ?signal, "Codex app-server exited");
                    let _ = self
                        .tx
                        .send(Err(RuntimeError::new("Codex app-server exited")))
                        .await;
                    return;
                }
                None => {
                    if self.closing.load(Ordering::SeqCst) {
                        return;
                    }
                    let _ = self
                        .tx
                        .send(Err(RuntimeError::new(
                            "Codex app-server event stream closed",
                        )))
                        .await;
                    return;
                }
            }
        }
    }
    async fn notification(
        &self,
        method: String,
        mut params: serde_json::Value,
        state: &mut NotificationState,
    ) -> bool {
        if super::event_turn_state::belongs_to_root_thread(&params, &self.turns.root_thread_id) {
            self.compaction.observe(&method, &params);
        }
        if method == "turn/started" {
            let thread_id = params
                .get("threadId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            // Codex multiplexes every thread (root + each
            // sub-agent) onto one stream; sub-agent turn/starteds
            // must not clobber the root's per-turn caches.
            if state.index_state.should_reset_for_turn_started(thread_id) {
                state.index_state.reset();
                state.command_outputs.clear();
            }
        }
        update_turn_state(
            &method,
            &params,
            &self.turns.active_turn_id,
            &self.turns.last_root_turn_id,
            &self.turns.root_thread_id,
        )
        .await;
        clear_resolved_request(&method, &params, &self.pending_requests).await;
        enrich_command_output(&method, &mut params, &mut state.command_outputs);
        if let Some(receipt_event) = self
            .pending_prompt_receipts
            .acknowledge_completed_user_message(&method, &params, &self.turns.root_thread_id)
        {
            if self.tx.send(Ok(receipt_event)).await.is_err() {
                return false;
            }
        }
        // A reroute of the root turn moves the model the rest of it runs on.
        if method == "model/rerouted" && params["threadId"] == self.turns.root_thread_id.as_str() {
            if let Some(model) = rerouted_model(&params) {
                *self.model.write().await = Some(model.to_string());
            }
        }
        let current_model = self.model.read().await.clone();
        let lifecycle_params = matches!(
            method.as_str(),
            "turn/started"
                | "turn/completed"
                | "thread/started"
                | "thread/closed"
                | "thread/status/changed"
        )
        .then(|| params.clone())
        .or_else(|| {
            (matches!(method.as_str(), "item/started" | "item/completed")
                && params["item"]["type"] == "subAgentActivity")
                .then(|| params.clone())
        });
        let recovery = recover_interacted_routes(
            &self.client,
            &method,
            &params,
            &self.turns.root_thread_id,
            &mut state.index_state,
            &mut state.lifecycle,
        );
        let mut events = recovery.await;
        events.extend(notification_events(
            &method,
            params,
            current_model.as_deref(),
            &mut state.index_state,
        ));
        if let Some(params) = lifecycle_params {
            state.lifecycle.apply(
                &method,
                &params,
                &self.turns.root_thread_id,
                &state.index_state,
                &mut events,
            );
            self.turns
                .child_turn_ids
                .write()
                .await
                .clone_from(&state.lifecycle.children);
        }
        for event in events {
            if async_question_id(&event).is_some()
                && !self.async_questions.lock().await.enqueue(&event)
            {
                continue;
            }
            if self.tx.send(Ok(event)).await.is_err() {
                return false;
            }
        }
        true
    }
}

async fn clear_resolved_request(
    method: &str,
    params: &serde_json::Value,
    pending_requests: &Arc<Mutex<HashMap<String, PendingCodexRequest>>>,
) {
    if method != "serverRequest/resolved" {
        return;
    }
    if let Some(request_id) = params.get("requestId") {
        pending_requests
            .lock()
            .await
            .remove(&request_key(request_id));
    }
}

fn enrich_command_output(
    method: &str,
    params: &mut serde_json::Value,
    command_outputs: &mut HashMap<String, String>,
) {
    match method {
        "item/commandExecution/outputDelta" | "command/exec/outputDelta" => {
            let Some(item_id) = params.get("itemId").and_then(serde_json::Value::as_str) else {
                return;
            };
            let delta = params
                .get("delta")
                .or_else(|| params.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let output = command_outputs.entry(item_id.to_string()).or_default();
            // Keep the completion fallback, but do not clone the growing output
            // into every delta: that makes large command streams quadratic.
            output.push_str(delta);
        }
        "item/completed" => enrich_completed_command(params, command_outputs),
        _ => {}
    }
}

fn enrich_completed_command(
    params: &mut serde_json::Value,
    command_outputs: &mut HashMap<String, String>,
) {
    let Some(item) = params
        .get_mut("item")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if item.get("type").and_then(serde_json::Value::as_str) != Some("commandExecution") {
        return;
    }
    let Some(item_id) = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    if !item.contains_key("aggregatedOutput") {
        if let Some(output) = command_outputs.get(&item_id) {
            item.insert(
                "aggregatedOutput".to_string(),
                serde_json::Value::String(output.clone()),
            );
        }
    }
    command_outputs.remove(&item_id);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use serde_json::json;
    use tokio::sync::Mutex;

    use super::super::event_system::request_key;
    use super::super::permissions::PendingCodexRequest;
    use super::{clear_resolved_request, enrich_command_output};

    #[tokio::test]
    async fn server_request_resolved_clears_matching_pending_request() {
        let request_id = json!("approval_1");
        let pending = Arc::new(Mutex::new(HashMap::from([(
            request_key(&request_id),
            PendingCodexRequest {
                id: request_id.clone(),
                method: "item/commandExecution/requestApproval".to_string(),
                params: json!({}),
            },
        )])));

        clear_resolved_request(
            "serverRequest/resolved",
            &json!({ "requestId": request_id }),
            &pending,
        )
        .await;

        assert!(pending.lock().await.is_empty());
    }

    #[test]
    fn command_output_deltas_are_attached_to_completed_command() {
        let mut outputs = HashMap::new();
        let mut first = json!({ "itemId": "cmd_1", "delta": "hello " });
        let mut second = json!({ "itemId": "cmd_1", "delta": "world" });
        enrich_command_output(
            "item/commandExecution/outputDelta",
            &mut first,
            &mut outputs,
        );
        enrich_command_output(
            "item/commandExecution/outputDelta",
            &mut second,
            &mut outputs,
        );

        assert!(first.get("aggregatedOutput").is_none());
        assert!(second.get("aggregatedOutput").is_none());

        let mut completed = json!({
            "item": {
                "type": "commandExecution",
                "id": "cmd_1",
                "command": "echo hello"
            }
        });
        enrich_command_output("item/completed", &mut completed, &mut outputs);

        assert_eq!(completed["item"]["aggregatedOutput"], json!("hello world"));
        assert!(outputs.is_empty());
    }
}
