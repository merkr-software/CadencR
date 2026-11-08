//! Short-lived `opencode models --verbose` probe for the live model catalog.
//!
//! The prior implementation spawned `opencode serve` and polled
//! `/config/providers`. Current OpenCode builds make the CLI model catalog
//! available directly through `opencode models --verbose`, avoiding an
//! unrelated HTTP server startup path before the frontend can render models.

use opencode_sdk_rs::{ConfigProvidersResponse, SdkError};

use crate::domain::agents::adapter::RuntimeError;
use crate::shared::cli_stderr;

const PROBE_LOG_PREFIX: &str = "opencode models probe";

/// Run the probe, returning opencode's resolved provider/model list.
///
/// Errors bubble up so the cache layer can log + fall back. The cache owns
/// retries: at most one immediate retry on a cold cache, then a backoff.
pub(super) async fn run() -> Result<ConfigProvidersResponse, RuntimeError> {
    opencode_sdk_rs::list_models_from_cli()
        .await
        .map_err(probe_error)
}

/// A CLI that ran and failed says why, from the end of its stderr (bounded,
/// known secrets masked); anything else keeps the probe prefix.
fn probe_error(error: SdkError) -> RuntimeError {
    if let SdkError::CommandFailed {
        command,
        status,
        stderr,
    } = &error
    {
        let (code, signal) = cli_stderr::exit_parts(status);
        let lines: Vec<&str> = stderr.raw().lines().collect();
        let secrets = cli_stderr::secret_values([]);
        return RuntimeError::new(cli_stderr::exit_message(
            command, code, signal, &lines, &secrets,
        ));
    }
    match RuntimeError::from(error) {
        RuntimeError::Generic(message) => {
            RuntimeError::new(format!("{PROBE_LOG_PREFIX}: {message}"))
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    //! How a failed probe reads, and an end-to-end probe against the real
    //! `opencode` binary. The latter is ignored by default — it requires
    //! `opencode` on PATH (or the SDK binary override pointed at a working
    //! install with a readable model cache). Run manually with
    //! `cargo test -p cadencr-service probe_end_to_end -- --ignored`.

    use super::{probe_error, run};
    use opencode_sdk_rs::{CommandStderr, SdkError};

    #[cfg(unix)]
    #[test]
    fn a_failed_cli_says_why_from_its_stderr() {
        use std::os::unix::process::ExitStatusExt;

        let error = probe_error(SdkError::CommandFailed {
            command: "opencode models --verbose".to_string(),
            status: std::process::ExitStatus::from_raw(1 << 8),
            stderr: CommandStderr::new("\nError: simulated opencode failure\n".to_string()),
        });
        assert_eq!(
            error.to_string(),
            "opencode models --verbose exited with status 1: Error: simulated opencode failure"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn probe_end_to_end_requires_opencode_binary() {
        let response = run().await.expect("probe ok");
        assert!(
            !response.providers.is_empty(),
            "expected at least one provider from a real opencode install"
        );
    }
}
