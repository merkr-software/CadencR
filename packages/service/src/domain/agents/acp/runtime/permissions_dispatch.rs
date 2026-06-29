//! Runtime-side helpers around the pending-permissions map: dispatching
//! incoming `session/request_permission` events upstream and draining the
//! map at session close.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, RwLock};

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimePermissionDecision,
    RuntimePermissionOption, RuntimePermissionRequest,
};

use super::schema_bridge::permission_response_value;
use super::session_permissions::PermissionKey;
use super::session_permissions::SessionPermissions;
use super::trusted_mcp_permissions::try_auto_allow_trusted_cadencr_browser_permission;

/// One pending `session/request_permission` server request awaiting the
/// user's decision. Tracks the raw ACP server-request id so we can echo the
/// response back to the agent.
#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub server_id: Value,
    pub request: RuntimePermissionRequest,
    pub params: Value,
}

/// Map keyed by Cadencr `request_id` (the ACP server-request id, stringified).
pub type PendingPermissions = Arc<RwLock<HashMap<String, PendingPermission>>>;

/// Surface a `session/request_permission` payload to the runtime channel as
/// a permission event the WS bridge can pick up via
/// `parse_permission_request` on the raw envelope.
pub fn permission_raw_event(request: &RuntimePermissionRequest, params: &Value) -> Value {
    json!({
        "type": "acp_permission_request",
        "transport": "acp",
        "request_id": request.request_id,
        "call_id": request.tool_use_id,
        "tool_name": request.tool_name,
        "tool_input": request.tool_input,
        "description": request.description,
        "preview": request.preview,
        "options": request.options.iter().map(permission_option_json).collect::<Vec<_>>(),
        "acp": params.clone(),
    })
}

pub fn permission_option_json(option: &RuntimePermissionOption) -> Value {
    // The wire string the FE consumes today is one of three values:
    // `allow_once`, `allow_future`, `deny`. `AllowForSession` is a
    // backend-only refinement of `AllowFuture` (different `optionId`
    // routing on the way back to ACP) so it shares the same wire
    // discriminant. Distinct labels & descriptions still let the FE
    // render two separate buttons when an agent advertises both kinds.
    let decision = match option.decision {
        RuntimePermissionDecision::AllowOnce => "allow_once",
        RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession => {
            "allow_future"
        }
        RuntimePermissionDecision::Deny => "deny",
    };
    json!({
        "decision": decision,
        "option_id": option.option_id,
        "label": option.label,
        "description": option.description,
        "collect_feedback": option.collect_feedback,
    })
}

/// Send a permission event upstream and stash the ACP server-request id in
/// the pending map so `respond_permission()` can answer later.
pub async fn dispatch_permission_request(
    pending: &PendingPermissions,
    session_id: Option<String>,
    request_id: &str,
    raw_id: Value,
    request: RuntimePermissionRequest,
    params: &Value,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<(), RuntimeError> {
    pending.write().await.insert(
        request_id.to_string(),
        PendingPermission {
            server_id: raw_id,
            request: request.clone(),
            params: params.clone(),
        },
    );
    let raw = permission_raw_event(&request, params);
    let metadata = RuntimeEventMetadata {
        session_id,
        usage: None,
        context_window: None,
        raw,
    };
    let event = RuntimeEvent::new(metadata, RuntimeEventKind::Other);
    if tx.send(Ok(event)).await.is_err() {
        pending.write().await.remove(request_id);
        return Err(RuntimeError::new(
            "ACP permission request could not be surfaced because the runtime channel is closed",
        ));
    }
    Ok(())
}

pub async fn dispatch_permission_request_with_cache(
    client: &AcpClient,
    pending: &PendingPermissions,
    session_permissions: &SessionPermissions,
    session_id: Option<String>,
    request_id: &str,
    raw_id: Value,
    request: RuntimePermissionRequest,
    params: &Value,
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) -> Result<(), RuntimeError> {
    if try_auto_allow_trusted_cadencr_browser_permission(client, raw_id.clone(), &request).await? {
        return Ok(());
    }

    let key = PermissionKey::new(&request.tool_name, &request.tool_input);
    if let Some(decision) = session_permissions.lookup(&key).await {
        if let Some(option_id) = option_id_for_decision(&request, decision) {
            let payload = permission_response_value(decision, Some(option_id), None);
            match client.respond_server_request(raw_id.clone(), payload).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        request_id,
                        "failed to preflight cached ACP permission; surfacing prompt"
                    );
                }
            }
        } else {
            tracing::debug!(
                request_id,
                ?decision,
                "cached ACP permission decision is not offered by this request; surfacing prompt"
            );
        }
    }

    dispatch_permission_request(pending, session_id, request_id, raw_id, request, params, tx).await
}

fn option_id_for_decision(
    request: &RuntimePermissionRequest,
    decision: RuntimePermissionDecision,
) -> Option<&str> {
    request
        .options
        .iter()
        .find(|option| option.decision == decision)
        .and_then(|option| option.option_id.as_deref())
}

/// Reject all pending permissions on session close — used to drain unanswered
/// requests so the agent receives explicit cancellation rather than a hang.
pub async fn reject_all_pending(client: &AcpClient, pending: &PendingPermissions) {
    let drained = {
        let mut pending = pending.write().await;
        pending
            .drain()
            .map(|(_, pending)| pending.server_id)
            .collect::<Vec<_>>()
    };
    for server_id in drained {
        if let Err(error) = client
            .reject_server_request(server_id, -32800, "session closed")
            .await
        {
            tracing::error!(%error, "failed to reject pending ACP permission on close");
        }
    }
}

