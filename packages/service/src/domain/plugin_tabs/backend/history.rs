//! What one tab's backend did in one conversation, across restarts: its
//! stderr tail, its last exit and recent crashes (for crash-loop protection).

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};

use super::models::{PluginTabBackendState, PluginTabBackendStatus};
use crate::error::AppError;

/// Lines of stderr kept per backend.
pub const STDERR_TAIL_LINES: usize = 200;
/// Characters kept of one stderr line.
const MAX_STDERR_LINE_CHARS: usize = 2000;
/// Crashes within [`CRASH_WINDOW`] after which Cadencr stops restarting it.
pub const MAX_CRASHES: usize = 3;
pub const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// Refused starts (nothing spawned: tampered, not native, policy
/// unavailable, …) within [`CRASH_WINDOW`] after which no start is
/// attempted until the oldest ages out of the window: each attempt re-hashes
/// the binary, so a page retrying a refused backend must not do it forever.
pub const MAX_FAILED_STARTS: usize = 3;

#[derive(Debug, Clone)]
pub(super) struct ExitRecord {
    pub code: Option<i32>,
    pub reason: String,
    pub crashed: bool,
}

#[derive(Default)]
struct State {
    stderr: VecDeque<String>,
    starts: u32,
    started_at: Option<String>,
    exited_at: Option<String>,
    last_exit: Option<ExitRecord>,
    crashes: VecDeque<Instant>,
    /// Tripped by a crash loop; only [`History::reset_crashes`] clears it.
    blocked: bool,
    /// Why a run's handshake named the wrong protocol: deterministic, so no
    /// run starts until [`History::reset_crashes`].
    refused: Option<String>,
    /// Starts refused before anything was spawned, and the last one's
    /// reason — kept until a run starts, so the Activity can say why.
    failed_starts: VecDeque<Instant>,
    last_failed_start: Option<String>,
}

/// The run live right now, as its status shows it.
#[derive(Debug, Clone, Copy)]
pub(super) struct LiveRun {
    pub pid: u32,
    /// Still in its `ready` handshake.
    pub starting: bool,
}

/// Within [`CRASH_WINDOW`] of now.
fn recent(at: &Instant) -> bool {
    at.elapsed() <= CRASH_WINDOW
}

/// Drop the times that aged out of [`CRASH_WINDOW`] (they are in order).
fn age_out(times: &mut VecDeque<Instant>) {
    while times.front().is_some_and(|at| !recent(at)) {
        times.pop_front();
    }
}

impl State {
    /// Forget what aged out of the window; a crash loop still in it trips
    /// [`State::blocked`] for good.
    fn age(&mut self) {
        age_out(&mut self.crashes);
        age_out(&mut self.failed_starts);
        if self.crashes.len() >= MAX_CRASHES {
            self.blocked = true;
        }
    }

    /// Why no run may start now (see [`History::check_may_start`]), without
    /// ageing anything out: [`State::age`] does that.
    fn hold(&self) -> Option<AppError> {
        let count = |times: &VecDeque<Instant>| times.iter().filter(|at| recent(at)).count();
        if let Some(reason) = &self.refused {
            return Some(AppError::coded(
                StatusCode::BAD_GATEWAY,
                "PLUGIN_BACKEND_PROTOCOL_MISMATCH",
                format!("{reason}; fix the backend, then restart it from the tab's Activity"),
            ));
        }
        if self.blocked || count(&self.crashes) >= MAX_CRASHES {
            let reason = self
                .last_exit
                .as_ref()
                .map_or_else(String::new, |exit| format!(" (last: {})", exit.reason));
            return Some(AppError::coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "PLUGIN_BACKEND_CRASHING",
                format!(
                    "the tab's backend crashed {MAX_CRASHES} times in a minute{reason}; restart it from the tab's Activity"
                ),
            ));
        }
        // Why it could not start is in the Activity (its headline and log):
        // repeating it here would make every toast quote it again.
        (count(&self.failed_starts) >= MAX_FAILED_STARTS).then(|| {
            AppError::coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "PLUGIN_BACKEND_START_FAILING",
                format!(
                    "the tab's backend could not start {MAX_FAILED_STARTS} times in a minute; the tab's Activity says why"
                ),
            )
        })
    }
}

#[derive(Default)]
pub(super) struct History {
    state: Mutex<State>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

impl History {
    pub fn push_stderr(&self, line: impl Into<String>) {
        let mut line: String = line.into();
        if line.chars().count() > MAX_STDERR_LINE_CHARS {
            line = line.chars().take(MAX_STDERR_LINE_CHARS).collect::<String>() + "…";
        }
        let mut state = self.lock();
        state.stderr.push_back(line);
        while state.stderr.len() > STDERR_TAIL_LINES {
            state.stderr.pop_front();
        }
    }

    /// A new run starts; returns its number, which its exit is recorded with.
    pub fn record_start(&self) -> u32 {
        let mut state = self.lock();
        state.starts += 1;
        state.started_at = Some(now());
        state.exited_at = None;
        state.last_exit = None;
        state.failed_starts.clear();
        state.last_failed_start = None;
        state.starts
    }

