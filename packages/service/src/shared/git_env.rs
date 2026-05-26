//! Process-wide environment defaults for child `git` invocations.
//!
//! Call `set_global_defaults()` once at startup, after
//! `login_env::hydrate_from_login_shell`. Every subsequent
//! `Command::new("git")` — including the watcher's `git status`, the PTY
//! commands in `domain::git::commands::pty_spawn`, and any ad-hoc
//! `Command::new("git")` elsewhere in the service — then inherits the
//! defaults set here.
//!
//! ## `GIT_OPTIONAL_LOCKS=0`
//!
//! Default-on `git status` writes `.git/index` to refresh its stat cache,
//! and to do so it briefly creates `.git/index.lock`. When the user runs a
//! concurrent `git rebase` (or any other indexing operation) inside a
//! watched worktree, that user-initiated git invocation races our watcher's
//! `git status` for the same lock file and aborts with:
//!
//! ```text
//! Unable to create '.git/worktrees/<branch>/index.lock': File exists
//! ```
//!
//! Setting `GIT_OPTIONAL_LOCKS=0` (the documented escape hatch — see
//! `git --no-optional-locks`) tells git to skip optional lock-taking
//! operations. The stat cache stays slightly stale, which is the same
//! trade-off VS Code, JetBrains, GitHub Desktop, and lazygit all make for
//! the exact same reason. Required locks (commit, push, rebase, fetch,
//! merge) are unaffected.

/// Set process-wide env defaults that every spawned `git` child inherits.
/// Idempotent and override-respecting: if a var is already set (by the
/// user, by CI, by a launcher), we leave it alone.
pub fn set_global_defaults() {
    set_if_unset("GIT_OPTIONAL_LOCKS", "0");
}

fn set_if_unset(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        // Called once from main, before any subprocesses spawn.
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The process env is shared by every test in the binary, so each test
    // here uses a uniquely-named var to avoid stepping on its neighbors.

    #[test]
    fn set_if_unset_sets_when_missing() {
        let key = "CADENCR_TEST_GIT_ENV_UNSET";
        std::env::remove_var(key);
        set_if_unset(key, "0");
        assert_eq!(std::env::var(key).ok().as_deref(), Some("0"));
        std::env::remove_var(key);
    }

    #[test]
    fn set_if_unset_respects_existing_value() {
        let key = "CADENCR_TEST_GIT_ENV_OVERRIDE";
        std::env::set_var(key, "1");
        set_if_unset(key, "0");
        assert_eq!(
            std::env::var(key).ok().as_deref(),
            Some("1"),
            "an existing value (user/CI override) must not be clobbered"
        );
        std::env::remove_var(key);
    }

    #[test]
    fn set_global_defaults_exports_optional_locks() {
        // Force-reset so the assertion is meaningful even if a parent
        // process already exported the var.
        std::env::remove_var("GIT_OPTIONAL_LOCKS");
        set_global_defaults();
        assert_eq!(
            std::env::var("GIT_OPTIONAL_LOCKS").ok().as_deref(),
            Some("0"),
            "set_global_defaults must export GIT_OPTIONAL_LOCKS=0 when unset"
        );
        std::env::remove_var("GIT_OPTIONAL_LOCKS");
    }
}
