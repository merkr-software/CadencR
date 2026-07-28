use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use super::session::RuntimeToolPermissionHandler;

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
        /// The stream reader fills this from the canonical prompt receipt when
        /// ACP omits a provider-native id.
        event_id: Option<String>,
        entries: Vec<RuntimeTokenUsageEntry>,
    },
    /// Monotonic session/thread totals. The recorder persists a checkpoint and
    /// adds only the increase since the previous event.
    Cumulative { entry: RuntimeTokenUsageEntry },
}

impl RuntimeTokenUsage {
    pub fn delta(event_id: Option<String>, entries: Vec<RuntimeTokenUsageEntry>) -> Self {
        Self::Delta { event_id, entries }
    }

    pub fn cumulative(entry: RuntimeTokenUsageEntry) -> Self {
        Self::Cumulative { entry }
    }

    pub fn set_event_id_if_missing(&mut self, fallback: Option<String>) {
        if let Self::Delta { event_id, .. } = self {
            if event_id.is_none() {
                *event_id = fallback;
            }
        }
    }

    pub fn is_zero(&self) -> bool {
        match self {
            Self::Delta { entries, .. } => entries
                .iter()
                .all(|entry| entry.input_tokens == 0 && entry.output_tokens == 0),
            Self::Cumulative { entry } => entry.input_tokens == 0 && entry.output_tokens == 0,
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

pub struct RuntimeSpawnConfig {
    pub cwd: PathBuf,
    pub permission_mode: Option<RuntimePermissionMode>,
    pub access_mode: Option<RuntimeAccessMode>,
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub system_prompt: Option<String>,
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
}

impl Default for RuntimeSpawnConfig {
    fn default() -> Self {
        Self {
            cwd: PathBuf::new(),
            permission_mode: None,
            access_mode: None,
            model: None,
            thinking_effort: None,
            system_prompt: None,
            resume_session_id: None,
            allow_bypass_permissions: false,
            mcp_servers: None,
            permission_handler: None,
            env: None,
        }
    }
}
