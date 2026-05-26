use std::path::Path;
use tokio::process::Command;

use crate::error::AppError;

/// Run a git command with the given arguments in the specified working directory.
///
/// Prefer `run_git_safe` / `run_git_safe_refs` for new code — those validate
/// user-controlled positionals against flag-prefix injection. This raw variant
/// remains for call sites that compose fully static arg lists.
pub async fn run_git(args: &[&str], cwd: &Path) -> Result<String, AppError> {
    run_raw(args, cwd).await
}

/// Run a git command that operates on paths. Validates that no positional
/// starts with `-` (which would be parsed as a flag) and inserts `--` between
/// flags and positionals so the tokens cannot be reinterpreted as options.
///
/// Layout: `git <subcommand_args>... <flags>... -- <positionals>...`
///
/// Use for subcommands whose trailing positionals are file paths: `diff`,
/// `blame`, `log -- <path>`, `checkout -- <path>` (file-checkout form), etc.
pub async fn run_git_safe(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
) -> Result<String, AppError> {
    validate_positionals(positionals)?;
    let mut args: Vec<&str> =
        Vec::with_capacity(subcommand_args.len() + flags.len() + positionals.len() + 1);
    args.extend_from_slice(subcommand_args);
    args.extend_from_slice(flags);
    args.push("--");
    args.extend_from_slice(positionals);
    run_raw(&args, cwd).await
}

/// Run a git command whose positionals are refs (branches, SHAs) rather than
/// file paths — `--` changes the meaning of these subcommands (e.g.
/// `git checkout -- foo` treats `foo` as a path, not a branch). We only
/// validate that positionals do not start with `-`.
///
/// Layout: `git <subcommand_args>... <flags>... <positionals>...`
pub async fn run_git_safe_refs(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
) -> Result<String, AppError> {
    validate_positionals(positionals)?;
    let mut args: Vec<&str> =
        Vec::with_capacity(subcommand_args.len() + flags.len() + positionals.len());
    args.extend_from_slice(subcommand_args);
    args.extend_from_slice(flags);
    args.extend_from_slice(positionals);
    run_raw(&args, cwd).await
}

fn validate_positionals(positionals: &[&str]) -> Result<(), AppError> {
    for p in positionals {
        if p.starts_with('-') {
            return Err(AppError::BadRequest(format!(
                "refusing to pass flag-prefixed value to git: {p:?}"
            )));
        }
    }
    Ok(())
}

/// Validate user-controlled positionals for flag-prefix injection. Use in
/// call sites that need to keep their existing `Command` setup (e.g. to
/// inspect non-zero exit codes as first-class outcomes rather than errors).
pub fn guard_positionals(positionals: &[&str]) -> Result<(), AppError> {
    validate_positionals(positionals)
}