    /// A start was refused before anything was spawned: logged, and counted
    /// toward [`MAX_FAILED_STARTS`]. The caller still answers with `error`.
    pub fn record_failed_start(&self, error: &AppError) {
        self.push_stderr(format!("[cadencr] the backend could not start: {error}"));
        let mut state = self.lock();
        state.failed_starts.push_back(Instant::now());
        state.last_failed_start = Some(error.to_string());
    }

    /// Run `run` ended. A run replaced meanwhile (its permissions changed and
    /// a new one started) only leaves a log line: the status is the new run's.
    pub fn record_exit(&self, run: u32, exit: ExitRecord) {
        let mut state = self.lock();
        // A crash counts toward the crash loop even when a newer run already
        // replaced it: a page retrying a backend that never gets ready
        // otherwise restarts it forever.
        if exit.crashed {
            state.crashes.push_back(Instant::now());
        }
        if run != state.starts {
            drop(state);
            self.push_stderr(format!("[cadencr] the previous run ended: {}", exit.reason));
            return;
        }
        state.exited_at = Some(now());
        state.last_exit = Some(exit);
    }

    /// Forget recent crashes and a refused handshake: the user asked for a
    /// fresh start.
    pub fn reset_crashes(&self) {
        let mut state = self.lock();
        state.crashes.clear();
        state.blocked = false;
        state.refused = None;
        state.failed_starts.clear();
    }

    /// A run spoke another protocol: refuse to start the backend again (see
    /// [`History::check_may_start`]).
    pub fn refuse(&self, reason: String) {
        self.lock().refused = Some(reason);
    }

    /// Whether a new run may start. 502 `PLUGIN_BACKEND_PROTOCOL_MISMATCH`
    /// after a run named another protocol; 503 `PLUGIN_BACKEND_CRASHING`
    /// after [`MAX_CRASHES`] crashes within [`CRASH_WINDOW`]. Either holds
    /// until the Activity dialog's **Restart** clears it — the crashes ageing
    /// out of the window does not. 503 `PLUGIN_BACKEND_START_FAILING` after
    /// [`MAX_FAILED_STARTS`] refused starts within the window, until the
    /// oldest ages out or **Restart** clears them. The status tells all three
    /// as `restart_held`.
    pub fn check_may_start(&self) -> Result<(), AppError> {
        let mut state = self.lock();
        state.age();
        state.hold().map_or(Ok(()), Err)
    }

    /// The status, given the run live right now, if any.
    pub fn status(&self, live: Option<LiveRun>) -> PluginTabBackendStatus {
        let state = self.lock();
        let exit = state.last_exit.as_ref();
        let status = match (live, exit) {
            (Some(LiveRun { starting: true, .. }), _) => PluginTabBackendState::Starting,
            (Some(_), _) => PluginTabBackendState::Running,
            (None, Some(exit)) if exit.crashed => PluginTabBackendState::Crashed,
            (None, _) => PluginTabBackendState::Stopped,
        };
        PluginTabBackendStatus {
            state: status,
            restart_held: live.is_none() && state.hold().is_some(),
            start_error: state.last_failed_start.clone(),
            pid: live.map(|live| live.pid),
            started_at: state.started_at.clone(),
            exited_at: state.exited_at.clone(),
            exit_code: exit.and_then(|exit| exit.code),
            exit_reason: exit.map(|exit| exit.reason.clone()),
            starts: state.starts,
            stderr_tail: state.stderr.iter().cloned().collect(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // Every update is a few field writes; a panic mid-way leaves a
        // readable state.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(pid: u32, starting: bool) -> LiveRun {
        LiveRun { pid, starting }
    }

    fn crash() -> ExitRecord {
        ExitRecord {
            code: Some(1),
            reason: "exited with status 1".into(),
            crashed: true,
        }
    }

    #[test]
    fn crash_loops_stop_restarts_until_reset() {
        let history = History::default();
        for _ in 0..MAX_CRASHES - 1 {
            let run = history.record_start();
            history.record_exit(run, crash());
        }
        assert!(history.check_may_start().is_ok());
        let run = history.record_start();
        history.record_exit(run, crash());
        let error = history.check_may_start().unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: "PLUGIN_BACKEND_CRASHING",
                ..
            }
        ));
        // The crashes ageing out of the window does not lift the block.
        let aged = Instant::now()
            .checked_sub(CRASH_WINDOW + Duration::from_secs(1))
            .expect("the clock is past the window");
        history.lock().crashes.iter_mut().for_each(|at| *at = aged);
        assert!(history.check_may_start().is_err());
        history.reset_crashes();
        assert!(history.check_may_start().is_ok());
    }

