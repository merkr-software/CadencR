use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use super::session::RuntimeToolPermissionHandler;

/// Wrap a built-in's compiled config-path list in the owned shape
/// [`super::AgentRuntimeAdapter::worktree_config_paths`] returns. Borrowing
/// keeps it allocation-free for compiled providers while runtime-registered
/// ones can hand back owned strings.
pub fn static_config_paths(paths: &'static [&'static str]) -> Vec<Cow<'static, str>> {
    paths.iter().copied().map(Cow::Borrowed).collect()
}

#[derive(Debug, Clone)]
pub struct RuntimeUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl RuntimeUsage {
    pub fn is_zero(&self) -> bool {
        self.input_tokens == 0 && self.output_tokens == 0
    }
}

/// One provider/model slice inside a token-usage report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeTokenUsageEntry {
    /// Provider-native model id when the report contains a per-model split.
    /// Otherwise the recorder uses the session's captured model.
    pub model_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Provider-native accounting attached to a runtime event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeTokenUsage {
    /// Final usage for one completed turn. `event_id` makes replay idempotent.
    Delta {
        /// Provider-native result/request identity.
        event_id: Option<String>,
        /// Correlation identity shared with history import. Claimed alongside
        /// `event_id` without replacing the provider-native replay key.
        correlation_id: Option<String>,
        /// Whether the shared stream reader may correlate this report with a
        /// provider assistant message. Exact per-response reports set this to
        /// false because one assistant turn can contain several responses.
        correlate_provider_message: bool,
        entries: Vec<RuntimeTokenUsageEntry>,
    },
    /// Monotonic session/thread totals. The recorder persists a checkpoint for
    /// each provider-native counter and adds only the increase since the
    /// previous event. `scope_id` is empty when a provider exposes only one
    /// cumulative counter per Cadencr session.
    Cumulative {
        scope_id: String,
        entry: RuntimeTokenUsageEntry,
    },
}

impl RuntimeTokenUsage {
    pub fn delta(event_id: Option<String>, entries: Vec<RuntimeTokenUsageEntry>) -> Self {
        Self::Delta {
            event_id,
            correlation_id: None,
            correlate_provider_message: true,
            entries,
        }
    }

    /// Exact usage for one independently identified provider response.
    ///
    /// These reports remain idempotent through `event_id`, but must not inherit
    /// the turn-level provider-message correlation used by result events: a
    /// single turn can complete several upstream responses.
    pub fn response_delta(event_id: String, entries: Vec<RuntimeTokenUsageEntry>) -> Self {
        Self::Delta {
            event_id: Some(event_id),
            correlation_id: None,
            correlate_provider_message: false,
            entries,
        }
    }

    /// Exact provider-response usage with a second replay identity supplied by
    /// another native notification for the same response.
    pub fn correlated_response_delta(
        event_id: String,
        correlation_id: String,
        entries: Vec<RuntimeTokenUsageEntry>,
    ) -> Self {
        Self::Delta {
            event_id: Some(event_id),
            correlation_id: Some(correlation_id),
            correlate_provider_message: false,
            entries,
        }
    }

    pub fn cumulative(entry: RuntimeTokenUsageEntry) -> Self {
        Self::Cumulative {
            scope_id: String::new(),
            entry,
        }
    }

    #[cfg(test)]
    pub fn scoped_cumulative(scope_id: String, entry: RuntimeTokenUsageEntry) -> Self {
        Self::Cumulative { scope_id, entry }
    }

    /// Preserve compatibility with the original per-session checkpoint by
    /// storing the root provider counter under the empty default scope. Native
    /// ids remain on independently increasing child counters.
    pub fn normalize_root_scope(&mut self, root_scope_id: Option<&str>) {
        let Self::Cumulative { scope_id, .. } = self else {
            return;
        };
        if root_scope_id.is_some_and(|root| root == scope_id) {
            scope_id.clear();
        }
    }

    /// Add a history/live correlation key while preserving the provider's own
    /// replay identity. `fallback` is used only when the provider supplied no
    /// event id at all.
    pub fn correlate_event_id(&mut self, correlation: Option<String>, fallback: Option<String>) {
        if let Self::Delta {
            event_id,
            correlation_id,
            correlate_provider_message,
            ..
        } = self
        {
            if !*correlate_provider_message {
                return;
            }
            *correlation_id = correlation.filter(|id| Some(id) != event_id.as_ref());
            if event_id.is_none() {
                *event_id = fallback;
            }
        }
    }

