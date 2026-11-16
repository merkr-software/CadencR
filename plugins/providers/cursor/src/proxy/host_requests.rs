//! Requests from Cadencr that the connector intercepts before Cursor.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::child::ChildConn;
use super::rpc::{await_response, RpcError, RpcResult};
use super::state::SessionState;
use super::{invalid_params, session_id_of, Proxy};
use crate::config_view::config_options_of;
use crate::extensions::plan::FOLLOWUP_PROMPT;

const AUTH_TIMEOUT: Duration = Duration::from_secs(60);

impl Proxy {
    pub(super) fn handle_host_request(self: &Arc<Self>, id: Value, method: String, params: Value) {
        let proxy = Arc::clone(self);
        match method.as_str() {
            "initialize" => self.respond_async(id, async move { proxy.initialize(params).await }),
            "session/new" => self.respond_async(id, async move { proxy.session_new(params).await }),
            "session/load" | "session/resume" => {
                self.respond_async(
                    id,
                    async move { proxy.session_restore(&method, params).await },
                )
            }
            "session/set_config_option" => {
                self.respond_async(id, async move { proxy.set_config_option(params).await })
            }
            "session/set_mode" => {
                self.respond_async(id, async move { proxy.set_mode(params).await })
            }
            "session/prompt" => self.prompt(id, params),
            _ => self.passthrough_to_child(id, &method, params),
        }
    }

    async fn initialize(&self, mut params: Value) -> RpcResult {
        advertise_client_capabilities(&mut params);
        self.state().host_init = Some(params.clone());
        let child = self.child();
        let result = child.peer.request("initialize", params).await?;
        authenticate(&child, &result).await?;
        self.state().child_init = Some(result.clone());
        Ok(result)
    }

    async fn session_new(&self, params: Value) -> RpcResult {
        let mut result = self
            .child()
            .peer
            .request("session/new", params.clone())
            .await?;
        let session_id = session_id_of(&result)
            .ok_or_else(|| RpcError::internal("Cursor `session/new` returned no sessionId"))?;
        self.catalog().await;
        let mut session = SessionState::from_params(&params);
        if let Some(options) = config_options_of(&result) {
            session.config.observe(&options);
        }
        {
            let mut state = self.state();
            state.sessions.insert(session_id.clone(), session);
            state.last_session = Some(session_id.clone());
        }
        self.rewrite_session_result(&session_id, &mut result);
        Ok(result)
    }

    /// Host-initiated `session/load` / `session/resume`: Cursor's replay is
    /// forwarded (normalized); the configuration is folded like `session/new`.
    async fn session_restore(&self, method: &str, params: Value) -> RpcResult {
        let session_id =
            session_id_of(&params).ok_or_else(|| invalid_params("`sessionId` is required"))?;
        {
            let mut state = self.state();
            let fresh = SessionState::from_params(&params);
            let session = state.sessions.entry(session_id.clone()).or_default();
            session.cwd = fresh.cwd;
            session.mcp_servers = fresh.mcp_servers;
            session.persisted = true;
            state.last_session = Some(session_id.clone());
        }
        let mut result = self.child().peer.request(method, params).await?;
        self.catalog().await;
        self.observe_child_options(&session_id, &result);
        self.rewrite_session_result(&session_id, &mut result);
        Ok(result)
    }

    /// Replace Cursor's options with the host view. The unstable `models`
    /// state would advertise Cursor's base ids next to the catalog selector.
    fn rewrite_session_result(&self, session_id: &str, result: &mut Value) {
        if !result.is_object() {
            *result = Value::Object(Map::new());
        }
        if let Some(object) = result.as_object_mut() {
            object.remove("models");
            object.insert(
                "configOptions".to_string(),
                Value::Array(self.host_options(session_id)),
            );
        }
    }

    async fn set_mode(&self, params: Value) -> RpcResult {
        let result = self
            .child()
            .peer
            .request("session/set_mode", params.clone())
            .await?;
        if let (Some(session_id), Some(mode)) = (
            session_id_of(&params),
            params.get("modeId").and_then(Value::as_str),
        ) {
            self.record_child_value(&session_id, "mode", json!(mode));
        }
        Ok(result)
    }

    /// The child request is written before returning, so a `session/cancel`
    /// the host sends right after the prompt reaches Cursor after it.
    fn prompt(self: &Arc<Self>, id: Value, params: Value) {
        let Some(session_id) = session_id_of(&params) else {
            self.host
                .respond(id, Err(invalid_params("`sessionId` is required")));
            return;
        };
        self.set_prompt_in_flight(&session_id, true);
        let first = self.child().peer.start_request("session/prompt", params);
        let proxy = Arc::clone(self);
        self.respond_async(id, async move {
            let first = await_response(first, "Cursor Agent").await;
            let result = proxy.finish_prompt_turn(&session_id, first).await;
            proxy.set_prompt_in_flight(&session_id, false);
            if result.is_ok() {
                proxy.mark_persisted(&session_id);
                proxy.apply_pending_access().await?;
            }
            result
        });
    }

