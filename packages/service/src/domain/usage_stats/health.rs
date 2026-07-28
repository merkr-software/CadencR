use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Provider usage data operations that failed, surfaced to the user.
///
/// Recording is awaited so writes preserve provider event order, but a stats
/// failure must never fail an agent turn. Failures are counted here and
/// reported on the next `/api/usage-stats` read instead of being swallowed.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageRecordingIssue {
    /// Failed provider usage operations seen since this service start.
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

/// Acknowledge every usage-data failure reported so far. A later failure warns
/// again.
pub fn acknowledge() {
    FAILURES.store(0, Ordering::Relaxed);
    *LAST_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// `None` when every provider usage operation in this run has succeeded.
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
mod tests {
    use super::{acknowledge, record_failure, snapshot};

    // The counters are process-global and the harness runs test functions in
    // parallel, so every scenario lives in one function.
    #[test]
    fn counts_reports_and_acknowledges_failures() {
        acknowledge();
        assert!(snapshot().is_none(), "clean start reports no issue");

        record_failure("disk full");
        let issue = snapshot().expect("a failure must be reported");
        assert_eq!(issue.failures, 1);
        assert_eq!(issue.last_error, "disk full");

        record_failure("database is locked");
        let issue = snapshot().expect("failures accumulate");
        assert_eq!(issue.failures, 2);
        assert_eq!(issue.last_error, "database is locked");

        acknowledge();
        assert!(snapshot().is_none(), "dismissing clears failures");

        record_failure("database is locked");
        assert_eq!(snapshot().expect("a new failure warns again").failures, 1);
        acknowledge();
    }
}