    pub fn is_noop(&self) -> bool {
        match self {
            Self::Delta { entries, .. } => entries
                .iter()
                .all(|entry| entry.input_tokens == 0 && entry.output_tokens == 0),
            // A zero cumulative snapshot is a meaningful counter reset. The
            // recorder must persist it so a later increase starts from zero.
            Self::Cumulative { .. } => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    /// Provider-neutral read-only Q&A mode. Providers opt in explicitly and
    /// own the concrete transport mapping.
    Ask,
    /// Claude Code v2.1.83+ classifier-backed mode. Currently a Claude-only
    /// mode; OpenCode and Codex adapters fall back to their own "everyday"
    /// permission level when this is selected.
    Auto,
    DontAsk,
    OpenCodeAgent(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeAccessMode {
    Default,
    FullAccess,
    AutoReview,
}

pub fn parse_access_mode_wire(mode: &str) -> Option<RuntimeAccessMode> {
    match mode {
        "default" => Some(RuntimeAccessMode::Default),
        "fullAccess" => Some(RuntimeAccessMode::FullAccess),
        "autoReview" => Some(RuntimeAccessMode::AutoReview),
        _ => None,
    }
}

pub fn access_mode_wire(mode: &RuntimeAccessMode) -> &'static str {
    match mode {
        RuntimeAccessMode::Default => "default",
        RuntimeAccessMode::FullAccess => "fullAccess",
        RuntimeAccessMode::AutoReview => "autoReview",
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum RuntimeMcpServerConfig {
    Stdio {
        command: String,
        args: Option<Vec<String>>,
        env: Option<HashMap<String, String>>,
    },
}

#[derive(Debug, Clone)]
pub struct RuntimeMcpServerStatus {
    pub name: String,
    pub status: String,
}

/// Fully resolved provider profile used to start (or resume) a runtime.
///
/// `identity` is the stable persisted selection, while `revision` changes when
/// the selected profile's effective configuration changes. `state_identity`
/// identifies provider state which must remain compatible across resume (for
/// example Codex's effective `CODEX_HOME`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRuntimeProfile {
    pub identity: String,
    pub revision: String,
    pub env: HashMap<String, String>,
    pub env_unset: Vec<String>,
    pub state_identity: Option<String>,
}

/// User-authored overrides layered over a provider profile's native config.
/// `None` means inherit; notably, `Some(false)` is an explicit fast-mode
/// override and must never be collapsed into inheritance.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, utoipa::ToSchema,
)]
pub struct RuntimeConfigOverrides {
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub fast_mode: Option<bool>,
}

#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, utoipa::ToSchema,
)]
pub struct RuntimeEffectiveConfig {
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub fast_mode: bool,
}

/// One-shot work performed by a runtime instead of an interactive coding turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePurpose {
    AutoName,
}

#[derive(Clone)]
pub struct RuntimeSpawnConfig {
    pub cwd: PathBuf,
    pub permission_mode: Option<RuntimePermissionMode>,
    pub access_mode: Option<RuntimeAccessMode>,
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub fast_mode: bool,
    pub system_prompt: Option<String>,
    /// Optional task hint for runtimes that support specialized launch modes.
    pub purpose: Option<RuntimePurpose>,
    pub resume_session_id: Option<String>,
    /// Allows a provider process to switch into its dangerous Bypass mode
    /// later without starting in that mode. Providers that do not have a
    /// separate launch-time capability flag can ignore this value.
    pub allow_bypass_permissions: bool,
    pub mcp_servers: Option<HashMap<String, RuntimeMcpServerConfig>>,
    pub permission_handler: Option<Arc<dyn RuntimeToolPermissionHandler>>,
    /// Extra env vars injected into the spawned runtime. Adapters decide how
    /// to apply this (Claude Code merges it into the CLI subprocess env;
    /// ACP-backed providers may ignore it when configuration is handled elsewhere).
    pub env: Option<HashMap<String, String>>,
    /// Stable provider-owned profile identity selected for this runtime.
    pub profile: Option<String>,
    /// Environment keys which must be removed after the inherited environment
    /// and profile overlay have been composed.
    pub env_unset: Vec<String>,
    pub overrides: RuntimeConfigOverrides,
    pub profile_revision: Option<String>,
    pub profile_state_identity: Option<String>,
}

impl Default for RuntimeSpawnConfig {
    fn default() -> Self {
        Self {
            cwd: PathBuf::new(),
            permission_mode: None,
            access_mode: None,
            model: None,
            thinking_effort: None,
            fast_mode: false,
            system_prompt: None,
            purpose: None,
            resume_session_id: None,
            allow_bypass_permissions: false,
            mcp_servers: None,
            permission_handler: None,
            env: None,
            profile: None,
            env_unset: Vec::new(),
            overrides: RuntimeConfigOverrides::default(),
            profile_revision: None,
            profile_state_identity: None,
        }
    }
}