    /// One host turn: the prompt, then — when Cursor's plan was approved
    /// during it — the execution follow-up, answered as a single result.
    async fn finish_prompt_turn(&self, session_id: &str, mut result: RpcResult) -> RpcResult {
        while self.take_plan_followup(session_id) {
            let cancelled = match &result {
                Ok(value) => value.get("stopReason").and_then(Value::as_str) == Some("cancelled"),
                Err(_) => true,
            };
            if cancelled {
                break;
            }
            result = self
                .child()
                .peer
                .request("session/prompt", followup_params(session_id))
                .await;
        }
        result
    }

    fn set_prompt_in_flight(&self, session_id: &str, in_flight: bool) {
        let mut state = self.state();
        if let Some(session) = state.sessions.get_mut(session_id) {
            session.prompt_in_flight = in_flight;
            if !in_flight {
                session.plan_followup = false;
            }
        }
    }

    fn mark_persisted(&self, session_id: &str) {
        if let Some(session) = self.state().sessions.get_mut(session_id) {
            session.persisted = true;
        }
    }

    fn take_plan_followup(&self, session_id: &str) -> bool {
        self.state()
            .sessions
            .get_mut(session_id)
            .is_some_and(|session| std::mem::take(&mut session.plan_followup))
    }

    pub(super) fn observe_child_options(&self, session_id: &str, payload: &Value) {
        let Some(options) = config_options_of(payload) else {
            return;
        };
        if let Some(session) = self.state().sessions.get_mut(session_id) {
            session.config.observe(&options);
        }
    }

    pub(super) fn record_child_value(&self, session_id: &str, config_id: &str, value: Value) {
        if let Some(session) = self.state().sessions.get_mut(session_id) {
            session.config.set_current(config_id, value);
        }
    }
}

pub(super) fn followup_params(session_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": FOLLOWUP_PROMPT }],
    })
}

/// Cursor exposes clean model ids plus `fast` / thought-level companions only
/// when the client advertises the parameterized model picker, and reports
/// sub-agent sessions (and the end of background runs) only to clients
/// advertising `subagents` (see `extensions/subagents.rs`).
fn advertise_client_capabilities(params: &mut Value) {
    if !params.is_object() {
        *params = json!({});
    }
    let capabilities = &mut params["clientCapabilities"];
    if !capabilities.is_object() {
        *capabilities = json!({});
    }
    let meta = &mut capabilities["_meta"];
    if !meta.is_object() {
        *meta = json!({});
    }
    meta["parameterizedModelPicker"] = Value::Bool(true);
    meta["subagents"] = Value::Bool(true);
    capabilities["subagents"] = Value::Bool(true);
}

/// Cursor requires `authenticate {methodId: "cursor_login"}` after
/// `initialize` when it advertises that method; it reuses `agent login`.
pub(super) async fn authenticate(
    child: &ChildConn,
    initialize_result: &Value,
) -> Result<(), RpcError> {
    if !advertises_cursor_login(initialize_result) {
        return Ok(());
    }
    child
        .peer
        .request_timeout(
            "authenticate",
            json!({ "methodId": "cursor_login" }),
            AUTH_TIMEOUT,
        )
        .await
        .map(|_| ())
        .map_err(|error| {
            RpcError::new(
                error.code,
                format!(
                    "Cursor authentication failed; run `agent login`: {}",
                    error.message
                ),
            )
        })
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
    use super::{advertise_client_capabilities, advertises_cursor_login, followup_params};
    use serde_json::json;

    #[test]
    fn detects_cursor_auth_method() {
        assert!(advertises_cursor_login(&json!({
            "authMethods": [{ "id": "cursor_login", "name": "Cursor" }]
        })));
        assert!(advertises_cursor_login(
            &json!({ "authMethods": [{ "methodId": "cursor_login" }] })
        ));
        assert!(!advertises_cursor_login(&json!({})));
    }

    #[test]
    fn injects_the_model_picker_and_subagent_capabilities() {
        let mut params = json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": true }, "_meta": { "x": 1 } }
        });
        advertise_client_capabilities(&mut params);
        assert_eq!(
            params["clientCapabilities"]["_meta"]["parameterizedModelPicker"],
            true
        );
        assert_eq!(params["clientCapabilities"]["_meta"]["x"], 1);
        assert_eq!(params["clientCapabilities"]["subagents"], true);
        assert_eq!(params["clientCapabilities"]["_meta"]["subagents"], true);
        assert_eq!(params["clientCapabilities"]["fs"]["readTextFile"], true);
        let mut bare = json!({ "protocolVersion": 1 });
        advertise_client_capabilities(&mut bare);
        assert_eq!(
            bare["clientCapabilities"]["_meta"]["parameterizedModelPicker"],
            true
        );
    }

    #[test]
    fn followup_is_a_plain_text_prompt() {
        let params = followup_params("s1");
        assert_eq!(
            params["prompt"][0]["text"],
            "Plan approved. Proceed with execution."
        );
    }
}
