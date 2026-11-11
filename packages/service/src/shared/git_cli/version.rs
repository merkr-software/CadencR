//! The installed Git's version, detected once and cached.
//!
//! The service supports any Git from 2.25 on (Ubuntu 22.04 ships 2.34). Each
//! newer feature it uses is a [`GitFeature`] naming the release that brought
//! it: call sites ask [`supports`] to pick a compatible fallback, or
//! [`require`] when there is none, so an old Git yields an error naming both
//! versions instead of Git's own `unknown option`.

use std::sync::OnceLock;

use axum::http::StatusCode;
use cli_discovery::{parse_version_string, VersionKey};
use tracing::{info, warn};

use crate::error::AppError;

/// A Git feature newer than the oldest Git the service supports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitFeature {
    /// `git merge-tree --write-tree`: the merge-conflict preview. No fallback
    /// gives the same answer without touching a worktree.
    MergeTreeWriteTree,
    /// `git worktree list --porcelain -z`. Fallback: newline-separated
    /// records, which only a worktree path holding a newline breaks.
    WorktreeListNul,
    /// `--diff-merges=first-parent`. Fallback: `diff-tree` gets the first
    /// parent as its other tree; the commit graph drops its merge-commit stats.
    DiffMerges,
}

impl GitFeature {
    pub const ALL: [GitFeature; 3] = [
        GitFeature::MergeTreeWriteTree,
        GitFeature::WorktreeListNul,
        GitFeature::DiffMerges,
    ];

    pub fn minimum(self) -> VersionKey {
        match self {
            GitFeature::MergeTreeWriteTree => VersionKey(2, 38, 0),
            GitFeature::WorktreeListNul => VersionKey(2, 36, 0),
            GitFeature::DiffMerges => VersionKey(2, 31, 0),
        }
    }

    /// What the user loses without it.
    pub fn label(self) -> &'static str {
        match self {
            GitFeature::MergeTreeWriteTree => "Merge conflict preview",
            GitFeature::WorktreeListNul => "Worktree paths containing line breaks",
            GitFeature::DiffMerges => "File counts of merge commits in the commit graph",
        }
    }

    pub fn supported_by(self, version: VersionKey) -> bool {
        version >= self.minimum()
    }
}

static DETECTED: OnceLock<Result<VersionKey, String>> = OnceLock::new();

/// Detect the installed Git (blocking; once per process). Startup calls it
/// off the runtime; later calls return the cached result.
pub fn detect() -> &'static Result<VersionKey, String> {
    DETECTED.get_or_init(|| {
        let detected = probe(super::git_std_command());
        log_detection(&detected);
        detected
    })
}

fn probe(mut command: std::process::Command) -> Result<VersionKey, String> {
    let output = command
        .arg("--version")
        .output()
        .map_err(|error| format!("Git could not be started: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!(
            "`git --version` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_version_string(&stdout)
        .ok_or_else(|| format!("unrecognized `git --version` output: {}", stdout.trim()))
}

fn log_detection(detected: &Result<VersionKey, String>) {
    match detected {
        Ok(version) => {
            let missing = unsupported(*version);
            if missing.is_empty() {
                info!(version = %version.to_string_dotted(), "git detected");
            } else {
                let missing = missing
                    .iter()
                    .map(|feature| {
                        format!(
                            "{} (Git {})",
                            feature.label(),
                            feature.minimum().to_string_dotted()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                warn!(version = %version.to_string_dotted(), %missing, "git is older than some features need");
            }
        }
        Err(error) => warn!(%error, "git version unknown"),
    }
}

/// The installed version; `None` when Git is missing or unreadable.
pub fn installed() -> Option<VersionKey> {
    detect().as_ref().ok().copied()
}

/// The features `version` lacks.
pub fn unsupported(version: VersionKey) -> Vec<GitFeature> {
    GitFeature::ALL
        .into_iter()
        .filter(|feature| !feature.supported_by(version))
        .collect()
}

/// The version startup detected, without waiting for or running detection:
/// request paths must never block on a `git --version`.
fn detected() -> Option<VersionKey> {
    DETECTED
        .get()
        .and_then(|detected| detected.as_ref().ok().copied())
}

/// Whether the installed Git has `feature`. An unknown version (missing Git,
/// or a request served before startup detection ends) counts as supporting
/// it: the command then reports its own failure.
pub fn supports(feature: GitFeature) -> bool {
    detected().is_none_or(|version| feature.supported_by(version))
}

/// Refuse a flow `feature` has no fallback for, naming both versions.
#[track_caller]
pub fn require(feature: GitFeature) -> Result<(), AppError> {
    check(feature, detected())
}

#[track_caller]
fn check(feature: GitFeature, installed: Option<VersionKey>) -> Result<(), AppError> {
    match installed {
        Some(version) if !feature.supported_by(version) => Err(AppError::coded(
            StatusCode::CONFLICT,
            "GIT_VERSION_UNSUPPORTED",
            format!(
                "{} needs Git {} or later; the installed Git is {}. Update Git to use it.",
                feature.label(),
                feature.minimum().to_string_dotted(),
                version.to_string_dotted()
            ),
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `git` that only answers `--version`, the way an old distribution
    /// Git would.
    /// Run through `sh -c` rather than a freshly written executable, which
    /// Linux may refuse with ETXTBSY while another test forks.
    fn fake_git(script: &str) -> std::process::Command {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn detects_distribution_and_vendor_version_strings() {
        let ubuntu = fake_git("echo 'git version 2.34.1'");
        assert_eq!(probe(ubuntu), Ok(VersionKey(2, 34, 1)));
        let apple = fake_git("echo 'git version 2.39.5 (Apple Git-154)'");
        assert_eq!(probe(apple), Ok(VersionKey(2, 39, 5)));
    }

    #[test]
    fn a_broken_or_missing_git_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let broken = fake_git("echo boom >&2; exit 1");
        assert_eq!(probe(broken), Err("`git --version` failed: boom".into()));
        let missing = std::process::Command::new(dir.path().join("no-git"));
        assert!(probe(missing)
            .unwrap_err()
            .starts_with("Git could not be started"));
    }

    #[test]
    fn the_real_git_is_detected() {
        assert!(installed().is_some(), "{:?}", detect());
        assert_eq!(detected(), installed(), "gating reads the cached result");
    }

    #[test]
    fn ubuntu_2204_git_lacks_the_two_newest_features() {
        let ubuntu = VersionKey(2, 34, 1);
        assert_eq!(
            unsupported(ubuntu),
            vec![GitFeature::MergeTreeWriteTree, GitFeature::WorktreeListNul]
        );
        assert!(unsupported(VersionKey(2, 38, 0)).is_empty());
        assert_eq!(unsupported(VersionKey(2, 25, 1)), GitFeature::ALL.to_vec());
    }

    #[test]
    fn a_required_feature_names_both_versions() {
        let error = check(GitFeature::MergeTreeWriteTree, Some(VersionKey(2, 34, 1))).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Merge conflict preview needs Git 2.38.0 or later; the installed Git is 2.34.1. \
             Update Git to use it."
        );
        assert!(check(GitFeature::MergeTreeWriteTree, Some(VersionKey(2, 38, 0))).is_ok());
        assert!(check(GitFeature::MergeTreeWriteTree, None).is_ok());
    }
}
