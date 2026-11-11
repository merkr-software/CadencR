//! Per-worktree filesystem watcher driving real-time `git.status` envelopes.
//!
//! One `notify-debouncer-mini` watcher per canonicalized worktree path.
//! Multiple features may share a watcher when they reuse the same worktree;
//! the registry refcounts handles and tears them down on a 30-second grace
//! timer after the last unsubscribe.
//!
//! The registry lock only guards bookkeeping. Git runs under a per-repository
//! lock, so a repository whose Git hangs delays its own refreshes alone.
//!
//! ```text
//! fs event ─► path filter ─► debounce 250 ms ─► spawn compute_status
//!                                          ─► broadcast `git.status` envelope
//!                                             to every (feature_id, WsSender)
//!                                             registered against this worktree
//! ```
//!
//! Self-induced churn is suppressed by `confirm_after_write()`: it stamps a
//! 750 ms dedupe window, then synchronously emits one fresh status without
//! enqueueing another background recompute. Later fs events refresh normally.
//!
//! Per `error-handling.md`, compute failures are surfaced via a
//! `git.status_error` envelope rather than swallowed.

mod broadcast;
mod debouncer;
mod filter;
mod handle;
mod pending;
mod registry;
mod subscription;

pub use registry::GitWatcherRegistry;
pub use subscription::recompute_and_broadcast;