/// Spawn `git` with `args` in `cwd`. Returns stdout on success; on failure
/// returns a `GitCommandError` with the (sanitized) stderr.
///
/// We do NOT pass `--no-optional-locks` per call here. Instead, the service
/// exports `GIT_OPTIONAL_LOCKS=0` once at startup (see
/// `crate::shared::git_env`) so every git child — including this function,
/// `run_git_capture`, the PTY commands in
/// `domain::git::commands::pty_spawn`, and any ad-hoc `Command::new("git")`
/// elsewhere — inherits the same defensive setting. That avoids racing a
/// user-initiated `git rebase` for `.git/index.lock` when the watcher fires
/// `git status` mid-rebase.
async fn run_raw(args: &[&str], cwd: &Path) -> Result<String, AppError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| AppError::GitCommandError(format!("Failed to spawn git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let sanitized = sanitize_git_stderr(stderr.trim());
        return Err(AppError::GitCommandError(format!(
            "git {} failed: {}",
            args.join(" "),
            sanitized
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout)
}

/// Run a git command and return the **raw** stderr verbatim on failure
/// (only the home-dir prefix is stripped to avoid leaking the user's
/// real path). Intended for user-facing operations like commit and push
/// where the original git error message is the actionable signal —
/// `error-handling.md` forbids dropping it. Validates positionals against
/// flag-prefix injection.
///
/// Layout: `git <subcommand_args>... <flags>... <positionals>...`
pub async fn run_git_capture(
    subcommand_args: &[&str],
    flags: &[&str],
    positionals: &[&str],
    cwd: &Path,
) -> Result<String, AppError> {
    validate_positionals(positionals)?;
    let mut args: Vec<&str> =
        Vec::with_capacity(subcommand_args.len() + flags.len() + positionals.len());
    args.extend_from_slice(subcommand_args);
    args.extend_from_slice(flags);
    args.extend_from_slice(positionals);

    let output = Command::new("git")
        .args(&args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| AppError::GitCommandError(format!("Failed to spawn git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let scrubbed = scrub_home_prefix(stderr.trim());
        return Err(AppError::GitCommandError(scrubbed));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Replace the user's home directory with `~` so we don't leak the real
/// filesystem layout, but otherwise preserve git's verbatim message.
fn scrub_home_prefix(s: &str) -> String {
    let Some(home) = dirs::home_dir() else {
        return s.to_string();
    };
    let home_str = home.to_string_lossy();
    if home_str.is_empty() {
        return s.to_string();
    }
    s.replace(home_str.as_ref(), "~")
}

/// Strip absolute paths and truncate stderr to avoid leaking filesystem info.
fn sanitize_git_stderr(stderr: &str) -> String {
    use regex_lite::Regex;
    static PATH_RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(/[a-zA-Z0-9_.~\-]+){2,}").unwrap());
    let cleaned = PATH_RE.replace_all(stderr, "<path>");
    if cleaned.len() > 200 {
        format!("{}…", &cleaned[..200])
    } else {
        cleaned.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[tokio::test]
    async fn run_git_safe_rejects_flag_positional() {
        let err = run_git_safe(&["log"], &[], &["--upload-pack=evil"], &temp_dir())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[tokio::test]
    async fn run_git_safe_refs_rejects_flag_positional() {
        let err = run_git_safe_refs(
            &["merge"],
            &["--no-ff"],
            &["--exec=curl attacker"],
            &temp_dir(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[tokio::test]
    async fn run_git_capture_rejects_flag_positional() {
        let err = run_git_capture(&["log"], &[], &["--upload-pack=evil"], &temp_dir())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn scrub_home_prefix_replaces_home_dir() {
        let home = dirs::home_dir().unwrap();
        let home_str = home.to_string_lossy();
        let input = format!("error in {home_str}/repo/foo");
        let out = scrub_home_prefix(&input);
        assert!(out.starts_with("error in ~/"), "{out}");
        assert!(!out.contains(home_str.as_ref()), "{out}");
    }

    /// Regression test for the `git rebase` vs. watcher `index.lock` race.
    ///
    /// Default-on `git status` writes `.git/index` and briefly takes
    /// `.git/index.lock` to do so. To prove our `GIT_OPTIONAL_LOCKS=0`
    /// startup default actually prevents that, we:
    ///   1. set up a tiny repo,
    ///   2. drop a sentinel `.git/index.lock` file (simulating a rebase /
    ///      commit in flight),
    ///   3. invoke `run_git(["status", "--porcelain=v2"], ...)` with the
    ///      env var set, and assert it succeeds.
    ///
    /// Without `GIT_OPTIONAL_LOCKS=0`, this call typically fails with
    /// `Unable to create '.git/index.lock': File exists` because git tries
    /// to refresh the index. With the var set, git skips the optional
    /// lock-take and the status read goes through.
    #[tokio::test]
    async fn run_git_status_does_not_race_existing_index_lock() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();

        // Minimal repo: init, identity, one commit so `git status -b` has a
        // HEAD to report on.
        for args in [
            ["init", "-q", "-b", "main"].as_slice(),
            &["config", "user.email", "t@t"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            let st = std::process::Command::new("git")
                .args(args.iter().copied())
                .current_dir(repo)
                .status()
                .expect("git spawn");
            assert!(st.success(), "git {args:?} failed");
        }
        std::fs::write(repo.join("seed.txt"), "seed\n").unwrap();
        for args in [
            ["add", "seed.txt"].as_slice(),
            &["commit", "-q", "-m", "seed"],
        ] {
            let st = std::process::Command::new("git")
                .args(args.iter().copied())
                .current_dir(repo)
                .status()
                .expect("git spawn");
            assert!(st.success(), "git {args:?} failed");
        }

        // Plant a sentinel index.lock — the same file `git rebase` would be
        // holding mid-pick.
        let lock_path = repo.join(".git").join("index.lock");
        std::fs::write(&lock_path, b"").unwrap();

        // Mirror the production startup: export GIT_OPTIONAL_LOCKS=0 before
        // spawning. Without this, git refuses because index.lock exists.
        std::env::set_var("GIT_OPTIONAL_LOCKS", "0");

        let result = run_git(&["status", "--porcelain=v2", "-b"], repo).await;

        // Clean up the env regardless of outcome to keep the test isolated.
        std::env::remove_var("GIT_OPTIONAL_LOCKS");
        let _ = std::fs::remove_file(&lock_path);

        assert!(
            result.is_ok(),
            "`git status` must not race a held index.lock when \
             GIT_OPTIONAL_LOCKS=0 is exported; got: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn run_git_safe_accepts_benign_positional() {
        // Validation runs before spawn; we only care that validation itself
        // passes. Use a non-existent cwd so git fails fast after validation.
        let cwd = temp_dir().join("cadencr-no-such-dir-git-safe");
        let err = run_git_safe(&["log"], &[], &["foo/bar.txt"], &cwd)
            .await
            .unwrap_err();
        // Must NOT be BadRequest from our validator.
        match err {
            AppError::BadRequest(_) => panic!("validation should pass for non-flag positional"),
            _ => {}
        }
    }
}
