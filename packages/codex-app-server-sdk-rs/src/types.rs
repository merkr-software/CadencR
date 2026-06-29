use serde_json::Value;

/// Token reserve used by the Codex CLI when displaying context-window usage.
///
/// Codex app-server reports raw totals and the model context window, while the
/// CLI subtracts this baseline before computing the displayed percentage.
pub const CONTEXT_USAGE_BASELINE_TOKENS: u64 = 12_000;

#[derive(Debug, Clone)]
pub struct AppServerClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl Default for AppServerClientInfo {
    fn default() -> Self {
        Self {
            name: "cadencr".into(),
            title: "Cadencr".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum AppServerEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    ProcessExited {
        status: Option<i32>,
        signal: Option<i32>,
    },
}

#[derive(Debug, Clone)]
pub struct CodexModel {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub supported_efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub context_window: Option<u64>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexCommandKind {
    Command,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCommand {
    pub name: String,
    pub description: Option<String>,
    pub kind: CodexCommandKind,
}

#[derive(Debug, Clone)]
pub struct ThreadHandle {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadSnapshot {
    pub id: String,
    pub turns: Vec<ThreadTurn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadTurn {
    pub id: String,
    user_message_count: usize,
}

impl ThreadTurn {
    pub fn new(id: String, user_message_count: usize) -> Self {
        Self {
            id,
            user_message_count,
        }
    }

    pub fn user_message_count(&self) -> usize {
        self.user_message_count
    }
}

#[derive(Debug, Clone)]
pub struct TurnHandle {
    pub id: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexMcpServerStatus {
    pub name: String,
    pub auth_status: Option<String>,
    pub tool_names: Vec<String>,
}

impl CodexMcpServerStatus {
    pub fn from_value(value: &Value) -> Option<Self> {
        let name = value.get("name")?.as_str()?.to_string();
        let auth_status = value
            .get("authStatus")
            .or_else(|| value.get("auth_status"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        Some(Self {
            name,
            auth_status,
            tool_names: parse_tool_names(value.get("tools")),
        })
    }
}

pub fn parse_mcp_server_status_list(response: &Value) -> Vec<CodexMcpServerStatus> {
    response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(CodexMcpServerStatus::from_value)
        .collect()
}

fn parse_tool_names(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Object(tools)) => tools.keys().cloned().collect(),
        Some(Value::Array(tools)) => tools
            .iter()
            .filter_map(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .or_else(|| tool.as_str())
            })
            .map(ToOwned::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}
