use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A usage write that failed, surfaced to the user.
///
/// Usage recording is deliberately fire-and-forget so a counter can never fail
/// an agent turn — but "cannot fail the turn" is not the same as "may be
/// swallowed". Failures are counted here and reported on the next
/// `/api/usage-stats` read, so the Stats tab can tell the user its numbers are
/// incomplete instead of quietly under-reporting.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageRecordingIssue {
    /// Failed usage writes since the service started.
    pub failures: i64,
    /// Message from the most recent failure.
    pub last_error: String,
}

static FAILURES: AtomicU64 = AtomicU64::new(0);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn record_failure(error: &str) {
    FAILURES.fetch_add(1, Ordering::Relaxed);
    // A poisoned lock only means a previous writer panicked mid-update; the
    // stored message is still safe to replace, so recover rather than
    // propagate a panic out of a best-effort reporting path.
    let mut last = LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *last = Some(error.to_string());
}

/// `None` when every usage write so far has succeeded.
pub fn snapshot() -> Option<UsageRecordingIssue> {
    let failures = FAILURES.load(Ordering::Relaxed);
    if failures == 0 {
        return None;
    }
    let last_error = LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| "unknown error".to_string());
    Some(UsageRecordingIssue {
        failures: i64::try_from(failures).unwrap_or(i64::MAX),
        last_error,
    })
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    FAILURES.store(0, Ordering::Relaxed);
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::{record_failure, reset_for_test, snapshot};

    // These tests share process-global state, so they are serialized behind one
    // `#[test]` rather than racing each other across the test harness threads.
    #[test]
    fn counts_and_reports_failures() {
        reset_for_test();
        assert!(snapshot().is_none(), "clean start reports no issue");

        record_failure("disk full");
        let issue = snapshot().expect("a failure must be reported");
        assert_eq!(issue.failures, 1);
        assert_eq!(issue.last_error, "disk full");

        record_failure("database is locked");
        let issue = snapshot().expect("failures accumulate");
        assert_eq!(issue.failures, 2);
        assert_eq!(
            issue.last_error, "database is locked",
            "the most recent error wins"
        );

        reset_for_test();
        assert!(snapshot().is_none());
    }
}
