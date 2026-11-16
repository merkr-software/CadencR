use std::future::Future;
use std::time::Duration;

use super::super::adapter::RuntimeError;

// Match the Codex app-server SDK's default request timeout.
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
// The profile fingerprint runs before a prompt reaches the agent and needs
// only `config/read`; the model list it also asks for must not hold it up.
pub(super) const FINGERPRINT_MODELS_TIMEOUT: Duration = Duration::from_secs(5);
// Stream recovery and user-requested shutdown must remain responsive.
pub(super) const RECOVERY_TIMEOUT: Duration = Duration::from_secs(3);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) async fn with_probe_timeout<T>(
    operation: &'static str,
    future: impl Future<Output = Result<T, codex_app_server_sdk_rs::SdkError>>,
) -> Result<T, RuntimeError> {
    with_timeout(PROBE_TIMEOUT, operation, future).await
}

pub(super) async fn with_control_timeout<T>(
    operation: &'static str,
    future: impl Future<Output = Result<T, codex_app_server_sdk_rs::SdkError>>,
) -> Result<T, RuntimeError> {
    with_timeout(CONTROL_TIMEOUT, operation, future).await
}

pub(super) async fn with_timeout<T>(
    timeout: Duration,
    operation: &'static str,
    future: impl Future<Output = Result<T, codex_app_server_sdk_rs::SdkError>>,
) -> Result<T, RuntimeError> {
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| RuntimeError::from(codex_app_server_sdk_rs::SdkError::Timeout(operation)))?
        .map_err(RuntimeError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn slow_model_probe_succeeds_while_stalled_control_times_out() {
        let probe = with_probe_timeout("Codex model/list", async {
            tokio::time::sleep(Duration::from_secs(4)).await;
            Ok(vec!["model"])
        });
        let control = with_control_timeout::<()>("Codex turn/interrupt", std::future::pending());
        let start = tokio::time::Instant::now();
        let bounded_control = async {
            let error = control.await.unwrap_err();
            assert!(start.elapsed() < Duration::from_secs(10));
            assert!(error.to_string().contains("Codex turn/interrupt"));
        };
        let (models, ()) = tokio::join!(probe, bounded_control);
        assert_eq!(models.unwrap(), vec!["model"]);
    }

    #[tokio::test]
    async fn control_preserves_success_and_sdk_errors() {
        assert_eq!(
            with_control_timeout("control", async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        let error = with_control_timeout::<()>("control", async {
            Err(codex_app_server_sdk_rs::SdkError::Timeout("SDK request"))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("SDK request"));
    }
}
