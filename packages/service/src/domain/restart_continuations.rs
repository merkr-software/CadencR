//! Resume the agent turns a service restart cut off.
//!
//! Agent CLIs are children of the service, so every restart — an app update,
//! a reinstalled local build, a `pnpm dev` rebuild, a crash — kills the turns
//! that were running. The conversations themselves survive (each provider
//! resumes from its own session id), so continuity is a bookkeeping problem:
//!
//! 1. **Capture.** When the service stops, every session still mid-turn gets a
//!    `pending` row. After a crash nothing ran at stop time, so the next start
//!    captures the sessions the dead process left `running` before resetting
//!    them.
//!    Agent processes a hard kill left running are stopped first
//!    (`orphans`), so a resume never runs next to the turn it replaces.
//!    When the user quits and chooses to stop their agents, the desktop says
//!    so first (`routes`): the turns are still captured, to close their
//!    transcripts, but marked to stay stopped.
//! 2. **Resume.** Once the listener is up, a startup pass marks each captured
//!    transcript as interrupted by a restart, clears the question or
//!    permission request the dead process can no longer receive an answer for
//!    (`gates`), and, when the guards allow it, sends the conversation a
//!    system-generated "continue" prompt.
//! 3. **Report.** The outcome of the pass is published once per process, so
//!    every client can tell the user which agents were restarted.
//!
//! Nothing here is provider-specific: it consumes the ordinary prompt path.

mod capture;
mod eligibility;
mod gates;
mod message;
mod orphans;
mod report;
mod routes;
mod startup;
mod store;
mod transcript;

pub use capture::{begin_shutdown, capture_cut_off_turn, is_shutting_down, recover_at_startup};
pub use orphans::{forget as forget_agent_process, record as record_agent_process};
pub use report::{
    fresh_report, subscribe_reports, PublishedReport, RestartContinuationEntry,
    RestartContinuationOutcome, RestartContinuationReport,
};
pub use routes::loopback_router;
pub use startup::spawn_startup_pass;

/// Workspace setting: resume interrupted agents after a restart (default on).
pub const ENABLED_SETTING_KEY: &str = "agent_restart_resume_enabled";

/// Content of the transcript marker that says a restart, not the user, ended
/// the turn. The frontend renders `turn_interrupted` rows by this content.
pub const RESTART_MARKER_CONTENT: &str = "restart";

/// Content of the marker for a turn the user stopped by quitting Cadencr.
pub const QUIT_MARKER_CONTENT: &str = "quit";
