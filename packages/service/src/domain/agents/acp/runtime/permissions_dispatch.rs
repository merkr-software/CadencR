//! Runtime-side helpers around the pending-permissions map: dispatching
//! incoming `session/request_permission` events upstream and draining the
//! map at session close.

use std::collections::HashMap;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimePermissionDecision,
    RuntimePermissionRequest, RuntimePermissionResponse, RuntimePermissionResponseKind,
};

use super::permission_events::permission_raw_event;
use super::permissions::acp_permission_response_payload;
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
/// A synchronous lock: guards are never held across an `.await`, and the
/// response-kind lookup (`AgentRuntimeSession::permission_response_kind`) is
/// synchronous.
pub type PendingPermissions = Arc<RwLock<HashMap<String, PendingPermission>>>;

pub(super) fn read_pending(
    pending: &PendingPermissions,
) -> RwLockReadGuard<'_, HashMap<String, PendingPermission>> {
    pending
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn write_pending(
    pending: &PendingPermissions,
) -> RwLockWriteGuard<'_, HashMap<String, PendingPermission>> {
    pending
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Host convention: a standard permission request whose tool is
/// `ExitPlanMode` is a plan-approval gate, whichever provider raised it.
/// Rejecting it keeps the agent planning instead of ending the turn.
pub fn pending_permission_response_kind(
    pending: &PendingPermissions,
    request_id: &str,
) -> RuntimePermissionResponseKind {
    match read_pending(pending).get(request_id) {
        Some(entry) if entry.request.tool_name == "ExitPlanMode" => {
            RuntimePermissionResponseKind::PlanApproval
        }
        _ => RuntimePermissionResponseKind::Normal,
    }
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
    write_pending(pending).insert(
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
        write_pending(pending).remove(request_id);
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

/// Encode the user's answer to a pending request. A response without an
/// explicit option (question answers and plan gates carry only a decision)
/// selects the option the agent offered for that decision, so the agent sees
/// one of its own ids instead of a canonical fallback.
pub fn pending_permission_response_payload(
    pending: &PendingPermission,
    response: &RuntimePermissionResponse,
) -> Value {
    if response.option_id.is_some() {
        return acp_permission_response_payload(response);
    }
    let mut response = response.clone();
    response.option_id =
        option_id_for_decision(&pending.request, response.decision).map(ToOwned::to_owned);
    acp_permission_response_payload(&response)
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
        let mut pending = write_pending(pending);
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
    write_pending(pending).remove(request_id)
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

    #[test]
    fn decision_only_answers_select_the_offered_option_and_carry_updated_input() {
        use super::{pending_permission_response_payload, PendingPermission};
        use crate::domain::agents::adapter::RuntimePermissionResponse;

        let pending = PendingPermission {
            server_id: json!("q-1"),
            request: permission_request(),
            params: json!({}),
        };
        let mut answer = RuntimePermissionResponse {
            request_id: "q-1".to_string(),
            decision: RuntimePermissionDecision::AllowForSession,
            option_id: None,
            feedback: None,
            updated_input: Some(json!({ "answers": { "Color?": "Blue" } })),
        };
        let payload = pending_permission_response_payload(&pending, &answer);
        assert_eq!(payload["outcome"]["optionId"], "session");
        assert_eq!(
            payload["_meta"]["updatedInput"]["answers"]["Color?"],
            "Blue"
        );

        answer.option_id = Some("explicit".to_string());
        let payload = pending_permission_response_payload(&pending, &answer);
        assert_eq!(payload["outcome"]["optionId"], "explicit");

        // No offered option for the decision: the canonical id is the fallback.
        answer.option_id = None;
        answer.decision = RuntimePermissionDecision::Deny;
        let payload = pending_permission_response_payload(&pending, &answer);
        assert_eq!(payload["outcome"]["optionId"], "reject_once");
    }

    #[test]
    fn exit_plan_mode_requests_are_plan_approval_gates() {
        use super::{pending_permission_response_kind, write_pending, PendingPermission};
        use crate::domain::agents::adapter::RuntimePermissionResponseKind;

        let pending = PendingPermissions::default();
        for (request_id, tool_name) in [("plan-1", "ExitPlanMode"), ("bash-1", "Bash")] {
            let mut request = permission_request();
            request.tool_name = tool_name.to_string();
            write_pending(&pending).insert(
                request_id.to_string(),
                PendingPermission {
                    server_id: json!(request_id),
                    request,
                    params: json!({}),
                },
            );
        }

        assert_eq!(
            pending_permission_response_kind(&pending, "plan-1"),
            RuntimePermissionResponseKind::PlanApproval
        );
        assert_eq!(
            pending_permission_response_kind(&pending, "bash-1"),
            RuntimePermissionResponseKind::Normal
        );
        assert_eq!(
            pending_permission_response_kind(&pending, "unknown"),
            RuntimePermissionResponseKind::Normal
        );
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
        assert!(super::read_pending(&pending).is_empty());
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
        assert!(super::read_pending(&pending).contains_key("perm-cache-missing-option"));
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
        assert!(super::read_pending(&pending).is_empty());
    }
}
