//! What the startup pass did, published once per service process.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::watch;
use utoipa::ToSchema;

/// A client that connects later than this after the pass finished gets no
/// report: "3 agents were restarted" an hour later is noise, not information.
const FRESH_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RestartContinuationOutcome {
    /// A resume prompt started a new turn.
    Resumed,
    /// A guard kept the conversation as it was; `reason` says which.
    Skipped,
    /// The resume prompt could not be delivered; `reason` holds the error.
    Failed,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RestartContinuationEntry {
    pub session_id: i64,
    pub feature_id: i64,
    pub project_id: i64,
    pub feature_title: String,
    pub outcome: RestartContinuationOutcome,
    /// Skip code (`disabled`, `no_resume_id`, `loop_guard`, `archived`,
    /// `already_running`), the delivery error, or — on a resumed entry —
    /// `lost_gate`: the agent was waiting on the user and will ask again.
    pub reason: Option<String>,
}

/// `app/restart_continuations` WebSocket payload.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RestartContinuationReport {
    /// Identifies this service process: a client shows each report once.
    pub boot_id: String,
    pub app_version: String,
    /// Version that was running when the turns were cut off, when it differs
    /// from `app_version` (an update, as opposed to a plain restart).
    pub previous_version: Option<String>,
    pub entries: Vec<RestartContinuationEntry>,
    /// Set when the pass itself could not run (e.g. the database was
    /// unreadable); entries may then be incomplete.
    pub error: Option<String>,
}

impl RestartContinuationReport {
    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.error.is_none()
    }
}

#[derive(Clone)]
pub struct PublishedReport {
    published_at: Instant,
    report: RestartContinuationReport,
}

static BOOT_ID: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
static REPORTS: LazyLock<watch::Sender<Option<PublishedReport>>> =
    LazyLock::new(|| watch::channel(None).0);

pub(super) fn boot_id() -> String {
    BOOT_ID.clone()
}

/// Make the report visible to current and future subscribers. An empty
/// report is not published: nothing was interrupted, there is nothing to say.
pub(super) fn publish(report: RestartContinuationReport) {
    if report.is_empty() {
        return;
    }
    REPORTS.send_replace(Some(PublishedReport {
        published_at: Instant::now(),
        report,
    }));
}

/// Changes to the published report (it changes at most once per process).
pub fn subscribe_reports() -> watch::Receiver<Option<PublishedReport>> {
    REPORTS.subscribe()
}

/// The report if it is still recent enough to show.
pub fn fresh_report(published: &Option<PublishedReport>) -> Option<RestartContinuationReport> {
    let published = published.as_ref()?;
    (published.published_at.elapsed() <= FRESH_FOR).then(|| published.report.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(entries: Vec<RestartContinuationEntry>) -> RestartContinuationReport {
        RestartContinuationReport {
            boot_id: boot_id(),
            app_version: "1.0.0".into(),
            previous_version: None,
            entries,
            error: None,
        }
    }

    #[test]
    fn an_empty_report_is_not_worth_publishing() {
        assert!(report(Vec::new()).is_empty());
        let mut failed = report(Vec::new());
        failed.error = Some("db".into());
        assert!(!failed.is_empty());
    }

    #[test]
    fn a_stale_report_is_not_shown() {
        let fresh = Some(PublishedReport {
            published_at: Instant::now(),
            report: report(Vec::new()),
        });
        assert!(fresh_report(&fresh).is_some());
        let Some(stale_at) = Instant::now().checked_sub(FRESH_FOR + Duration::from_secs(1)) else {
            return;
        };
        let stale = Some(PublishedReport {
            published_at: stale_at,
            report: report(Vec::new()),
        });
        assert!(fresh_report(&stale).is_none());
        assert!(fresh_report(&None).is_none());
    }

    #[test]
    fn outcomes_serialize_as_snake_case() {
        let value = serde_json::to_value(RestartContinuationOutcome::Resumed).unwrap();
        assert_eq!(value, "resumed");
    }
}
