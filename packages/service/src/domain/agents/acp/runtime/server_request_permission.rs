//! `session/request_permission` dispatch for the ACP event loop: normalizes
//! the request through the provider hooks, enriches it with tool input the
//! loop already recorded, and surfaces it (or rejects it visibly).

use serde_json::Value;
use tokio::sync::mpsc;

use crate::domain::agents::acp::incoming::AcpServerRequest;
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};

use super::events_tool_call_metadata::is_empty_value;
use super::permission_tool_updates::emit_permission_tool_update;
use super::permissions::{
    derive_preview, dispatch_permission_request_with_cache, permission_request_from_server_request,
};
use super::server_requests::EventLoopConfig;

pub(super) async fn handle_permission_request(
    client: &AcpClient,
    id: Value,
    request: &AcpServerRequest,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    config: &EventLoopConfig,
) {
    let request_id = id
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| id.to_string());
    let parsed = permission_request_from_server_request(&request_id, request);
    let Some(mut permission) = parsed else {
        if let Err(error) = client
            .reject_server_request(id, -32602, "missing toolCall")
            .await
        {
            tracing::error!(%error, "failed to reject malformed ACP permission request");
        }
        return;
    };
    enrich_permission_from_recorded_tool_input(&mut permission, config);
    let normalized_name = config.hooks.normalize_tool_name(&permission.tool_name);
    permission.tool_name = normalized_name;
    permission.tool_input = config.hooks.normalize_tool_input(
        &permission.tool_name,
        std::mem::take(&mut permission.tool_input),
    );
    permission.preview = derive_preview(&permission.tool_input);
    let session_id = config.session_id.read().await.clone();
    if permission.tool_name.starts_with("mcp__") {
        emit_permission_tool_update(&permission, session_id.as_deref(), &config.indexer, tx).await;
    }
    let params = request.params();
    let tool = &permission.tool_name;
    let attached_option = if config.attached_mcp.allows_in_mode(tool, true)
        && verified_attachment(config, params, tool)
        && automatic_mcp_mode(config).await
    {
        one_time_option(params, session_id.as_deref(), tool)
    } else {
        None
    };
    if let Err(error) = dispatch_permission_request_with_cache()
        .client(client)
        .pending(&config.pending_permissions)
        .session_permissions(&config.session_permissions)
        .browser_trust(config.browser_trust)
        .maybe_attached_option(attached_option)
        .maybe_session_id(session_id)
        .request_id(&request_id)
        .raw_id(id.clone())
        .request(permission)
        .params(request.params())
        .tx(tx)
        .call()
        .await
    {
        tracing::error!(%error, "failed to surface ACP permission request");
        if let Err(reject_error) = client
            .reject_server_request(id, -32800, "permission request could not be surfaced")
            .await
        {
            tracing::error!(%reject_error, "failed to reject unsurfaced ACP permission request");
        }
    }
}

fn enrich_permission_from_recorded_tool_input(
    permission: &mut crate::domain::agents::adapter::RuntimePermissionRequest,
    config: &EventLoopConfig,
) {
    if !is_empty_value(&permission.tool_input) && permission.preview.is_some() {
        return;
    }
    let Some(tool_use_id) = permission.tool_use_id.as_deref() else {
        return;
    };
    let Some(recorded) = config
        .indexer
        .lock()
        .expect("EventIndexer poisoned")
        .tool_input_for(tool_use_id)
        .cloned()
    else {
        return;
    };
    if is_empty_value(&permission.tool_input) {
        permission.tool_input = recorded;
    }
    if permission.preview.is_none() {
        permission.preview = derive_preview(&permission.tool_input);
    }
}

fn one_time_option<'a>(params: &'a Value, session_id: Option<&str>, tool: &str) -> Option<&'a str> {
    if !tool.starts_with("mcp__")
        || session_id.is_none()
        || params["sessionId"].as_str() != session_id
        || params.pointer("/toolCall/name").and_then(Value::as_str) != Some(tool)
    {
        return None;
    }
    let options = params["options"].as_array()?;
    let mut once = options
        .iter()
        .filter(|option| option["kind"] == "allow_once");
    let id = once.next()?["optionId"].as_str()?;
    (!id.is_empty()
        && once.next().is_none()
        && options
            .iter()
            .filter(|other| other["optionId"] == id)
            .count()
            == 1)
        .then_some(id)
}

fn verified_attachment(config: &EventLoopConfig, params: &Value, tool: &str) -> bool {
    #[cfg(unix)]
    {
        params
            .pointer("/_meta/cadencr/attachedMcpApproval")
            .and_then(Value::as_str)
            == Some(tool)
            && tool
                .strip_prefix("mcp__")
                .and_then(|name| name.split_once("__"))
                .is_some_and(|(server, _)| config.connected_mcp.contains(server))
    }
    #[cfg(not(unix))]
    {
        let _ = (config, params, tool);
        false
    }
}

