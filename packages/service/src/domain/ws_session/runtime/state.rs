//! Service-owned runtime state, independent of any observing connection.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, Mutex};

use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimePermissionMode, RuntimeSessionHandle, RuntimeSpawnConfig,
};

use super::prompt as session_prompt;

/// State of the SDK query for a session.
pub(in crate::domain::ws_session) enum QueryState {
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
pub(in crate::domain::ws_session) struct SessionConfig {
    pub(in crate::domain::ws_session) cwd: PathBuf,
    /// Pre-canonicalized worktree path for permission checks (avoids repeated syscalls).
    pub(in crate::domain::ws_session) canonical_cwd: PathBuf,
    pub(in crate::domain::ws_session) permission_mode: Option<RuntimePermissionMode>,
    pub(in crate::domain::ws_session) access_mode: Option<RuntimeAccessMode>,
    pub(in crate::domain::ws_session) thinking_effort: Option<String>,
    pub(in crate::domain::ws_session) fast_mode: bool,
    pub(in crate::domain::ws_session) system_prompt: Option<String>,
    pub(in crate::domain::ws_session) allow_bypass_permissions: bool,
    pub(in crate::domain::ws_session) claude_profile: Option<String>,
    /// Extra env vars to inject when respawning the CLI (e.g. an active
    /// Claude Code profile). Carried through resume transitions so the
    /// process always sees the profile the user selected.
    pub(in crate::domain::ws_session) env: Option<std::collections::HashMap<String, String>>,
    pub(in crate::domain::ws_session) env_unset: Vec<String>,
    pub(in crate::domain::ws_session) overrides:
        crate::domain::agents::adapter::RuntimeConfigOverrides,
    pub(in crate::domain::ws_session) runtime_overrides_dirty: bool,
    pub(in crate::domain::ws_session) profile_revision: Option<String>,
    pub(in crate::domain::ws_session) profile_state_identity: Option<String>,
}

impl SessionConfig {
    pub(in crate::domain::ws_session) fn from_runtime(
        runtime: &RuntimeSpawnConfig,
        claude_profile: Option<String>,
    ) -> Self {
        Self {
            cwd: runtime.cwd.clone(),
            canonical_cwd: crate::domain::ws_session::permissions::canonicalize_worktree(
                &runtime.cwd,
            ),
            permission_mode: runtime.permission_mode.clone(),
            access_mode: runtime.access_mode.clone(),
            thinking_effort: runtime.thinking_effort.clone(),
            fast_mode: runtime.fast_mode,
            system_prompt: runtime.system_prompt.clone(),
            allow_bypass_permissions: runtime.allow_bypass_permissions,
            claude_profile,
            env: runtime.env.clone(),
            env_unset: runtime.env_unset.clone(),
            overrides: runtime.overrides.clone(),
            runtime_overrides_dirty: false,
            profile_revision: runtime.profile_revision.clone(),
            profile_state_identity: runtime.profile_state_identity.clone(),
        }
    }
}

/// Identifies one initialized handle across asynchronous runtime launch work.
#[derive(Clone, Default)]
pub(in crate::domain::ws_session) struct RuntimeHandleIdentity(Arc<RuntimeHandleActivity>);

#[derive(Default)]
struct RuntimeHandleActivity {
    deliveries: AtomicUsize,
}

/// Protects an Active runtime selected for delivery before preflight begins.
/// Acquire while holding its session cell; idle retirement checks under it too.
pub(in crate::domain::ws_session) struct RuntimeDeliveryLease(Arc<RuntimeHandleActivity>);

impl Drop for RuntimeDeliveryLease {
    fn drop(&mut self) {
        self.0.deliveries.fetch_sub(1, Ordering::SeqCst);
    }
}

impl RuntimeHandleIdentity {
    pub(in crate::domain::ws_session) fn begin_delivery(&self) -> RuntimeDeliveryLease {
        self.0.deliveries.fetch_add(1, Ordering::SeqCst);
        RuntimeDeliveryLease(self.0.clone())
    }

    pub(in crate::domain::ws_session) fn has_pending_delivery(&self) -> bool {
        self.0.deliveries.load(Ordering::SeqCst) != 0
    }

    pub(in crate::domain::ws_session) fn same_instance(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// Handle for a running SDK session, owned by the service runtime registry.
/// Keyed by `i64` (agent_sessions.id). DB is the source of truth for session
/// config; memory holds only live process state and ephemeral tracking.
pub struct SdkHandle {
    pub(in crate::domain::ws_session) identity: RuntimeHandleIdentity,
    pub(in crate::domain::ws_session) state: QueryState,
    /// feature_id for persistence lookups.
    pub(in crate::domain::ws_session) feature_id: i64,
    /// Active runtime provider for this session handle.
    pub(in crate::domain::ws_session) runtime_provider: String,
    /// The model the user wants for the next turn. Updated by model.set.
    pub(in crate::domain::ws_session) desired_model: Option<String>,
    /// The model the CLI was actually spawned with.
    pub(in crate::domain::ws_session) spawned_model: Option<String>,
    /// The permission mode the user wants. Updated by mode.set.
    pub(in crate::domain::ws_session) desired_permission_mode: Option<RuntimePermissionMode>,
    /// The permission mode the CLI was actually spawned with.
    pub(in crate::domain::ws_session) spawned_permission_mode: Option<RuntimePermissionMode>,
    pub(in crate::domain::ws_session) desired_access_mode: Option<RuntimeAccessMode>,
    pub(in crate::domain::ws_session) spawned_access_mode: Option<RuntimeAccessMode>,
    /// Thinking effort to apply on the next turn when supported by the model.
    pub(in crate::domain::ws_session) desired_thinking_effort: Option<String>,
    /// Thinking effort the runtime was last spawned with.
    pub(in crate::domain::ws_session) spawned_thinking_effort: Option<String>,
    /// Claude profile the user wants for the next Claude process spawn.
    pub(in crate::domain::ws_session) desired_claude_profile: Option<String>,
    /// Claude profile the active runtime was last spawned with.
    pub(in crate::domain::ws_session) spawned_claude_profile: Option<String>,
    /// Provider-local control endpoint for runtimes with a sidecar HTTP API.
    /// Currently populated by live runtime adapters when available;
    /// retained on the struct so the wider session-handle plumbing keeps
    /// compiling, but no remaining code path reads it. Drop once a follow-up
    /// removes the `runtime_control_endpoint` field from `SdkHandle` setters.
    pub(in crate::domain::ws_session) runtime_control_endpoint: Option<String>,
    /// Claude CLI session ID to use for --resume on the first prompt.
    /// Set from the DB row at init time; consumed (taken) when spawning.
    pub(in crate::domain::ws_session) resume_session_id: Option<String>,
    /// Config for respawning with --resume after model/mode change.
    pub(in crate::domain::ws_session) config: SessionConfig,
    pub(in crate::domain::ws_session) manual_compact_cancel: Arc<AtomicBool>,
    pub(in crate::domain::ws_session) manual_compact_spawn_pending: Arc<AtomicBool>,
}

pub(crate) type SdkSessions = Arc<Mutex<HashMap<i64, SdkHandle>>>;
pub(in crate::domain::ws_session) type WsSender = mpsc::UnboundedSender<Message>;

pub(crate) fn new_sdk_sessions() -> SdkSessions {
    Arc::new(Mutex::new(HashMap::new()))
}
