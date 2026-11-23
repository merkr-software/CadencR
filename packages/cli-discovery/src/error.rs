//! The failure of a discovery step that ran on the blocking pool.

use std::fmt;

use tokio::task::JoinError;

/// A discovery step could not finish: the blocking task that checked the
/// override path or walked the search directories panicked or was cancelled.
///
/// Distinct from "no candidate": the search did not complete, so callers must
/// not report the CLI as missing (nor cache that answer).
#[derive(Debug)]
pub struct DiscoveryError {
    step: &'static str,
    source: JoinError,
}

impl DiscoveryError {
    /// Which discovery step failed, e.g. `"override path check"`.
    pub fn step(&self) -> &'static str {
        self.step
    }
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "CLI discovery task failed during the {}: {}",
            self.step, self.source
        )
    }
}

impl std::error::Error for DiscoveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl From<DiscoveryError> for std::io::Error {
    fn from(error: DiscoveryError) -> Self {
        std::io::Error::other(error)
    }
}

/// Run `work` on the blocking pool; a panic or cancellation becomes a
/// [`DiscoveryError`] naming `step` instead of a silent empty answer.
pub(crate) async fn run_blocking<T, F>(step: &'static str, work: F) -> Result<T, DiscoveryError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|source| DiscoveryError { step, source })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_panicking_step_is_an_error_not_an_empty_answer() {
        let result =
            run_blocking("candidate walk", || -> Vec<u8> { panic!("walk exploded") }).await;
        let error = result.expect_err("a panic must not read as no candidate");
        assert_eq!(error.step(), "candidate walk");
        let message = error.to_string();
        assert!(
            message.starts_with("CLI discovery task failed during the candidate walk: "),
            "{message}"
        );
        assert!(message.contains("panic"), "{message}");
        let io = std::io::Error::from(error);
        assert_eq!(io.kind(), std::io::ErrorKind::Other);
        assert!(io.to_string().contains("candidate walk"), "{io}");
    }

    #[tokio::test]
    async fn a_finished_step_returns_its_value() {
        let value = run_blocking("override path check", || 7).await.unwrap();
        assert_eq!(value, 7);
    }
}
