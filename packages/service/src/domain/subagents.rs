//! Registry of the sub-agents each conversation launched.
//!
//! Every provider launches sub-agents through a dispatch tool call that its
//! adapter normalizes to a `Task`/`Agent` tool_use (the carrier). The stream
//! reader feeds each runtime event to a [`tracker::SubagentTracker`], which
//! derives provider-neutral facts from the carrier (launch, final result) and
//! collects the facts adapters attach as
//! [`RuntimeSubagentUpdate`](crate::domain::agents::adapter::RuntimeSubagentUpdate)s.
//! [`repository`] merges them into `agent_subagent_runs`; every change is
//! pushed to the feature's viewers as `session.subagent_updated`, and
//! [`routes`] lists a feature's runs, which the transcript's sub-agent cards
//! look up by carrier.

pub mod list;
pub mod model;
pub mod repository;
pub mod routes;
pub mod tracker;

pub use model::{SubagentRun, SubagentRunStatus};

/// Settle the runs the previous service left running: no sub-agent outlives
/// the service that ran it. Called once at startup.
pub async fn stop_runs_orphaned_by_restart(pool: &sqlx::SqlitePool) {
    match repository::stop_runs_orphaned_by_restart(pool).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "stopped sub-agents orphaned by restart"),
        Err(error) => tracing::warn!(%error, "failed to stop orphaned sub-agents"),
    }
}
