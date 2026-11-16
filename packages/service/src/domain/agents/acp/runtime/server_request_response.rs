use crate::domain::agents::acp::AcpClient;
use serde_json::Value;

use super::fs::FsOutcome;

pub(super) async fn respond_or_reject(client: &AcpClient, id: Value, outcome: FsOutcome) {
    match outcome {
        FsOutcome::Ok(value) => {
            if let Err(error) = client.respond_server_request(id, value).await {
                tracing::warn!(%error, "failed to send ACP response");
            }
        }
        FsOutcome::Error { code, message } => {
            if let Err(error) = client.reject_server_request(id, code, &message).await {
                tracing::warn!(%error, "failed to send ACP error");
            }
        }
    }
}

pub(super) fn fs_outcome_from(result: Result<Value, (i64, String)>) -> FsOutcome {
    match result {
        Ok(value) => FsOutcome::Ok(value),
        Err((code, message)) => FsOutcome::Error { code, message },
    }
}

pub(super) fn terminal_id_param(params: &Value) -> &str {
    params
        .get("terminalId")
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub fn describe_exit(status: Option<i32>, signal: Option<i32>) -> String {
    match (status, signal) {
        (Some(code), _) => format!("exit code {code}"),
        (_, Some(sig)) => format!("signal {sig}"),
        _ => "unknown reason".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::describe_exit;

    #[test]
    fn describe_exit_prefers_status_then_signal() {
        assert_eq!(describe_exit(Some(0), None), "exit code 0");
        assert_eq!(describe_exit(None, Some(9)), "signal 9");
        assert_eq!(describe_exit(None, None), "unknown reason");
    }
}
