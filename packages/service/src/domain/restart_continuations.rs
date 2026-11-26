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
//!    them. A conversation whose turn had ended but whose runtime still owed
//!    it a resume (background work, a scheduled wake-up: `background_work`)
//!    is captured the same way, since the restart kills that work too.
//!    Agent processes a hard kill left running are stopped first
//!    (`orphans`), so a resume never runs next to the turn it replaces.
//!    When the user quits, the desktop records it first (`routes`): the
//!    turns are still captured to close their transcripts, and stay stopped.
//!    That intent is kept until the
//!    next start (`quit_intent`), which applies it to whatever the quit failed
//!    to capture. A user's Stop ends any resume the conversation was owed.
//! 2. **Resume.** Once the listener is up, a startup pass marks each captured
//!    transcript as interrupted by a restart, clears the question or
//!    permission request the dead process can no longer receive an answer for
//!    (`gates`), and, when the guards allow it, sends the conversation a
//!    system-generated "continue" prompt.
//! 3. **Report.** The outcome of the pass is published once per process, so
//!    every client can tell the user which agents were restarted.
//!
//! Nothing here is provider-specific: it consumes the ordinary prompt path.

mod active_work;
mod background_work;
mod capture;
mod desktop_quit_journal;
mod dev_quit;
mod eligibility;
mod gates;
mod message;
mod orphans;
mod quit_intent;
mod report;
pub(crate) mod routes;
mod startup;
mod store;
mod transcript;
mod user_stop;

/// A live dev quit settles the same work a startup pass could be dispatching.
static LIVE_CONTINUATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
pub(crate) use background_work::record_background_work;
pub(crate) use background_work::write_background_work;
pub(crate) use capture::end_background_work;
pub use capture::{begin_shutdown, capture_cut_off_turn, is_shutting_down, recover_at_startup};
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(crate) use desktop_quit_journal::database_key;
pub(crate) use desktop_quit_journal::{finish_cold_quit, DesktopQuitJournal};
#[cfg(unix)]
pub(crate) use orphans::is_alive as process_is_alive;
pub use orphans::{forget as forget_agent_process, record as record_agent_process};
pub use report::{
    fresh_report, subscribe_reports, PublishedReport, RestartContinuationEntry,
    RestartContinuationOutcome, RestartContinuationReport,
};
pub use routes::loopback_router;
pub use startup::spawn_startup_pass;
pub(crate) use user_stop::{
    mark_running_after_stop, record_user_stop, settle_before_prompt, write_stop_marker,
    TurnHandoff, UserStop,
};

/// Workspace setting: resume interrupted agents after a restart (default on).
pub const ENABLED_SETTING_KEY: &str = "agent_restart_resume_enabled";

/// Content of the transcript marker that says a restart, not the user, ended
/// the turn. The frontend renders `turn_interrupted` rows by this content.
pub const RESTART_MARKER_CONTENT: &str = "restart";

/// Content of the marker for a conversation whose turn had ended, but whose
/// background work (or scheduled wake-up) a restart stopped.
pub const RESTART_BACKGROUND_MARKER_CONTENT: &str = "restart_background";

/// Content of the marker for a turn the user stopped by quitting Cadencr.
pub const QUIT_MARKER_CONTENT: &str = "quit";

/// Background work the user stopped by quitting Cadencr between turns.
pub const QUIT_BACKGROUND_MARKER_CONTENT: &str = "quit_background";
