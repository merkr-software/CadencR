use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use super::session_prompt::spawn_stream_reader;
use super::session_prompt::{PermissionResponse, WsBridgeCanUseTool};
use super::{send_error, QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimePermissionMode, RuntimeSessionHandle, RuntimeSpawnConfig,
};
use crate::domain::agents::runtime_adapter;
use crate::domain::ws_session::persistence::WsSessionPersistence;

pub(super) async fn spawn_pending_runtime_for_compact(
    envelope_id: &str,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    app_state: &AppState,
) -> Option<RuntimeSessionHandle> {
    let mut spawn = match pending_spawn_config(sdk_sessions, db_session_id, sender, app_state).await
    {
        PendingCompactSpawnResult::Ready(spawn) => spawn,
        PendingCompactSpawnResult::Busy => {
            send_error(
                sender,
                envelope_id,
                "COMPACT_REJECTED",
                "Manual compaction is already starting for this session",
            );
            return None;
        }
        PendingCompactSpawnResult::Missing => {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return None;
        }
        PendingCompactSpawnResult::NotPending => {
            send_error(
                sender,
                envelope_id,
                "COMPACT_REJECTED",
                "Session is not ready to start compaction",
            );
            return None;
        }
    };
    let adapter = match runtime_adapter(&spawn.provider_id) {
        Some(adapter) => adapter,
        None => {
            clear_compact_spawn_pending(sdk_sessions, db_session_id).await;
            send_error(
                sender,
                envelope_id,
                "UNSUPPORTED_PROVIDER",
                &format!(
                    "No runtime adapter registered for provider '{}'",
                    spawn.provider_id
                ),
            );
            return None;
        }
    };
    if let Some(ref sid) = spawn.options.resume_session_id {
        if !adapter.is_valid_resume_session_id(sid) {
            spawn.options.resume_session_id = None;
        }
    }

    let spawn_options = std::mem::take(&mut spawn.options);
    let mut runtime_session = match adapter.spawn(Value::Null, spawn_options).await {
        Ok(session) => session,
        Err(error) => {
            clear_compact_spawn_pending(sdk_sessions, db_session_id).await;
            send_error(sender, envelope_id, "SDK_SPAWN_ERROR", &error.to_string());
            return None;
        }
    };
    let provider_context_window = runtime_session.context_window();
    let runtime_control_endpoint = runtime_session.runtime_control_endpoint();
    if let Some(cw) = provider_context_window {
        WsSessionPersistence::update_context_window(&app_state.write_pool, db_session_id, Some(cw))
            .await;
    }
    let message_rx = runtime_session.take_message_rx();
    let query = Arc::new(tokio::sync::RwLock::new(runtime_session));
    if !activate_spawned_runtime(
        sdk_sessions,
        db_session_id,
        &spawn,
        query.clone(),
        runtime_control_endpoint,
    )
    .await
    {
        query.write().await.close().await;
        return None;
    }

    spawn_stream_reader(
        db_session_id,
        spawn.feature_id,
        message_rx,
        sender.clone(),
        app_state.ws_feature_senders.clone(),
        app_state.write_pool.clone(),
        app_state.session_status_tx.clone(),
        sdk_sessions.clone(),
        spawn.provider_id.clone(),
        spawn.spawned_model.as_deref(),
        provider_context_window,
        app_state.clone(),
        false,
    );
    Some(query)
}

struct PendingCompactSpawn {
    feature_id: i64,
    provider_id: String,
    permission_tx: mpsc::Sender<PermissionResponse>,
    spawned_model: Option<String>,
    spawned_permission_mode: Option<RuntimePermissionMode>,
    spawned_access_mode: Option<crate::domain::agents::adapter::RuntimeAccessMode>,
    spawned_thinking_effort: Option<String>,
    options: RuntimeSpawnConfig,
}

enum PendingCompactSpawnResult {
    Ready(PendingCompactSpawn),
    Busy,
    Missing,
    NotPending,
}

