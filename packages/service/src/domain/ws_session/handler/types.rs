//! Per-connection types: the in-memory `SdkHandle` table that backs the
//! WebSocket session, the runtime-session state machine, and the small
//! type aliases that wrap the channels and locks.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, Mutex};

use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimePermissionMode, RuntimeSessionHandle, RuntimeSpawnConfig,
};

use super::session_prompt;

/// State of the SDK query for a session.
pub(super) enum QueryState {
    /// Session initialized but no prompt sent yet. Stores the runtime config to use when spawning.
    Pending(RuntimeSpawnConfig),
    /// Query is active (CLI subprocess running).
    Active {
        query: RuntimeSessionHandle,
        permission_tx: mpsc::Sender<session_prompt::PermissionResponse>,
    },
}

/// Serializable session config for respawning with --resume after model change.
#[derive(Clone)]
pub(super) struct SessionConfig {
    pub(super) cwd: PathBuf,
    /// Pre-canonicalized worktree path for permission checks (avoids repeated syscalls).
    pub(super) canonical_cwd: PathBuf,
    pub(super) permission_mode: Option<RuntimePermissionMode>,
    pub(super) access_mode: Option<RuntimeAccessMode>,
    pub(super) thinking_effort: Option<String>,
    pub(super) system_prompt: Option<String>,
    pub(super) allow_bypass_permissions: bool,
    pub(super) claude_profile: Option<String>,
    /// Extra env vars to inject when respawning the CLI (e.g. an active
    /// Claude Code profile). Carried through resume transitions so the
    /// process always sees the profile the user selected.
    pub(super) env: Option<std::collections::HashMap<String, String>>,
}

/// Handle for a running SDK session, stored per-connection.
/// Keyed by `i64` (agent_sessions.id). DB is the source of truth for session
/// config; memory holds only live process state and ephemeral tracking.
pub struct SdkHandle {
    pub(super) state: QueryState,
    /// feature_id for persistence lookups.
    pub(super) feature_id: i64,
    /// Active runtime provider for this session handle.
    pub(super) runtime_provider: String,
    /// The model the user wants for the next turn. Updated by model.set.
    pub(super) desired_model: Option<String>,
    /// The model the CLI was actually spawned with.
    pub(super) spawned_model: Option<String>,
    /// The permission mode the user wants. Updated by mode.set.
    pub(super) desired_permission_mode: Option<RuntimePermissionMode>,
    /// The permission mode the CLI was actually spawned with.
    pub(super) spawned_permission_mode: Option<RuntimePermissionMode>,
    pub(super) desired_access_mode: Option<RuntimeAccessMode>,
    pub(super) spawned_access_mode: Option<RuntimeAccessMode>,
    /// Thinking effort to apply on the next turn when supported by the model.
    pub(super) desired_thinking_effort: Option<String>,
    /// Thinking effort the runtime was last spawned with.
    pub(super) spawned_thinking_effort: Option<String>,
    /// Claude profile the user wants for the next Claude process spawn.
    pub(super) desired_claude_profile: Option<String>,
    /// Claude profile the active runtime was last spawned with.
    pub(super) spawned_claude_profile: Option<String>,
    /// Provider-local control endpoint for runtimes with a sidecar HTTP API.
    /// Currently populated by live runtime adapters when available;
    /// retained on the struct so the wider session-handle plumbing keeps
    /// compiling, but no remaining code path reads it. Drop once a follow-up
    /// removes the `runtime_control_endpoint` field from `SdkHandle` setters.
    pub(super) runtime_control_endpoint: Option<String>,
    /// Claude CLI session ID to use for --resume on the first prompt.
    /// Set from the DB row at init time; consumed (taken) when spawning.
    pub(super) resume_session_id: Option<String>,
    /// Config for respawning with --resume after model/mode change.
    pub(super) config: SessionConfig,
    pub(super) manual_compact_cancel: Arc<AtomicBool>,
    pub(super) manual_compact_spawn_pending: Arc<AtomicBool>,
}

pub(crate) type SdkSessions = Arc<Mutex<HashMap<i64, SdkHandle>>>;
pub(super) type WsSender = mpsc::UnboundedSender<Message>;

pub(crate) fn new_sdk_sessions() -> SdkSessions {
    Arc::new(Mutex::new(HashMap::new()))
}