    #[test]
    fn refused_starts_are_rate_limited_until_they_age_out_or_reset() {
        let history = History::default();
        let refusal = || {
            AppError::coded(
                StatusCode::CONFLICT,
                "PLUGIN_BACKEND_TAMPERED",
                "differs from its signed package",
            )
        };
        for _ in 0..MAX_FAILED_STARTS {
            assert!(history.check_may_start().is_ok());
            history.record_failed_start(&refusal());
        }
        let error = history.check_may_start().unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: "PLUGIN_BACKEND_START_FAILING",
                ..
            }
        ));
        // The toast stays short: the reason is the Activity's to tell.
        assert!(!error.to_string().contains("signed package"), "{error}");
        let status = history.status(None);
        assert_eq!(status.stderr_tail.len(), MAX_FAILED_STARTS);
        assert!(status.restart_held, "{status:?}");
        assert_eq!(status.state, PluginTabBackendState::Stopped);
        assert!(
            status
                .start_error
                .as_deref()
                .is_some_and(|reason| reason.contains("signed package")),
            "{status:?}"
        );
        // Unlike a crash loop, refusals age out of the window.
        let aged = Instant::now()
            .checked_sub(CRASH_WINDOW + Duration::from_secs(1))
            .expect("the clock is past the window");
        history.lock().failed_starts[0] = aged;
        assert!(!history.status(None).restart_held, "the hold ages out");
        assert!(history.check_may_start().is_ok());
        history.record_failed_start(&refusal());
        assert!(history.check_may_start().is_err());
        history.reset_crashes();
        assert!(history.check_may_start().is_ok());
        // A start that spawned forgets them.
        for _ in 0..MAX_FAILED_STARTS {
            history.record_failed_start(&refusal());
        }
        history.record_start();
        assert!(history.check_may_start().is_ok());
        let status = history.status(Some(live(7, false)));
        assert_eq!((status.restart_held, status.start_error), (false, None));
    }

    #[test]
    fn the_status_says_when_starts_are_held_until_a_restart_is_allowed() {
        let mismatch = History::default();
        mismatch.refuse("the tab's backend speaks protocol 2".into());
        let crashing = History::default();
        for _ in 0..MAX_CRASHES {
            let run = crashing.record_start();
            crashing.record_exit(run, crash());
        }
        let once = History::default();
        let run = once.record_start();
        once.record_exit(run, crash());
        for (history, held) in [(&mismatch, true), (&crashing, true), (&once, false)] {
            assert_eq!(history.status(None).restart_held, held);
            history.reset_crashes();
            assert!(!history.status(None).restart_held);
        }
    }

    #[test]
    fn a_protocol_mismatch_blocks_starts_until_reset() {
        let history = History::default();
        history.refuse("the tab's backend speaks protocol 2".into());
        let error = history.check_may_start().unwrap_err();
        assert!(error.to_string().contains("speaks protocol 2"), "{error}");
        assert!(matches!(
            error,
            AppError::Coded {
                code: "PLUGIN_BACKEND_PROTOCOL_MISMATCH",
                ..
            }
        ));
        history.reset_crashes();
        assert!(history.check_may_start().is_ok());
    }

    #[test]
    fn status_reflects_the_last_run_and_keeps_a_bounded_tail() {
        let history = History::default();
        assert_eq!(history.status(None).state, PluginTabBackendState::Stopped);
        let run = history.record_start();
        assert_eq!(
            history.status(Some(live(42, true))).state,
            PluginTabBackendState::Starting
        );
        assert_eq!(
            history.status(Some(live(42, false))).state,
            PluginTabBackendState::Running
        );
        history.record_exit(run, crash());
        let status = history.status(None);
        assert_eq!(status.state, PluginTabBackendState::Crashed);
        assert_eq!((status.exit_code, status.starts), (Some(1), 1));
        for n in 0..STDERR_TAIL_LINES + 3 {
            history.push_stderr(format!("line {n}"));
        }
        history.push_stderr("x".repeat(MAX_STDERR_LINE_CHARS + 10));
        let tail = history.status(None).stderr_tail;
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert_eq!(tail[0], "line 4");
        assert!(tail.last().unwrap().ends_with('…'));
    }

    #[test]
    fn a_replaced_run_does_not_overwrite_the_live_one() {
        let history = History::default();
        let old = history.record_start();
        history.record_start();
        let stopped = ExitRecord {
            code: Some(0),
            reason: "its permissions changed".into(),
            crashed: false,
        };
        history.record_exit(old, stopped);
        let status = history.status(Some(live(7, false)));
        assert_eq!(status.state, PluginTabBackendState::Running);
        assert_eq!((status.exited_at, status.exit_reason), (None, None));
        assert_eq!(
            status.stderr_tail,
            ["[cadencr] the previous run ended: its permissions changed"]
        );
    }

    #[test]
    fn crashes_of_replaced_runs_still_count_toward_the_crash_loop() {
        let history = History::default();
        for _ in 0..MAX_CRASHES {
            let failed = history.record_start();
            // A retry started the next run before this one's exit was recorded.
            history.record_start();
            history.record_exit(failed, crash());
        }
        assert!(matches!(
            history.check_may_start(),
            Err(AppError::Coded {
                code: "PLUGIN_BACKEND_CRASHING",
                ..
            })
        ));
    }
}