async fn pending_spawn_config(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    sender: &WsSender,
    app_state: &AppState,
) -> PendingCompactSpawnResult {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return PendingCompactSpawnResult::Missing;
    };
    let QueryState::Pending(pending) = &handle.state else {
        return PendingCompactSpawnResult::NotPending;
    };
    if handle
        .manual_compact_spawn_pending
        .swap(true, Ordering::SeqCst)
    {
        return PendingCompactSpawnResult::Busy;
    }
    let (permission_tx, permission_rx) = mpsc::channel::<PermissionResponse>(16);
    let resume_session_id = pending
        .resume_session_id
        .clone()
        .or_else(|| handle.resume_session_id.clone());
    let spawned_permission_mode = handle.desired_permission_mode.clone();
    let spawned_access_mode = handle.desired_access_mode.clone();
    let spawned_thinking_effort = handle.desired_thinking_effort.clone();
    let spawned_model = handle.desired_model.clone();
    let bridge = WsBridgeCanUseTool {
        sender: sender.clone(),
        feature_senders: app_state.ws_feature_senders.clone(),
        response_rx: Arc::new(Mutex::new(permission_rx)),
        feature_id: handle.feature_id,
        db_session_id,
        write_pool: app_state.write_pool.clone(),
        session_status_tx: app_state.session_status_tx.clone(),
        sdk_sessions: sdk_sessions.clone(),
    };
    PendingCompactSpawnResult::Ready(PendingCompactSpawn {
        feature_id: handle.feature_id,
        provider_id: handle.runtime_provider.clone(),
        permission_tx,
        spawned_model: spawned_model.clone(),
        spawned_permission_mode: spawned_permission_mode.clone(),
        spawned_access_mode: spawned_access_mode.clone(),
        spawned_thinking_effort: spawned_thinking_effort.clone(),
        options: RuntimeSpawnConfig {
            cwd: handle.config.cwd.clone(),
            permission_mode: spawned_permission_mode,
            access_mode: spawned_access_mode,
            model: spawned_model,
            thinking_effort: spawned_thinking_effort,
            system_prompt: handle.config.system_prompt.clone(),
            resume_session_id,
            allow_bypass_permissions: handle.config.allow_bypass_permissions,
            mcp_servers: pending.mcp_servers.clone(),
            permission_handler: Some(Arc::new(bridge)),
            env: handle.config.env.clone().or_else(|| pending.env.clone()),
        },
    })
}

async fn activate_spawned_runtime(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    spawn: &PendingCompactSpawn,
    query: RuntimeSessionHandle,
    runtime_control_endpoint: Option<String>,
) -> bool {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return false;
    };
    if !handle.manual_compact_spawn_pending.load(Ordering::SeqCst) {
        return false;
    }
    if !matches!(handle.state, QueryState::Pending(_)) {
        handle
            .manual_compact_spawn_pending
            .store(false, Ordering::SeqCst);
        return false;
    };
    handle.state = QueryState::Active {
        query,
        permission_tx: spawn.permission_tx.clone(),
    };
    handle.spawned_model = spawn.spawned_model.clone();
    handle.spawned_permission_mode = spawn.spawned_permission_mode.clone();
    handle.spawned_access_mode = spawn.spawned_access_mode.clone();
    handle.spawned_thinking_effort = spawn.spawned_thinking_effort.clone();
    handle.runtime_control_endpoint = runtime_control_endpoint;
    handle.resume_session_id = None;
    handle
        .manual_compact_spawn_pending
        .store(false, Ordering::SeqCst);
    true
}

async fn clear_compact_spawn_pending(sdk_sessions: &SdkSessions, db_session_id: i64) {
    let sessions = sdk_sessions.lock().await;
    if let Some(handle) = sessions.get(&db_session_id) {
        handle
            .manual_compact_spawn_pending
            .store(false, Ordering::SeqCst);
    }
}
