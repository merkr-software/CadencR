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
    if let Err(error) = dispatch_permission_request_with_cache(
        client,
        &config.pending_permissions,
        &config.session_permissions,
        config.browser_trust,
        session_id,
        &request_id,
        id.clone(),
        permission,
        request.params(),
        tx,
    )
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
