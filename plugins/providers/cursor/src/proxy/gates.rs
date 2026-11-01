//! Blocking Cursor extensions that need the user: `cursor/ask_question` and
//! `cursor/create_plan`. Each is announced as a standard tool call, then
//! asked through a host `session/request_permission` carrying the same call.

use std::sync::Arc;

use serde_json::{json, Value};

use super::child::ChildConn;
use super::host_requests::followup_params;
use super::rpc::RpcError;
use super::{invalid_params, text_chunk, Proxy};
use crate::extensions::plan::{self, APPROVE_OPTION_ID};
use crate::extensions::question::{self, SUBMIT_OPTION_ID};
use crate::extensions::{gate_options, gate_tool_call, tool_call_id, HostDecision};

struct Gate {
    session_id: String,
    tool_call_id: String,
    tool_call: Value,
}

impl Proxy {
    fn open_gate(
        &self,
        params: &Value,
        name: &str,
        prefix: &str,
        title: String,
        kind: &str,
        input: Value,
    ) -> Option<Gate> {
        let (session_id, call_id) = {
            let mut state = self.state();
            let session_id = state.session_for(params)?;
            let call_id = tool_call_id(params, || state.synthetic_id(prefix));
            state.tools.record(&call_id, name);
            (session_id, call_id)
        };
        let tool_call = gate_tool_call(&call_id, name, &title, kind, &input);
        let mut update = tool_call.clone();
        if let Some(update) = update.as_object_mut() {
            update.remove("toolName");
            update.insert("sessionUpdate".to_string(), json!("tool_call"));
        }
        self.host.notify(
            "session/update",
            json!({ "sessionId": session_id, "update": update }),
        );
        Some(Gate {
            session_id,
            tool_call_id: call_id,
            tool_call,
        })
    }

    fn close_gate(&self, gate: &Gate) {
        self.host.notify(
            "session/update",
            json!({
                "sessionId": gate.session_id,
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": gate.tool_call_id,
                    "status": "completed",
                },
            }),
        );
    }

    pub(super) async fn ask_question(
        self: Arc<Self>,
        conn: Arc<ChildConn>,
        id: Value,
        params: Value,
    ) {
        let input = question::tool_input(&params);
        let title = question::title(&params);
        let Some(gate) = self.open_gate(
            &params,
            "AskUserQuestion",
            "question",
            title,
            "other",
            input,
        ) else {
            conn.peer.respond(
                id,
                Err(invalid_params(
                    "cursor/ask_question arrived without a session",
                )),
            );
            return;
        };
        let request = json!({
            "sessionId": gate.session_id,
            "toolCall": gate.tool_call,
            "options": gate_options(SUBMIT_OPTION_ID, "Submit answers"),
        });
        let reply = self
            .host
            .request("session/request_permission", request)
            .await
            .map(|response| {
                question::response(
                    &params,
                    &HostDecision::from_response(&response, SUBMIT_OPTION_ID),
                )
            });
        conn.peer.respond(id, reply);
        self.close_gate(&gate);
    }

    /// The JSON-RPC id of the host request is the plan's `toolCallId`, which
    /// lets Cadencr pair the approval with the `ExitPlanMode` call.
    pub(super) async fn create_plan(
        self: Arc<Self>,
        conn: Arc<ChildConn>,
        id: Value,
        params: Value,
    ) {
        let input = plan::tool_input(&params);
        let title = plan::title(&params);
        let Some(gate) =
            self.open_gate(&params, "ExitPlanMode", "plan", title, "switch_mode", input)
        else {
            conn.peer.respond(
                id,
                Err(invalid_params(
                    "cursor/create_plan arrived without a session",
                )),
            );
            return;
        };
        let request = json!({
            "sessionId": gate.session_id,
            "toolCall": gate.tool_call,
            "options": gate_options(APPROVE_OPTION_ID, "Approve plan"),
        });
        let response = self
            .host
            .request_with_id(
                json!(gate.tool_call_id),
                "session/request_permission",
                request,
            )
            .await;
        let decision = match response {
            Ok(response) => HostDecision::from_response(&response, APPROVE_OPTION_ID),
            Err(error) => {
                conn.peer.respond(id, Err(error));
                self.close_gate(&gate);
                return;
            }
        };
        if decision.approved {
            self.enter_agent_mode(&gate.session_id).await;
        }
        conn.peer.respond(id, Ok(plan::response(&decision)));
        self.close_gate(&gate);
    }

    /// Before Cursor learns the plan was accepted: switch it to `agent`,
    /// tell the host, and queue the execution follow-up for this turn.
    async fn enter_agent_mode(self: &Arc<Self>, session_id: &str) {
        if let Err(error) = self.child_set_mode(session_id, "agent").await {
            self.report(session_id, &error);
        }
        self.host.notify(
            "session/update",
            json!({
                "sessionId": session_id,
                "update": { "sessionUpdate": "current_mode_update", "currentModeId": "agent" },
            }),
        );
        self.host.notify(
            "session/update",
            json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": self.host_options(session_id),
                },
            }),
        );
        let queued = self
            .state()
            .sessions
            .get_mut(session_id)
            .filter(|session| session.prompt_in_flight)
            .map(|session| session.plan_followup = true)
            .is_some();
        if queued {
            return;
        }
        // No host turn to extend (Cursor planned outside a prompt): run the
        // follow-up on its own so the approval is still acted on.
        let proxy = Arc::clone(self);
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            let result = proxy
                .child()
                .peer
                .request("session/prompt", followup_params(&session_id))
                .await;
            if let Err(error) = result {
                proxy.report(&session_id, &error);
            }
        });
    }

    /// Surface a connector-side failure in the conversation itself.
    fn report(&self, session_id: &str, error: &RpcError) {
        eprintln!("cursor connector: {}", error.message);
        self.host.notify(
            "session/update",
            text_chunk(
                session_id,
                &format!(
                    "\n\nCadencr could not continue Cursor's approved plan: {}\n",
                    error.message
                ),
            ),
        );
    }
}
