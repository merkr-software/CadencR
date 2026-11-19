//! Linux forks can briefly inherit a writer to a just-installed executable,
//! even after the installing thread closed it. Retry only that exec failure.
use std::future::Future;
use std::io;
use std::time::Duration;

use super::launch::unavailable;
use crate::error::AppError;

const ATTEMPTS: usize = 5;
const RETRY_DELAY: Duration = Duration::from_millis(50);

#[derive(Debug)]
pub(super) enum SpawnError {
    Exec(io::Error),
    Other(AppError),
    /// A stop overtook this start; it does not count as a failed spawn.
    Stopped(AppError),
}

impl From<AppError> for SpawnError {
    fn from(error: AppError) -> Self {
        Self::Other(error)
    }
}

impl From<SpawnError> for AppError {
    fn from(error: SpawnError) -> Self {
        match error {
            SpawnError::Exec(error) => unavailable(format!("the backend failed to start: {error}")),
            SpawnError::Other(error) | SpawnError::Stopped(error) => error,
        }
    }
}

/// Each attempt reacquires and releases the supervisor's slots lock, so the
/// delay holds only the starting lock of this tab, never the global lock.
pub(super) async fn spawn<T, F, Fut>(mut attempt: F) -> Result<T, SpawnError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, SpawnError>>,
{
    for remaining in (0..ATTEMPTS).rev() {
        match attempt().await {
            Err(error) if remaining > 0 && text_busy(&error) => {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            result => return result,
        }
    }
    unreachable!("the last spawn attempt always returns")
}

fn text_busy(error: &SpawnError) -> bool {
    #[cfg(target_os = "linux")]
    {
        matches!(error, SpawnError::Exec(error) if error.raw_os_error() == Some(libc::ETXTBSY))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = error;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::ready;

    #[tokio::test]
    async fn other_spawn_errors_are_returned_without_retrying() {
        let mut attempts = 0;
        let result: Result<(), SpawnError> = spawn(|| {
            attempts += 1;
            ready(Err(SpawnError::Exec(io::Error::from(
                io::ErrorKind::PermissionDenied,
            ))))
        })
        .await;
        assert_eq!(attempts, 1);
        let SpawnError::Exec(error) = result.unwrap_err() else {
            panic!("the original exec error must be returned");
        };
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_transient_text_busy_error_is_retried() {
        let mut attempts = 0;
        let result = spawn(|| {
            attempts += 1;
            ready(if attempts == 1 {
                Err(SpawnError::Exec(io::Error::from_raw_os_error(
                    libc::ETXTBSY,
                )))
            } else {
                Ok(42)
            })
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(attempts, 2);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_stop_between_attempts_ends_the_retry() {
        let mut attempts = 0;
        let result: Result<(), SpawnError> = spawn(|| {
            attempts += 1;
            ready(Err(if attempts == 1 {
                SpawnError::Exec(io::Error::from_raw_os_error(libc::ETXTBSY))
            } else {
                SpawnError::Stopped(super::super::process::exited_error(
                    "it was stopped while starting",
                ))
            }))
        })
        .await;
        assert_eq!(attempts, 2);
        assert!(matches!(
            AppError::from(result.unwrap_err()),
            AppError::Coded {
                code: "PLUGIN_BACKEND_EXITED",
                ..
            }
        ));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn persistent_text_busy_errors_keep_the_original_error_after_the_budget() {
        let mut attempts = 0;
        let result: Result<(), SpawnError> = spawn(|| {
            attempts += 1;
            ready(Err(SpawnError::Exec(io::Error::from_raw_os_error(
                libc::ETXTBSY,
            ))))
        })
        .await;
        assert_eq!(attempts, ATTEMPTS);
        let SpawnError::Exec(error) = result.unwrap_err() else {
            panic!("the original exec error must be returned");
        };
        assert_eq!(error.raw_os_error(), Some(libc::ETXTBSY));
    }

    #[cfg(not(target_os = "linux"))]
    #[tokio::test]
    async fn the_same_error_number_is_not_retried_on_other_platforms() {
        let mut attempts = 0;
        let result: Result<(), SpawnError> = spawn(|| {
            attempts += 1;
            ready(Err(SpawnError::Exec(io::Error::from_raw_os_error(26))))
        })
        .await;
        assert_eq!(attempts, 1);
        let SpawnError::Exec(error) = result.unwrap_err() else {
            panic!("the original exec error must be returned");
        };
        assert_eq!(error.raw_os_error(), Some(26));
    }
}
