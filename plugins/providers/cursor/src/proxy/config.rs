//! `session/set_config_option` from the host: catalog model ids decompose into
//! Cursor's base model + companions, `access` is connector-owned, and every
//! other option is forwarded.

use std::sync::Arc;

use serde_json::{json, Value};

use super::rpc::{RpcError, RpcResult};
use super::{invalid_params, session_id_of, Proxy};
use crate::access::ACCESS_CONFIG_ID;

impl Proxy {
    pub(super) async fn set_config_option(self: &Arc<Self>, params: Value) -> RpcResult {
        let session_id =
            session_id_of(&params).ok_or_else(|| invalid_params("`sessionId` is required"))?;
        let config_id = params
            .get("configId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_params("`configId` is required"))?
            .to_string();
        let value = params.get("value").cloned().unwrap_or(Value::Null);
        match config_id.as_str() {
            "model" => {
                let model = value
                    .as_str()
                    .ok_or_else(|| invalid_params("the `model` value must be a string"))?;
                self.apply_model(&session_id, model).await?;
            }
            ACCESS_CONFIG_ID => {
                let access = value
                    .as_str()
                    .ok_or_else(|| invalid_params("the `access` value must be a string"))?;
                self.change_access(access).await?;
            }
            _ => {
                self.child_set_option(&session_id, &config_id, value)
                    .await?;
            }
        }
        Ok(json!({ "configOptions": self.host_options(&session_id) }))
    }

    /// Apply a catalog model id: set Cursor's base model, then re-resolve the
    /// companions from the model-change response (a model without `fast`
    /// must not receive a stale `fast`) and set each of them.
    pub(super) async fn apply_model(&self, session_id: &str, model: &str) -> Result<(), RpcError> {
        let value = self.with_session(session_id, |session| {
            session.config.model_state.model_config_value(model)
        })?;
        self.child_set_option(session_id, "model", json!(value))
            .await?;
        let companions = self.with_session(session_id, |session| {
            session.config.model_state.companions(model)
        })?;
        for (config_id, value) in companions {
            self.child_set_option(session_id, &config_id, value.to_json())
                .await?;
        }
        self.with_session(session_id, |session| {
            session.config.applied_model = Some(model.to_string());
        })
    }

    async fn child_set_option(&self, session_id: &str, config_id: &str, value: Value) -> RpcResult {
        let params = json!({ "sessionId": session_id, "configId": config_id, "value": value });
        let result = self
            .child()
            .peer
            .request("session/set_config_option", params)
            .await?;
        if result.get("configOptions").is_some() {
            self.observe_child_options(session_id, &result);
        } else {
            self.record_child_value(session_id, config_id, value);
        }
        Ok(result)
    }

    /// Switch Cursor's mode through `session/set_mode` and mirror it locally.
    pub(super) async fn child_set_mode(
        &self,
        session_id: &str,
        mode: &str,
    ) -> Result<(), RpcError> {
        self.child()
            .peer
            .request(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode }),
            )
            .await?;
        self.record_child_value(session_id, "mode", json!(mode));
        Ok(())
    }

    fn with_session<T>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut super::state::SessionState) -> T,
    ) -> Result<T, RpcError> {
        let mut state = self.state();
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| invalid_params(&format!("unknown session `{session_id}`")))?;
        Ok(f(session))
    }
}
