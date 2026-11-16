use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SdkError {
    #[error("codex CLI not found; searched {} location(s)", searched.len())]
    CliNotFound { searched: Vec<PathBuf> },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("request timed out: {0}")]
    Timeout(&'static str),
    #[error("app-server protocol error: {0}")]
    Protocol(String),
    #[error("app-server returned error {code}: {}", rpc_message_summary(message))]
    Rpc { code: i64, message: String },
    #[error("app-server process exited")]
    ProcessExited,
    #[error("response channel closed")]
    ResponseClosed,
}

/// What a JSON-RPC error code says about a failed request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcErrorKind {
    /// -32700: the app-server could not parse the request.
    ParseError,
    /// -32600: the app-server refused the request. Codex uses it for an
    /// unknown method, missing or mistyped params, an unknown thread or turn,
    /// and a request the thread's state does not allow.
    InvalidRequest,
    /// -32601: no such method.
    MethodNotFound,
    /// -32602: the params do not match the method.
    InvalidParams,
    /// -32603: the app-server failed while handling the request.
    Internal,
    /// -32001: the app-server's request queue is full ("Server overloaded;
    /// retry later.").
    Overloaded,
    /// Any other code.
    Other,
}

impl RpcErrorKind {
    pub fn from_code(code: i64) -> Self {
        match code {
            -32700 => Self::ParseError,
            -32600 => Self::InvalidRequest,
            -32601 => Self::MethodNotFound,
            -32602 => Self::InvalidParams,
            -32603 => Self::Internal,
            -32001 => Self::Overloaded,
            _ => Self::Other,
        }
    }

    /// The app-server turned the request down without running it.
    pub fn is_rejection(self) -> bool {
        matches!(
            self,
            Self::ParseError | Self::InvalidRequest | Self::MethodNotFound | Self::InvalidParams
        )
    }
}

/// An unknown-method error lists every method the app-server knows (well
/// over a hundred); only what precedes that list says what went wrong.
fn rpc_message_summary(message: &str) -> &str {
    message
        .split_once(", expected one of `")
        .map_or(message, |(summary, _)| summary)
}

impl SdkError {
    /// How the app-server classified a JSON-RPC error; `None` for any other
    /// failure.
    pub fn rpc_kind(&self) -> Option<RpcErrorKind> {
        match self {
            Self::Rpc { code, .. } => Some(RpcErrorKind::from_code(*code)),
            _ => None,
        }
    }

    /// Whether the app-server does not know `method`: JSON-RPC's
    /// method-not-found, or Codex's invalid request naming it as an unknown
    /// variant. Tells a capability the installed app-server lacks.
    pub fn is_unknown_method(&self, method: &str) -> bool {
        let Self::Rpc { code, message } = self else {
            return false;
        };
        match RpcErrorKind::from_code(*code) {
            RpcErrorKind::MethodNotFound => true,
            RpcErrorKind::InvalidRequest => {
                message.contains(&format!("unknown variant `{method}`"))
            }
            _ => false,
        }
    }

    pub fn is_no_active_turn_to_steer(&self) -> bool {
        matches!(
            self,
            Self::Rpc { message, .. } if message == "no active turn to steer"
        )
    }

    /// Codex's answer to `turn/interrupt` for a turn that is not running: it
    /// ended, or it is not the thread's running turn.
    pub fn is_no_active_turn_to_interrupt(&self) -> bool {
        matches!(
            self,
            Self::Rpc { message, .. } if message == "no active turn to interrupt"
        )
    }

    pub fn active_turn_mismatch_found_id(&self) -> Option<&str> {
        let Self::Rpc { message, .. } = self else {
            return None;
        };
        let mismatch = message.strip_prefix("expected active turn id `")?;
        let (_, found_part) = mismatch.split_once("` but found `")?;
        let (found_id, _) = found_part.split_once('`')?;
        if found_id.is_empty() {
            return None;
        }
        Some(found_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{RpcErrorKind, SdkError};

    fn rpc(code: i64, message: &str) -> SdkError {
        SdkError::Rpc {
            code,
            message: message.to_string(),
        }
    }

    /// Codex 0.167 answers a method it dropped with -32600 and the list of
    /// every method it knows, `account/rateLimits/read` included.
    const UNKNOWN_ROLLBACK: &str = "Invalid request: unknown variant `thread/rollback`, expected one of `initialize`, `thread/start`, `account/rateLimits/read`";

    #[test]
    fn an_unknown_method_names_only_the_method() {
        let error = rpc(-32600, UNKNOWN_ROLLBACK);

        assert_eq!(
            error.to_string(),
            "app-server returned error -32600: Invalid request: unknown variant `thread/rollback`"
        );
        assert!(error.is_unknown_method("thread/rollback"));
        assert!(!error.is_unknown_method("thread/revert"));
        assert!(rpc(-32601, "Method not found").is_unknown_method("thread/revert"));
        assert!(!rpc(-32600, "thread not found: x").is_unknown_method("thread/revert"));
    }

    #[test]
    fn detects_no_active_turn_to_interrupt() {
        assert!(rpc(-32600, "no active turn to interrupt").is_no_active_turn_to_interrupt());
        assert!(!rpc(-32600, "no active turn to steer").is_no_active_turn_to_interrupt());
        assert!(!SdkError::Timeout("turn/interrupt").is_no_active_turn_to_interrupt());
    }

    #[test]
    fn json_rpc_codes_classify_the_failure() {
        for (code, kind, rejection) in [
            (-32700, RpcErrorKind::ParseError, true),
            (-32600, RpcErrorKind::InvalidRequest, true),
            (-32601, RpcErrorKind::MethodNotFound, true),
            (-32602, RpcErrorKind::InvalidParams, true),
            (-32603, RpcErrorKind::Internal, false),
            (-32001, RpcErrorKind::Overloaded, false),
            (-32000, RpcErrorKind::Other, false),
        ] {
            let error = rpc(code, "x");
            assert_eq!(error.rpc_kind(), Some(kind), "{code}");
            assert_eq!(kind.is_rejection(), rejection, "{code}");
        }
        assert_eq!(SdkError::ProcessExited.rpc_kind(), None);
    }

    #[test]
    fn detects_no_active_turn_to_steer_rpc_error() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "no active turn to steer".to_string(),
        };

        assert!(error.is_no_active_turn_to_steer());
    }

    #[test]
    fn ignores_unrelated_rpc_errors() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "invalid input".to_string(),
        };

        assert!(!error.is_no_active_turn_to_steer());
    }

    #[test]
    fn extracts_found_active_turn_from_mismatch_error() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "expected active turn id `019ef34f-f998-7753-b1b0-608715221a03` but found `019ef348-6e61-7813-9228-fd9045112a07`".to_string(),
        };

        assert_eq!(
            error.active_turn_mismatch_found_id(),
            Some("019ef348-6e61-7813-9228-fd9045112a07")
        );
    }

    #[test]
    fn ignores_non_mismatch_rpc_error_for_found_active_turn() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "no active turn to steer".to_string(),
        };

        assert_eq!(error.active_turn_mismatch_found_id(), None);
    }

    #[test]
    fn ignores_unrelated_rpc_error_that_mentions_found() {
        let error = SdkError::Rpc {
            code: -32600,
            message: "some other validation failed but found `turn_like_text`".to_string(),
        };

        assert_eq!(error.active_turn_mismatch_found_id(), None);
    }
}
