//! Short-lived `opencode models --verbose` probe for the live model catalog.
//!
//! The prior implementation spawned `opencode serve` and polled
//! `/config/providers`. Current OpenCode builds make the CLI model catalog
//! available directly through `opencode models --verbose`, avoiding an
//! unrelated HTTP server startup path before the frontend can render models.

use opencode_sdk_rs::ConfigProvidersResponse;

use crate::domain::agents::adapter::RuntimeError;

const PROBE_LOG_PREFIX: &str = "opencode models probe";

/// Run the probe, returning opencode's resolved provider/model list.
///
/// Errors bubble up so the cache layer can log + fall back. The cache owns
/// retries: at most one immediate retry on a cold cache, then a backoff.
pub(super) async fn run() -> Result<ConfigProvidersResponse, RuntimeError> {
    opencode_sdk_rs::list_models_from_cli()
        .await
        .map_err(|error| match RuntimeError::from(error) {
            RuntimeError::Generic(message) => {
                RuntimeError::new(format!("{PROBE_LOG_PREFIX}: {message}"))
            }
            other => other,
        })
}

#[cfg(test)]
mod tests {
    //! End-to-end probe against the real `opencode` binary. Ignored by default
    //! — requires `opencode` on PATH (or the SDK binary override pointed at a
    //! working install with a readable model cache). Run manually with
    //! `cargo test -p cadencr-service probe_end_to_end -- --ignored`.

    use super::run;

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
