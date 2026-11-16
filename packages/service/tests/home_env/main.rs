//! Tests that redirect `$HOME` (via `common::worktree::HomeGuard`) so worktrees
//! land under a tempdir. `$HOME` is process-wide: sharing a binary with
//! `tests/integration` would point concurrently running tests at a tempdir that
//! disappears under them, so these keep their own process. `HomeGuard`'s lock
//! serializes the redirects within this binary.

#[path = "../common/mod.rs"]
mod common;

mod feature_worktree;
mod git_workflow;