/// Look up and remove a pending permission entry. Returns the raw ACP
/// server-request id so callers can route the response through the
/// `AcpClient`.
pub async fn take_pending(
    pending: &PendingPermissions,
    request_id: &str,
) -> Option<PendingPermission> {
    pending.write().await.remove(request_id)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::mpsc;

    use super::{dispatch_permission_request_with_cache, PendingPermissions, SessionPermissions};
    use crate::domain::agents::acp::runtime::session_permissions::PermissionKey;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo, AcpEvent};
    use crate::domain::agents::adapter::{
        RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionRequest,
    };

    async fn build_in_memory_client() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
        let (client_reads_stdout, agent_writes_stdout) = duplex(64 * 1024);
        let (agent_reads_stdin, client_writes_stdin) = duplex(64 * 1024);
        let client = AcpClient::spawn_with_streams(
            Box::new(client_writes_stdin),
            client_reads_stdout,
            tokio::io::empty(),
            AcpClientInfo::default(),
        )
        .await
        .unwrap();
        (
            client,
            agent_writes_stdout,
            BufReader::new(agent_reads_stdin),
        )
    }

    async fn write_frame(stdout: &mut DuplexStream, value: Value) {
        let mut frame = serde_json::to_vec(&value).unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
    }

    async fn read_frame(reader: &mut BufReader<DuplexStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    fn permission_request() -> RuntimePermissionRequest {
        RuntimePermissionRequest {
            request_id: "perm-cache".to_string(),
            tool_use_id: Some("call-cache".to_string()),
            tool_name: "Bash".to_string(),
            tool_input: json!({ "command": "pwd" }),
            description: Some("Run pwd".to_string()),
            preview: Some("pwd".to_string()),
            pattern: None,
            options: vec![RuntimePermissionOption {
                decision: RuntimePermissionDecision::AllowForSession,
                option_id: Some("session".to_string()),
                label: "Allow for this session".to_string(),
                description: "Allow matching calls this session".to_string(),
                collect_feedback: false,
            }],
        }
    }

    #[tokio::test]
    async fn cached_session_permission_answers_agent_without_prompt_event() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let mut subscriber = client.subscribe();
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0",
                "id": "perm-cache",
                "method": "session/request_permission",
                "params": {}
            }),
        )
        .await;
        let event = tokio::time::timeout(Duration::from_secs(1), subscriber.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event, AcpEvent::ServerRequest(_)));

        let request = permission_request();
        let session_permissions = SessionPermissions::new();
        session_permissions
            .record(
                PermissionKey::new(&request.tool_name, &request.tool_input),
                RuntimePermissionDecision::AllowForSession,
            )
            .await;
        let pending = PendingPermissions::default();
        let (tx, mut rx) = mpsc::channel(1);

        dispatch_permission_request_with_cache(
            &client,
            &pending,
            &session_permissions,
            Some("s-cache".to_string()),
            "perm-cache",
            json!("perm-cache"),
            request,
            &json!({}),
            &tx,
        )
        .await
        .unwrap();

        let response = tokio::time::timeout(Duration::from_secs(1), read_frame(&mut agent_stdin))
            .await
            .expect("cached permission should receive immediate ACP response");
        assert_eq!(response["id"], "perm-cache");
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "session");
        assert!(pending.read().await.is_empty());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn cached_session_permission_surfaces_prompt_when_option_missing() {
        let (client, _agent_stdout, _agent_stdin) = build_in_memory_client().await;
        let mut request = permission_request();
        request.options = vec![RuntimePermissionOption {
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: Some("allow_once".to_string()),
            label: "Allow once".to_string(),
            description: "Allow this call once".to_string(),
            collect_feedback: false,
        }];
        let session_permissions = SessionPermissions::new();
        session_permissions
            .record(
                PermissionKey::new(&request.tool_name, &request.tool_input),
                RuntimePermissionDecision::AllowForSession,
            )
            .await;
        let pending = PendingPermissions::default();
        let (tx, mut rx) = mpsc::channel(1);

        dispatch_permission_request_with_cache(
            &client,
            &pending,
            &session_permissions,
            Some("s-cache".to_string()),
            "perm-cache-missing-option",
            json!("perm-cache-missing-option"),
            request,
            &json!({}),
            &tx,
        )
        .await
        .unwrap();

        let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("prompt event should be surfaced")
            .expect("runtime channel should stay open")
            .expect("runtime event should be ok");
        assert_eq!(event.raw_json()["type"], "acp_permission_request");
        assert!(pending
            .read()
            .await
            .contains_key("perm-cache-missing-option"));
    }

    #[tokio::test]
    async fn closed_runtime_channel_removes_pending_permission_and_errors() {
        let (client, _agent_stdout, _agent_stdin) = build_in_memory_client().await;
        let pending = PendingPermissions::default();
        let session_permissions = SessionPermissions::new();
        let (tx, rx) = mpsc::channel(1);
        drop(rx);

        let error = dispatch_permission_request_with_cache(
            &client,
            &pending,
            &session_permissions,
            Some("s-closed".to_string()),
            "perm-closed",
            json!("perm-closed"),
            permission_request(),
            &json!({}),
            &tx,
        )
        .await
        .expect_err("closed runtime channel should surface an error");

        assert!(error.to_string().contains("runtime channel is closed"));
        assert!(pending.read().await.is_empty());
    }
}