async fn automatic_mcp_mode(config: &EventLoopConfig) -> bool {
    use crate::domain::agents::adapter::{RuntimeAccessMode, RuntimePermissionMode};
    let snapshot = config.session_config.read().await;
    let mode = if let Some(id) = config.hooks.mode_config_id() {
        snapshot
            .select_current_value(&id)
            .and_then(|value| config.hooks.permission_mode_for_mode_id(value))
    } else {
        config
            .hooks
            .permission_mode_for_mode_id(&config.current_mode.read().await)
    };
    if mode == Some(RuntimePermissionMode::Plan) {
        return false;
    }
    mode == Some(RuntimePermissionMode::Auto)
        || config
            .hooks
            .access_mode_config(&RuntimeAccessMode::AutoReview)
            .is_some_and(|(id, value)| snapshot.select_current_value(&id) == Some(value.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn auto_approval_requires_the_current_session_and_an_explicit_one_time_option() {
        let tool = "mcp__cadencr-workspace__workspace_list_projects";
        let mut params = json!({"sessionId":"s","toolCall":{"name":tool},"options":[{"kind":"allow_once","optionId":"ok"}]});
        assert_eq!(one_time_option(&params, Some("s"), tool), Some("ok"));
        assert!(one_time_option(&params, Some("other"), tool).is_none());
        assert!(one_time_option(&params, Some("s"), "Bash").is_none());
        params["options"][0]["kind"] = "allow_always".into();
        assert!(one_time_option(&params, Some("s"), tool).is_none());
        params["options"]
            .as_array_mut()
            .unwrap()
            .push(json!({"kind":"allow_once","optionId":"ok"}));
        assert!(one_time_option(&params, Some("s"), tool).is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn attached_mcp_selects_the_native_id_until_the_session_enters_plan() {
        use super::super::{
            provider_hooks::AcpProviderHooks,
            server_request_event_loop_tests::{
                client_with_agent_io, event_loop_config, read_agent_response, write_agent_request,
            },
            server_requests::spawn_event_loop,
            session_config::{snapshot_from_options, AcpSessionConfigState},
        };
        use crate::domain::{
            agents::adapter::{RuntimeMcpServerConfig, RuntimePermissionMode},
            mcp::{
                connection::Connections,
                trusted::{test_support::injected_servers, CadencrMcpTrust},
            },
        };
        use agent_client_protocol::schema::v1::{SessionConfigOption, SessionConfigSelectOption};
        use std::sync::Arc;
        struct Modes;
        #[async_trait::async_trait]
        impl AcpProviderHooks for Modes {
            fn normalize_tool_name(&self, name: &str) -> String {
                name.into()
            }
            fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
                input
            }
            fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
                None
            }
            fn mode_config_id(&self) -> Option<String> {
                Some("mode".into())
            }
            fn permission_mode_for_mode_id(&self, mode: &str) -> Option<RuntimePermissionMode> {
                match mode {
                    "auto" => Some(RuntimePermissionMode::Auto),
                    "plan" => Some(RuntimePermissionMode::Plan),
                    _ => None,
                }
            }
        }
        let mut servers = injected_servers(&["workspace"]);
        let trust = CadencrMcpTrust::injected_in(Some(&servers));
        let connections = Connections::attach(Some(&mut servers));
        let RuntimeMcpServerConfig::Stdio { env: Some(env), .. } = &servers["cadencr-workspace"]
        else {
            panic!("missing socket")
        };
        let _stream = tokio::net::UnixStream::connect(&env["CADENCR_MCP_STATUS_SOCKET"])
            .await
            .unwrap();
        let mut cfg = event_loop_config("/tmp".into());
        cfg.connected_mcp = connections.observed();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !cfg.connected_mcp.contains("cadencr-workspace") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        cfg.hooks = Arc::new(Modes);
        cfg.session_config = AcpSessionConfigState::new(
            snapshot_from_options(&[SessionConfigOption::select(
                "mode",
                "Mode",
                "auto",
                vec![
                    SessionConfigSelectOption::new("auto", "Auto"),
                    SessionConfigSelectOption::new("plan", "Plan"),
                ],
            )]),
            cfg.hooks.clone(),
        );
        cfg.attached_mcp = trust;
        cfg.browser_trust = trust;
        let (client, mut stdout, mut stdin) = client_with_agent_io().await;
        let (tx, mut rx) = mpsc::channel(32);
        let _loop = spawn_event_loop(client.clone(), client.subscribe_reliable(), tx, cfg);
        let tool = "mcp__cadencr-workspace__workspace_list_projects";
        let mut req = json!({"jsonrpc":"2.0", "id":"first","method":"session/request_permission","params":{
            "sessionId":"s-1","_meta":{"cadencr":{"attachedMcpApproval":tool}},
            "toolCall":{"toolCallId":"call","name":tool,"title":tool,"kind":"other","rawInput":{}},
            "options":[{"optionId":"persistent","name":"Always","kind":"allow_always"},{"optionId":"native-once","name":"Once","kind":"allow_once"}]
        }});
        write_agent_request(&mut stdout, req.clone()).await;
        assert_eq!(
            read_agent_response(&mut stdin).await["result"]["outcome"]["optionId"],
            "native-once"
        );
        for (id, plan) in [("unverified", false), ("in-plan", true)] {
            req["id"] = id.into();
            if plan {
                write_agent_request(&mut stdout, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"current_mode_update","currentModeId":"plan"}}})).await;
                write_agent_request(&mut stdout, json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"child","update":{"sessionUpdate":"current_mode_update","currentModeId":"auto"}}})).await;
                req["params"]["_meta"] = json!({"cadencr":{"attachedMcpApproval":tool}});
            } else {
                req["params"]["_meta"] = json!({});
            }
            write_agent_request(&mut stdout, req.clone()).await;
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let event = rx.recv().await.unwrap().unwrap();
                    if event.raw_json()["type"] == "acp_permission_request" {
                        assert_eq!(event.raw_json()["request_id"], id);
                        break;
                    }
                }
            })
            .await
            .expect("the native request should reach the user");
        }
    }
}
