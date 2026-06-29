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
    #[error("app-server returned error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("app-server process exited")]
    ProcessExited,
    #[error("response channel closed")]
    ResponseClosed,
}

impl SdkError {
    pub fn is_no_active_turn_to_steer(&self) -> bool {
        matches!(
            self,
            Self::Rpc { message, .. } if message == "no active turn to steer"
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
    use super::SdkError;

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
