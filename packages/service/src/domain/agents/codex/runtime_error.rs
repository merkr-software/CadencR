use codex_app_server_sdk_rs::SdkError;

use crate::domain::agents::adapter::RuntimeError;

impl From<SdkError> for RuntimeError {
    fn from(value: SdkError) -> Self {
        match value {
            SdkError::CliNotFound { searched } => Self::cli_not_found("codex", searched),
            // The app-server turned the request down without running it: a
            // protocol mismatch, never the provider being overloaded.
            other if other.rpc_kind().is_some_and(|kind| kind.is_rejection()) => {
                Self::request_rejected(format!("Codex {other}"))
            }
            other => Self::Generic(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(code: i64, message: &str) -> RuntimeError {
        RuntimeError::from(SdkError::Rpc {
            code,
            message: message.to_string(),
        })
    }

    #[test]
    fn a_request_codex_refused_is_a_rejection_not_a_generic_failure() {
        let rejected = rpc(
            -32600,
            "Invalid request: unknown variant `thread/rollback`, expected one of `initialize`, `account/rateLimits/read`",
        );
        assert!(
            matches!(
                &rejected,
                RuntimeError::RequestRejected(message)
                    if message == "Codex app-server returned error -32600: Invalid request: unknown variant `thread/rollback`"
            ),
            "{rejected:?}"
        );
        for code in [-32700, -32601, -32602] {
            assert!(matches!(rpc(code, "x"), RuntimeError::RequestRejected(_)));
        }
        for code in [-32603, -32001, -32000] {
            assert!(matches!(rpc(code, "x"), RuntimeError::Generic(_)), "{code}");
        }
    }
}
