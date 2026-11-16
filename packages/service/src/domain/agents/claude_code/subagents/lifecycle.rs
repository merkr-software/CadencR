//! How the task queue's lifecycle messages move a carrier: the patch a
//! `task_notification` or `task_updated` adds, and the phase it leaves.

use super::handback::is_waiting_report;
use super::task_events::{terminal_task_status, TaskUsage};
use super::{CarrierPhase, TaskEntry};
use crate::domain::agents::adapter::{
    summarize_subagent_result, RuntimeSubagentPatch, RuntimeSubagentStatus,
};

/// `task_notification`: the end of a task, foreground or background. For a
/// foreground agent the CLI's `summary` is just the description and its
/// totals are cruder than the tool result's, which wins when already seen.
pub(super) fn notification_patch(
    phase: &mut CarrierPhase,
    entry: &TaskEntry,
    label: &str,
    reason: Option<String>,
    summary: Option<String>,
    usage: Option<TaskUsage>,
) -> Option<RuntimeSubagentPatch> {
    let status = terminal_task_status(label)?;
    let first_end = *phase != CarrierPhase::Notified;
    let mut patch = match usage {
        Some(usage) if *phase != CarrierPhase::ResultSeen => usage.into_patch(),
        _ => RuntimeSubagentPatch::default(),
    };
    if status == RuntimeSubagentStatus::Completed
        && summary.as_deref().is_some_and(is_waiting_report)
    {
        // Not an end: it keeps running, past its turn, until the task notifies again.
        *phase = CarrierPhase::Live;
        patch.status = Some(RuntimeSubagentStatus::Running);
        patch.background = Some(true);
        return Some(patch);
    }
    *phase = CarrierPhase::Notified;
    let summary = summary
        .filter(|summary| {
            !entry
                .description
                .as_deref()
                .is_some_and(|d| same_words(d, summary))
        })
        .and_then(|summary| summarize_subagent_result(&summary));
    // An explicit reason always applies; a derived one only names the first
    // reported end, so the `killed` of a preceding `task_updated` survives
    // the notification's generic `stopped`.
    let derived = match status {
        RuntimeSubagentStatus::Completed | RuntimeSubagentStatus::Running => None,
        RuntimeSubagentStatus::Failed => summary.clone().or_else(|| Some(label.to_string())),
        RuntimeSubagentStatus::Stopped => Some(label.to_string()),
    };
    patch.status = Some(status);
    patch.status_reason = reason
        .filter(|_| status != RuntimeSubagentStatus::Completed)
        .or(derived.filter(|_| first_end));
    patch.result_summary = summary;
    Some(patch)
}

/// `task_updated`: a diff of the task's state. `killed` is how a stopped
/// agent ends; `paused` keeps it running. An agent waiting on its own
/// background work is marked `completed` here too; the notification that
/// follows says so and runs it again.
pub(super) fn updated_patch(
    phase: &mut CarrierPhase,
    status: Option<&str>,
    error: Option<String>,
    backgrounded: Option<bool>,
) -> RuntimeSubagentPatch {
    let mut patch = RuntimeSubagentPatch {
        background: backgrounded.filter(|backgrounded| *backgrounded),
        ..RuntimeSubagentPatch::default()
    };
    match status {
        Some("pending" | "running") => {
            if phase.resume() {
                patch.status = Some(RuntimeSubagentStatus::Running);
            }
        }
        Some(label) => {
            if let Some(terminal) = terminal_task_status(label) {
                *phase = CarrierPhase::Notified;
                patch.status = Some(terminal);
                patch.status_reason = match terminal {
                    RuntimeSubagentStatus::Completed => None,
                    _ => error.or_else(|| Some(label.to_string())),
                };
            }
        }
        None => {}
    }
    patch
}

fn same_words(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}
