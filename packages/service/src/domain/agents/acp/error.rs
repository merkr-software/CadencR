use std::fmt::{Display, Formatter};

/// Errors emitted by the generic ACP stdio JSON-RPC transport.
///
/// Provider-neutral by design: this layer doesn't know about OpenCode (or any
/// other ACP provider). Adapters convert these into `RuntimeError` for the
/// `AgentRuntimeSession` channel.
#[derive(Debug)]
pub enum AcpError {
    Io(std::io::Error),
    /// Per-RPC timeout. Carries a static label of the method that timed out so
    /// the host can surface a helpful error ("session/prompt timed out").
    Timeout(&'static str),
    /// The transport closed (shutdown, or the agent process exited) while the
    /// request was in flight. Carries the method label.
    ConnectionClosed(&'static str),
    /// Framing or parse error in the JSON-RPC stream — oversized line, invalid
    /// UTF-8, malformed frame envelope. Always surfaced; never swallowed.
    Protocol(String),
    /// JSON-RPC error object returned by the agent for a request we sent.
    Rpc {
        code: i64,
        message: String,
        data: Option<serde_json::Value>,
    },
    /// Failed to spawn the subprocess (binary missing, pipes etc.). Distinct
    /// from generic IO so adapters can render an actionable message.
    Spawn(String),
}

impl Display for AcpError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Timeout(label) => write!(f, "ACP request timed out: {label}"),
            Self::ConnectionClosed(label) => {
                write!(f, "ACP connection closed before {label} completed")
            }
            Self::Protocol(message) => write!(f, "ACP protocol error: {message}"),
            Self::Rpc {
                code,
                message,
                data,
            } => match data.as_ref().and_then(rpc_error_detail) {
                Some(detail) if detail.as_str() != message.as_str() => {
                    write!(f, "ACP returned error {code}: {message}: {detail}")
                }
                _ => write!(f, "ACP returned error {code}: {message}"),
            },
            Self::Spawn(message) => write!(f, "failed to spawn ACP subprocess: {message}"),
        }
    }
}

impl std::error::Error for AcpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for AcpError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl AcpError {
    pub(crate) fn from_acp(value: agent_client_protocol::Error) -> Self {
        Self::Rpc {
            code: i32::from(value.code) as i64,
            message: value.message,
            data: value.data,
        }
    }
}

fn rpc_error_detail(data: &serde_json::Value) -> Option<String> {
    data.get("message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| data.as_str())
        .filter(|detail| !detail.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::AcpError;
    use serde_json::json;

    #[test]
    fn rpc_error_includes_provider_detail() {
        let error = agent_client_protocol::Error::invalid_params()
            .data(json!({ "message": "Unknown model config option: reasoning" }));

        assert_eq!(
            AcpError::from_acp(error).to_string(),
            "ACP returned error -32602: Invalid params: Unknown model config option: reasoning"
        );
    }

    #[test]
    fn rpc_error_does_not_render_arbitrary_structured_data() {
        let error = agent_client_protocol::Error::invalid_params()
            .data(json!({ "issues": [{ "path": ["configId"] }] }));

        assert_eq!(
            AcpError::from_acp(error).to_string(),
            "ACP returned error -32602: Invalid params"
        );
    }
}
