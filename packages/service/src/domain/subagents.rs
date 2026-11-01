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

/// Tell a runtime about to start streaming which sub-agents earlier runtimes
/// of its conversation launched, so a run it resumes keeps its carrier.
pub async fn seed_runtime(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    runtime: &mut dyn crate::domain::agents::adapter::AgentRuntimeSession,
) -> Result<(), sqlx::Error> {
    let known = repository::known_subagents(pool, session_id).await?;
    if !known.is_empty() {
        runtime.seed_known_subagents(known);
    }
    Ok(())
}

/// Settle the runs the previous service left running: no sub-agent outlives
/// the service that ran it. Called once at startup.
pub async fn stop_runs_orphaned_by_restart(pool: &sqlx::SqlitePool) {
    match repository::stop_runs_orphaned_by_restart(pool).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "stopped sub-agents orphaned by restart"),
        Err(error) => tracing::warn!(%error, "failed to stop orphaned sub-agents"),
    }
}
