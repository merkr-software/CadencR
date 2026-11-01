//! Mutable proxy state shared by the host and child message handlers.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::access::AccessMode;
use crate::config_view::SessionConfig;
use crate::extensions::subagents::SubagentSessions;
use crate::extensions::todos::TodoBoard;
use crate::tool_calls::ToolNames;

/// What the connector knows about one ACP session.
#[derive(Debug, Default)]
pub struct SessionState {
    /// `cwd` / `mcpServers` from `session/new|load|resume`, reused by the
    /// `session/load` that restores the session after an access restart.
    pub cwd: Value,
    pub mcp_servers: Value,
    pub config: SessionConfig,
    pub prompt_in_flight: bool,
    /// An approved Cursor plan waits for the current turn to end, then runs
    /// the execution follow-up inside the same host turn.
    pub plan_followup: bool,
    /// Cursor has saved the conversation, so `session/load` can restore it:
    /// true once a prompt returned or the host loaded/resumed the session.
    /// Cursor writes nothing for a `session/new` before its first prompt.
    pub persisted: bool,
    /// Cursor's full todo list: its updates carry only the changed todos.
    pub todos: TodoBoard,
}

impl SessionState {
    pub fn from_params(params: &Value) -> Self {
        Self {
            cwd: params.get("cwd").cloned().unwrap_or(Value::Null),
            mcp_servers: params
                .get("mcpServers")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
            ..Self::default()
        }
    }
}

#[derive(Debug, Default)]
pub struct ProxyState {
    /// The access mode the host chose (what `configOptions` reports).
    pub access: AccessMode,
    /// The access mode the live `agent` was launched with. It lags `access`
    /// only while a Full Access restart waits for Cursor to save a fresh
    /// conversation (see `restart.rs`).
    pub child_access: AccessMode,
    /// Generation of the live `agent acp` child; older children are retired.
    pub generation: u64,
    /// Host `initialize` params as forwarded (replayed after a restart).
    pub host_init: Option<Value>,
    pub child_init: Option<Value>,
    pub sessions: HashMap<String, SessionState>,
    pub tools: ToolNames,
    /// Cursor sub-agent sessions, re-addressed to their parent session.
    pub subagents: SubagentSessions,
    /// Sessions whose `session/load` replay must not reach the host.
    pub suppressed: HashSet<String>,
    pub last_session: Option<String>,
    next_synthetic_id: u64,
}

impl ProxyState {
    pub fn new(access: AccessMode, generation: u64) -> Self {
        Self {
            access,
            child_access: access,
            generation,
            ..Self::default()
        }
    }

    pub fn synthetic_id(&mut self, prefix: &str) -> String {
        self.next_synthetic_id += 1;
        format!("cursor-{prefix}-{}", self.next_synthetic_id)
    }

    /// The session a Cursor extension refers to: its explicit `sessionId`,
    /// else the session with a turn in flight, else the most recent one.
    pub fn session_for(&self, params: &Value) -> Option<String> {
        if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
            return Some(id.to_string());
        }
        self.sessions
            .iter()
            .find(|(_, session)| session.prompt_in_flight)
            .map(|(id, _)| id.clone())
            .or_else(|| self.last_session.clone())
    }

    pub fn any_prompt_in_flight(&self) -> bool {
        self.sessions
            .values()
            .any(|session| session.prompt_in_flight)
    }

    pub fn all_sessions_persisted(&self) -> bool {
        self.sessions.values().all(|session| session.persisted)
    }

    /// The chosen access mode needs other `agent` launch flags.
    pub fn restart_pending(&self) -> bool {
        self.child_access.change_needs_restart(self.access)
    }

    pub fn child_supports_load(&self) -> bool {
        self.child_init
            .as_ref()
            .and_then(|init| init.pointer("/agentCapabilities/loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{ProxyState, SessionState};
    use serde_json::json;

    #[test]
    fn resolves_extension_sessions() {
        let mut state = ProxyState::default();
        assert_eq!(state.session_for(&json!({})), None);
        state.sessions.insert("a".into(), SessionState::default());
        state.sessions.insert(
            "b".into(),
            SessionState {
                prompt_in_flight: true,
                ..SessionState::default()
            },
        );
        state.last_session = Some("a".into());
        assert_eq!(state.session_for(&json!({})).as_deref(), Some("b"));
        assert_eq!(
            state.session_for(&json!({ "sessionId": "z" })).as_deref(),
            Some("z")
        );
        assert!(state.any_prompt_in_flight());
        assert!(!state.all_sessions_persisted());
        assert!(!state.restart_pending());
        state.access = crate::access::AccessMode::FullAccess;
        assert!(state.restart_pending());
        assert_ne!(state.synthetic_id("task"), state.synthetic_id("task"));
    }

    #[test]
    fn records_session_launch_params_and_load_capability() {
        let session = SessionState::from_params(&json!({ "cwd": "/repo" }));
        assert_eq!(session.cwd, "/repo");
        assert_eq!(session.mcp_servers, json!([]));
        let mut state = ProxyState::default();
        assert!(!state.child_supports_load());
        state.child_init = Some(json!({ "agentCapabilities": { "loadSession": true } }));
        assert!(state.child_supports_load());
    }
}
